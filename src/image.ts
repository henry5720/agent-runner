import { createHash } from "node:crypto";

/**
 * image tag = `<name>:<sha256(Dockerfile + NUL + .nvmrc 去頭尾空白) 前 12 碼>`。
 * Dockerfile 或目標 repo 的 Node 版本一變，tag 就變，下一輪開頭會 build 新的。
 */
export function imageTag(name: string, dockerfile: string, nvmrc: string): string {
  const hash = createHash("sha256").update(dockerfile).update("\0").update(nvmrc.trim()).digest("hex");
  return `${name}:${hash.slice(0, 12)}`;
}
