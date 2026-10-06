import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
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
    async hasRemoteBranch(branch) {
      return git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).then(() => true, () => false);
    },
    async mergeInto(target, source) {
      // 主 checkout 不能切到 agent/*（sandcastle 的限制），在暫時的 detached worktree 裡合，合完直接 push 到遠端的 target
      const dir = await mkdtemp(join(tmpdir(), "agent-runner-merge-"));
      const inDir = async (args: string[]) => (await run("git", ["-C", dir, ...args], { maxBuffer: 16 * 1024 * 1024 })).stdout;
      try {
        await git(["worktree", "add", "--detach", "--force", dir, `origin/${target}`]);
        try {
          await inDir(["merge", "--no-edit", source]);
        } catch (err) {
          // 只有真的有衝突的檔才算衝突；其他失敗（例如沒有 user.name）照常丟出去
          const conflicted = (await inDir(["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).trim();
          if (!conflicted) throw err;
          await inDir(["merge", "--abort"]);
          return { kind: "conflict" };
        }
        await inDir(["push", "origin", `HEAD:refs/heads/${target}`]);
        // push 會更新 refs/remotes/origin/<target>；之後同一輪從 origin/<target> 開的 branch 拿得到這次合併
        return { kind: "merged", sha: (await inDir(["rev-parse", "HEAD"])).trim() };
      } finally {
        await git(["worktree", "remove", "--force", dir]).catch(async () => {
          await rm(dir, { recursive: true, force: true });
          await git(["worktree", "prune"]);
        });
      }
    },
    async pushMerge(target, source) {
      const contains = (ancestor: string) => git(["merge-base", "--is-ancestor", ancestor, target]).then(() => true, () => false);
      // source 整條都在（agent 真的合了）、origin/<target> 也都在（沒改寫整合分支）才 push
      if (!(await contains(source)) || !(await contains(`origin/${target}`))) return { kind: "not-merged" };
      // 不 force：merge run 期間有人往遠端 push 就讓它被拒，不蓋掉人的 commit
      try {
        await git(["push", "origin", `${target}:refs/heads/${target}`]);
      } catch (err) {
        // 只有「遠端有本地沒有的 commit」這種被拒算 rejected；權限、網路等錯誤照常丟出去
        const stderr = String((err as { stderr?: unknown }).stderr ?? "");
        if (/\[rejected\]|non-fast-forward|fetch first/.test(stderr)) return { kind: "rejected" };
        throw err;
      }
      return { kind: "merged", sha: (await git(["rev-parse", target])).trim() };
    },
    async hasCommits(branch, baseRef) {
      return Number((await git(["rev-list", "--count", `${baseRef}..${branch}`])).trim()) > 0;
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
