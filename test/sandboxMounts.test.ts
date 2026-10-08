import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config, SandboxSkill } from "../src/config.js";
import { sandboxMounts, SANDBOX_PNPM_STORE } from "../src/sandboxMounts.js";
import { testConfig } from "./support/fakes.js";

describe("sandbox configuration mounts", () => {
  let root: string;
  let config: Config;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "runner-config-"));
    config = { ...testConfig, globalClaudePath: join(root, "CLAUDE.md"), repoEnvPath: join(root, "repo.env"), sandboxSkills: [] };
    writeFileSync(config.globalClaudePath, "規則來源");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function skill(name: string, overrides: Partial<SandboxSkill> = {}): SandboxSkill {
    const hostPath = join(root, name);
    mkdirSync(hostPath);
    writeFileSync(join(hostPath, "SKILL.md"), `name: ${name}`);
    writeFileSync(join(hostPath, "reference.md"), "參考資料");
    return { name, hostPath, phases: ["implement"], dependencies: [], ...overrides };
  }

  it("mounts only explicit global and skill sources readonly, while leaving the pnpm store writable", () => {
    const tdd = skill("tdd");
    config.sandboxSkills = [tdd];
    expect(sandboxMounts(config, "implement")).toEqual([
      { hostPath: config.globalClaudePath, sandboxPath: "/home/agent/.claude/CLAUDE.md", readonly: true },
      { hostPath: tdd.hostPath, sandboxPath: "/home/agent/.claude/skills/tdd", readonly: true },
      { hostPath: config.pnpmStorePath, sandboxPath: SANDBOX_PNPM_STORE },
    ]);
  });

  it("includes merge skills only in a merge run", () => {
    const merge = skill("resolving-merge-conflicts", { phases: ["merge"] });
    config.sandboxSkills = [merge];
    expect(sandboxMounts(config, "review").some((mount) => mount.hostPath === merge.hostPath)).toBe(false);
    expect(sandboxMounts(config, "merge")).toContainEqual({ hostPath: merge.hostPath, sandboxPath: "/home/agent/.claude/skills/resolving-merge-conflicts", readonly: true });
  });

  it("resolves host symlink targets before mounting the complete skill directory", () => {
    const source = skill("tdd");
    symlinkSync(source.hostPath, join(root, "target-skill"));
    symlinkSync(config.globalClaudePath, join(root, "target-rules"));
    config.globalClaudePath = join(root, "target-rules");
    config.sandboxSkills = [{ ...source, hostPath: join(root, "target-skill") }];
    const mounts = sandboxMounts(config, "implement");
    expect(mounts[0]?.hostPath).toBe(join(root, "CLAUDE.md"));
    expect(mounts[1]?.hostPath).toBe(source.hostPath);
  });

  it("rejects missing global rules and directory paths used as rules", () => {
    rmSync(config.globalClaudePath);
    expect(() => sandboxMounts(config, "implement")).toThrow("配置來源不存在");
    mkdirSync(config.globalClaudePath);
    expect(() => sandboxMounts(config, "implement")).toThrow("必須是 file");
  });

  it("rejects missing skill entry files", () => {
    const tdd = skill("tdd");
    rmSync(join(tdd.hostPath, "SKILL.md"));
    config.sandboxSkills = [tdd];
    expect(() => sandboxMounts(config, "implement")).toThrow("SKILL.md");
  });

  it("rejects skill entry symlinks pointing outside the mounted directory", () => {
    const tdd = skill("tdd");
    rmSync(join(tdd.hostPath, "SKILL.md"));
    symlinkSync(config.globalClaudePath, join(tdd.hostPath, "SKILL.md"));
    config.sandboxSkills = [tdd];
    expect(() => sandboxMounts(config, "implement")).toThrow("入口指向目錄外");
  });

  it("requires dependencies to be explicitly allowed in the same phase", () => {
    const tdd = skill("tdd", { dependencies: ["codebase-design"] });
    const dependency = skill("codebase-design", { phases: ["review"] });
    config.sandboxSkills = [tdd];
    expect(() => sandboxMounts(config, "implement")).toThrow("allowlist 依賴：codebase-design");
    config.sandboxSkills.push(dependency);
    expect(() => sandboxMounts(config, "implement")).toThrow("allowlist 依賴：codebase-design");
    dependency.phases = ["implement"];
    expect(sandboxMounts(config, "implement")).toHaveLength(4);
    rmSync(dependency.hostPath, { recursive: true });
    expect(() => sandboxMounts(config, "implement")).toThrow("配置來源不存在");
  });

  it("rejects duplicate names and names that could escape the target directory", () => {
    const tdd = skill("tdd");
    config.sandboxSkills = [tdd, tdd];
    expect(() => sandboxMounts(config, "implement")).toThrow("名稱無效或重複");
    config.sandboxSkills = [{ ...tdd, name: "../escape" }];
    expect(() => sandboxMounts(config, "implement")).toThrow("名稱無效或重複");
  });

  it("mounts a repo env file readonly only when it exists", () => {
    expect(sandboxMounts(config, "implement")).toHaveLength(2);
    writeFileSync(config.repoEnvPath, "");
    expect(sandboxMounts(config, "implement")).toContainEqual({ hostPath: config.repoEnvPath, sandboxPath: "frontend/.env.local", readonly: true });
  });
});
