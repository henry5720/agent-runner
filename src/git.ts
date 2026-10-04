import { execFile } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Git } from "./ports.js";

const run = promisify(execFile);

/** bot clone 上的 git 操作。不會切 bot clone 主 checkout 的分支（sandcastle 不允許 agent/* 被它 checkout）。 */
export function createGit(opts: { repoPath: string }): Git {
  const git = async (args: string[]) => (await run("git", ["-C", opts.repoPath, ...args], { maxBuffer: 16 * 1024 * 1024 })).stdout;
  // sandcastle 把 agent/<N> 的 worktree 開在 <cwd>/.sandcastle/worktrees/agent-<N>
  const worktreesDir = join(opts.repoPath, ".sandcastle", "worktrees");

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
    async resetBranch(branch, startPoint) {
      await git(["branch", "-f", "--no-track", branch, startPoint]);
    },
    async push(branch) {
      // sandcastle 不設 upstream，refspec 要明確給
      await git(["push", "--force-with-lease", "origin", `${branch}:${branch}`]);
    },
    async listWorktrees() {
      let names: string[];
      try {
        names = await readdir(worktreesDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      return Promise.all(
        names.map(async (name) => {
          const path = join(worktreesDir, name);
          return { name, path, modifiedAt: (await stat(path)).mtime };
        }),
      );
    },
    async removeWorktree(path) {
      try {
        await git(["worktree", "remove", "--force", path]);
      } catch {
        // 已經不是登記的 worktree（例如被硬殺後只剩目錄）→ 直接刪目錄
        await rm(path, { recursive: true, force: true });
        await git(["worktree", "prune"]);
      }
    },
  };
}
