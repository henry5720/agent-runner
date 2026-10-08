import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { createSandbox } from "../src/sandbox.js";
import { issue, passResult, reviewResult, testConfig } from "./support/fakes.js";

const stubs = vi.hoisted(() => ({ run: vi.fn(), docker: vi.fn() }));

vi.mock("@ai-hero/sandcastle", () => ({
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
      repoEnvPath: join(root, "absent.env"),
      sandboxSkills: [{ name: "resolving-merge-conflicts", hostPath: mergePath, phases: ["merge"], dependencies: [] }],
    };
    writeFileSync(config.globalClaudePath, "global rules");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const request = () => ({ imageTag: "test", issue: issue({ number: 42 }), branch: "agent/42", baseRef: "origin/dev", signal: new AbortController().signal });

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
