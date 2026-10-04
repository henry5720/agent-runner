import { createHash } from "node:crypto";
import type { Config } from "./config.js";
import type { Deps } from "./ports.js";

/**
 * image tag = `<name>:<sha256(Dockerfile + NUL + .nvmrc 去頭尾空白) 前 12 碼>`。
 * Dockerfile 或目標 repo 的 Node 版本一變，tag 就變，下一輪開頭會 build 新的。
 */
export function imageTag(name: string, dockerfile: string, nvmrc: string): string {
  const hash = createHash("sha256").update(dockerfile).update("\0").update(nvmrc.trim()).digest("hex");
  return `${name}:${hash.slice(0, 12)}`;
}

/** 這一刻該用的 image：tag 與 build-arg 的 Node 版本都從 `baseRef`（例如 origin/dev）上的 `.nvmrc` 讀。每一輪和 `agent-runner rebuild` 共用 */
export async function wantedImage(config: Config, { git, sandbox }: Pick<Deps, "git" | "sandbox">, baseRef: string): Promise<{ tag: string; nodeVersion: string }> {
  const nvmrc = await git.showFile(baseRef, config.nvmrcPath);
  return { tag: imageTag(config.imageName, await sandbox.dockerfile(), nvmrc), nodeVersion: nvmrc.trim() };
}
