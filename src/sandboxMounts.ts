import { existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config, SandboxPhase } from "./config.js";

export const SANDBOX_PNPM_STORE = "/home/agent/.local/share/pnpm/store";

export interface SandboxMount {
  hostPath: string;
  sandboxPath: string;
  readonly?: boolean;
}

function resolveSource(path: string, kind: "file" | "directory"): string {
  if (!existsSync(path)) throw new Error(`sandbox 配置來源不存在：${path}`);
  const resolved = realpathSync(path);
  const stat = statSync(resolved);
  if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) {
    throw new Error(`sandbox 配置來源必須是 ${kind}：${path}`);
  }
  return resolved;
}

export function sandboxMounts(config: Config, phase: SandboxPhase): SandboxMount[] {
  const globalClaude = resolveSource(config.globalClaudePath, "file");
  const names = new Set<string>();
  for (const skill of config.sandboxSkills) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) || names.has(skill.name)) {
      throw new Error(`sandbox skill 名稱無效或重複：${skill.name}`);
    }
    names.add(skill.name);
  }
  const active = config.sandboxSkills.filter((skill) => skill.phases.includes(phase));
  const activeNames = new Set(active.map((skill) => skill.name));
  const skills = active.map((skill) => {
    for (const dependency of skill.dependencies) {
      if (!activeNames.has(dependency)) {
        throw new Error(`sandbox skill ${skill.name} 缺少 ${phase} 階段的 allowlist 依賴：${dependency}`);
      }
    }
    const source = resolveSource(skill.hostPath, "directory");
    const entry = resolveSource(join(source, "SKILL.md"), "file");
    if (!entry.startsWith(`${source}/`)) {
      throw new Error(`sandbox skill 入口指向目錄外：${skill.name}`);
    }
    return { hostPath: source, sandboxPath: `/home/agent/.claude/skills/${skill.name}`, readonly: true };
  });
  return [
    { hostPath: globalClaude, sandboxPath: "/home/agent/.claude/CLAUDE.md", readonly: true },
    ...skills,
    { hostPath: config.pnpmStorePath, sandboxPath: SANDBOX_PNPM_STORE },
    ...(existsSync(config.repoEnvPath)
      ? [{ hostPath: resolveSource(config.repoEnvPath, "file"), sandboxPath: "frontend/.env.local", readonly: true }]
      : []),
  ];
}
