import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Git } from "./ports.js";

const run = promisify(execFile);

/** bot clone 上的 git 操作。不會切 bot clone 主 checkout 的分支（sandcastle 不允許 agent/* 被它 checkout）。 */
export function createGit(opts: { repoPath: string }): Git {
  const git = async (args: string[]) => (await run("git", ["-C", opts.repoPath, ...args], { maxBuffer: 16 * 1024 * 1024 })).stdout;

  return {
    async fetch() {
      await git(["fetch", "--prune", "origin"]);
    },
    async showFile(ref, path) {
      return git(["show", `${ref}:${path}`]);
    },
    async branchAuthors(branch, baseRef) {
      // 看遠端：人可能直接在 GitHub 上 push，本地的 agent/<N> 可能是舊的
      const remote = `refs/remotes/origin/${branch}`;
      const exists = await git(["rev-parse", "--verify", "--quiet", remote]).then(() => true, () => false);
      if (!exists) return [];
      const names = (await git(["log", "--format=%an", `${baseRef}..${remote}`])).split("\n").filter(Boolean);
      return [...new Set(names)];
    },
    async removeWorktree(branch) {
      // sandcastle 把 managed worktree 放在 .sandcastle/worktrees/<branch 的 / 換成 ->
      const path = join(opts.repoPath, ".sandcastle", "worktrees", branch.replace(/\//g, "-"));
      if (existsSync(path)) await git(["worktree", "remove", "--force", path]);
      await git(["worktree", "prune"]);
    },
    async resetBranch(branch, startPoint) {
      await git(["branch", "-f", "--no-track", branch, startPoint]);
    },
    async push(branch) {
      // sandcastle 不設 upstream，refspec 要明確給
      await git(["push", "--force-with-lease", "origin", `${branch}:${branch}`]);
    },
  };
}
