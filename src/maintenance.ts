/** `agent-runner` 的維護指令（`rebuild`、`clean-worktrees`）。bash 那邊先拿輪次鎖，這裡不再拿。 */
import { removeOldWorktrees } from "./endings.js";
import type { Config } from "./config.js";
import { wantedImage } from "./image.js";
import type { Deps } from "./ports.js";

/** 預設跟每一輪一樣只刪超過 3 天的；`all` 全部刪（worktree 壞掉、要救回來時）。回傳刪掉的路徑 */
export async function cleanWorktrees(deps: Pick<Deps, "git" | "clock">, opts: { all: boolean }): Promise<string[]> {
  const before = await deps.git.listWorktrees();
  if (opts.all) {
    for (const w of before) await deps.git.removeWorktree(w.path);
  } else {
    await removeOldWorktrees(deps);
  }
  const left = new Set((await deps.git.listWorktrees()).map((w) => w.path));
  return before.map((w) => w.path).filter((p) => !left.has(p));
}

/** 同一個 tag 不用 cache 重 build（更新 sandbox 裡沒釘版本的 Claude CLI）。回傳 tag */
export async function rebuildImage(config: Config, deps: Pick<Deps, "git" | "sandbox">): Promise<string> {
  await deps.git.fetch();
  const { tag, nodeVersion } = await wantedImage(config, deps, `origin/${config.baseBranch}`);
  await deps.sandbox.buildImage({ tag, nodeVersion, fresh: true });
  return tag;
}
