import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { StructuredOutputError } from "@ai-hero/sandcastle";
import { InvalidVerificationResultError } from "../src/browserVerification.js";
import type { Config } from "../src/config.js";
import { createSandbox } from "../src/sandbox.js";
import { issue, passResult, reviewResult, testConfig, verificationResult } from "./support/fakes.js";

const stubs = vi.hoisted(() => ({ run: vi.fn(), docker: vi.fn() }));

vi.mock("@ai-hero/sandcastle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ai-hero/sandcastle")>()),
  run: stubs.run,
  claudeCode: vi.fn(() => "agent"),
  Output: { object: vi.fn((options) => options) },
}));
vi.mock("@ai-hero/sandcastle/sandboxes/docker", () => ({ docker: stubs.docker }));

describe("sandbox configuration adapter", () => {
  let root: string;
  let config: Config;

  beforeEach(() => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), "runner-adapter-"));
    const mergePath = join(root, "merge");
    mkdirSync(mergePath);
    writeFileSync(join(mergePath, "SKILL.md"), "merge instructions");
    config = {
      ...testConfig,
      globalClaudePath: join(root, "CLAUDE.md"),
      sandboxSkills: [{ name: "resolving-merge-conflicts", hostPath: mergePath, phases: ["merge"], dependencies: [] }],
    };
    writeFileSync(config.globalClaudePath, "global rules");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const request = () => ({ imageTag: "test", issue: issue({ number: 42 }), branch: "agent/42", baseRef: "origin/dev", signal: new AbortController().signal });

  function verificationConfig() {
    const skillPath = join(root, "verify-in-browser");
    mkdirSync(skillPath);
    writeFileSync(join(skillPath, "SKILL.md"), "verify");
    writeFileSync(join(skillPath, "result.schema.json"), readFileSync(new URL("./fixtures/browser-verification.schema.json", import.meta.url)));
    config.sandboxSkills.push({ name: "verify-in-browser", hostPath: skillPath, phases: ["verify"], dependencies: [] });
    return config;
  }

  it.each([
    { fixture: "verify-skill.jsonl", expected: true },
    { fixture: "without-verify-skill.jsonl", expected: false },
  ])("reads Skill invocation from the captured session $fixture", async ({ fixture, expected }) => {
    verificationConfig();
    const evidenceDir = join(root, "evidence");
    const report = verificationResult({ evidenceDir }).report;
    stubs.run.mockResolvedValue({ output: report, iterations: [{ sessionFilePath: new URL(`./fixtures/${fixture}`, import.meta.url).pathname }] });
    const result = await createSandbox(config, { CLAUDE_CODE_OAUTH_TOKEN: "fake-token" }).verify({ ...request(), evidenceDir });
    expect(result).toEqual({ report, skillInvoked: expected });
  });

  it.each(["missing", "invalid"])("classifies %s structured output as an invalid verification result", async (kind) => {
    verificationConfig();
    if (kind === "missing") stubs.run.mockResolvedValue({ output: undefined, iterations: [] });
    else stubs.run.mockRejectedValue(new StructuredOutputError("output retries exhausted", { tag: "result", rawMatched: "bad json", commits: [], branch: "agent/42" }));
    await expect(createSandbox(config, { CLAUDE_CODE_OAUTH_TOKEN: "fake-token" }).verify({ ...request(), evidenceDir: join(root, "evidence") })).rejects.toBeInstanceOf(InvalidVerificationResultError);
  });

  it.each(["passed-without-evidence", "failed-without-reason", "skipped-without-reason", "unverifiable-with-criteria", "unverifiable-without-reason", "verified-without-criteria", "too-many-inferred", "passed-with-reason", "verified-with-unverifiable-reason", "extra-field", "outside-evidence"])("rejects contradictory verification output: %s", async (kind) => {
    verificationConfig();
    const evidenceDir = join(root, "evidence");
    const report = verificationResult({ evidenceDir }).report;
    if (kind === "extra-field") Object.assign(report.verifier, { unexpected: true });
    if (kind === "outside-evidence") report.criteria[0]!.evidence = ["../auth.json"];
    if (kind === "passed-with-reason") report.criteria[0]!.reason = "不確定";
    if (kind === "verified-with-unverifiable-reason") report.unverifiableReason = "登入失敗";
    if (kind === "passed-without-evidence") report.criteria[0]!.evidence = [];
    if (kind === "failed-without-reason") report.criteria[0]!.status = "failed";
    if (kind === "skipped-without-reason") report.criteria[0]!.status = "skipped";
    if (kind === "unverifiable-with-criteria") {
      report.status = "unverifiable";
      report.unverifiableReason = "登入失敗";
    }
    if (kind === "unverifiable-without-reason") {
      report.status = "unverifiable";
      report.criteria = [];
    }
    if (kind === "verified-without-criteria") report.criteria = [];
    if (kind === "too-many-inferred") {
      report.criteriaSource = "inferred";
      report.criteria = Array.from({ length: 4 }, () => ({ ...report.criteria[0]! }));
    }
    stubs.run.mockImplementation(async (options: { output: { schema: StandardSchemaV1 } }) => {
      const parsed = await options.output.schema["~standard"].validate(report);
      if (parsed.issues) throw new StructuredOutputError("schema rejected", { tag: "result", rawMatched: JSON.stringify(report), commits: [], branch: "agent/42" });
      return { output: parsed.value, iterations: [] };
    });
    await expect(createSandbox(config, { CLAUDE_CODE_OAUTH_TOKEN: "fake-token" }).verify({ ...request(), evidenceDir })).rejects.toBeInstanceOf(InvalidVerificationResultError);
  });

  it.each(["verified", "unverifiable"] as const)("accepts consistent %s output through the SDK schema", async (status) => {
    verificationConfig();
    const evidenceDir = join(root, "evidence");
    const report = verificationResult({ evidenceDir, ...(status === "unverifiable" ? { status, unverifiableReason: "登入失敗", criteria: [] } : {}) }).report;
    stubs.run.mockImplementation(async (options: { output: { schema: StandardSchemaV1 } }) => {
      const parsed = await options.output.schema["~standard"].validate(report);
      if (parsed.issues) throw new StructuredOutputError("schema rejected", { tag: "result", rawMatched: JSON.stringify(report), commits: [], branch: "agent/42" });
      return { output: parsed.value, iterations: [] };
    });
    await expect(createSandbox(config, { CLAUDE_CODE_OAUTH_TOKEN: "fake-token" }).verify({ ...request(), evidenceDir })).resolves.toEqual({ report, skillInvoked: false });
  });

  it("passes readonly global rules to all runs and the merge skill only to merge", async () => {
    stubs.run.mockResolvedValueOnce({ output: passResult() }).mockResolvedValue({ output: reviewResult() });
    const sandbox = createSandbox(config, { CLAUDE_CODE_OAUTH_TOKEN: "fake-token" });
    await sandbox.implement(request());
    await sandbox.review(request());
    await sandbox.merge({ ...request(), source: "agent/43" });
    const mounts = stubs.docker.mock.calls.map(([options]) => options.mounts);
    for (const runMounts of mounts) {
      expect(runMounts).toContainEqual({ hostPath: config.globalClaudePath, sandboxPath: "/home/agent/.claude/CLAUDE.md", readonly: true });
    }
    expect(mounts.map((runMounts) => runMounts.some((mount: { sandboxPath: string }) => mount.sandboxPath.endsWith("/resolving-merge-conflicts")))).toEqual([false, false, true]);
  });

  it.each([false, true])("mounts evidence and cleans authentication files even when verification fails (%s)", async (fails) => {
    verificationConfig();
    const evidenceDir = join(root, "evidence");
    mkdirSync(join(evidenceDir, "nested", ".playwright-cli"), { recursive: true });
    writeFileSync(join(evidenceDir, "auth-E2E.json"), "secret");
    writeFileSync(join(evidenceDir, "nested", "auth-role.json"), "secret");
    writeFileSync(join(evidenceDir, "state.json"), "[]");
    writeFileSync(join(evidenceDir, "toast.png"), "evidence");
    if (fails) stubs.run.mockRejectedValue(new Error("verification failed"));
    else stubs.run.mockResolvedValue({ output: verificationResult({ evidenceDir }).report, iterations: [] });
    const result = createSandbox(config, { CLAUDE_CODE_OAUTH_TOKEN: "fake-token" }).verify({ ...request(), evidenceDir });
    if (fails) await expect(result).rejects.toThrow("verification failed");
    else await result;
    expect(stubs.docker.mock.calls[0]?.[0].mounts).toContainEqual({ hostPath: evidenceDir, sandboxPath: evidenceDir });
    expect(stubs.run.mock.calls[0]?.[0]).toMatchObject({
      promptFile: expect.stringContaining("prompts/verify.md"),
      promptArgs: { EVIDENCE_DIR: evidenceDir, VERIFIER_MODEL: testConfig.model },
      output: { maxRetries: 2 },
    });
    expect(existsSync(join(evidenceDir, "auth-E2E.json"))).toBe(false);
    expect(existsSync(join(evidenceDir, "nested", "auth-role.json"))).toBe(false);
    expect(existsSync(join(evidenceDir, "nested", ".playwright-cli"))).toBe(false);
    expect(existsSync(join(evidenceDir, "state.json"))).toBe(true);
    expect(existsSync(join(evidenceDir, "toast.png"))).toBe(true);
  });

  it("does not invoke docker or sandcastle when global rules are missing", async () => {
    rmSync(config.globalClaudePath);
    const sandbox = createSandbox(config, { CLAUDE_CODE_OAUTH_TOKEN: "fake-token" });
    await expect(sandbox.implement(request())).rejects.toThrow("配置來源不存在");
    expect(stubs.docker).not.toHaveBeenCalled();
    expect(stubs.run).not.toHaveBeenCalled();
  });

  it("does not invoke docker or sandcastle when a required skill is missing", async () => {
    rmSync(config.sandboxSkills[0]!.hostPath, { recursive: true });
    const sandbox = createSandbox(config, { CLAUDE_CODE_OAUTH_TOKEN: "fake-token" });
    await expect(sandbox.merge({ ...request(), source: "agent/43" })).rejects.toThrow("配置來源不存在");
    expect(stubs.docker).not.toHaveBeenCalled();
    expect(stubs.run).not.toHaveBeenCalled();
  });
});
