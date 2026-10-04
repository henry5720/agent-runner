import { execFile } from "node:child_process";
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
    async resetBranch(branch, startPoint) {
      await git(["branch", "-f", "--no-track", branch, startPoint]);
    },
    async push(branch) {
      // sandcastle 不設 upstream，refspec 要明確給
      await git(["push", "--force-with-lease", "origin", `${branch}:${branch}`]);
    },
  };
}
