import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createGit } from "../src/git.js";

/** 真的 git：本機 bare remote ＋ 操作者的 clone ＋ runner 的 bot clone（兩者同 email、不同 user.name，跟正式部署一樣） */
const EMAIL = "operator@example.com";
const RUNNER = "henry (agent)";
const OPERATOR = "henry5720";

function sh(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
}

function commit(cwd: string, author: string, file: string) {
  writeFileSync(join(cwd, file), file);
  sh(cwd, "add", file);
  sh(cwd, "-c", `user.name=${author}`, "-c", `user.email=${EMAIL}`, "commit", "-q", "-m", `add ${file}`);
}

let remote: string;
let human: string;
let bot: string;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "git-adapter-"));
  remote = join(root, "remote.git");
  human = join(root, "human");
  bot = join(root, "bot");
  sh(root, "init", "-q", "--bare", "-b", "dev", remote);
  sh(root, "clone", "-q", remote, human);
  commit(human, OPERATOR, "base.txt");
  sh(human, "push", "-q", "origin", "HEAD:dev");
  sh(root, "clone", "-q", remote, bot);
  sh(bot, "config", "user.name", RUNNER);
  sh(bot, "config", "user.email", EMAIL);
});

/** runner 在 bot clone 上做 agent/1 並 push（跟 sandcastle：worktree 在 .sandcastle/worktrees/agent-1） */
function runnerPushesAgentBranch() {
  const wt = join(bot, ".sandcastle/worktrees/agent-1");
  mkdirSync(join(bot, ".sandcastle/worktrees"), { recursive: true });
  sh(bot, "worktree", "add", "-q", "-b", "agent/1", wt, "origin/dev");
  commit(wt, RUNNER, "runner.txt");
  sh(bot, "push", "-q", "origin", "agent/1:agent/1");
  return wt;
}

describe("git adapter against a real repo", () => {
  it("lists no authors when agent/<N> is not on origin", async () => {
    const git = createGit({ repoPath: bot });
    await git.fetch();

    expect(await git.branchAuthors("agent/1", "origin/dev")).toEqual([]);
  });

  it("tells the runner's commits from a human's by author name even when the email is the same", async () => {
    runnerPushesAgentBranch();
    sh(human, "fetch", "-q");
    sh(human, "switch", "-q", "agent/1");
    commit(human, OPERATOR, "human.txt");
    sh(human, "push", "-q", "origin", "agent/1");
    const git = createGit({ repoPath: bot });
    await git.fetch();

    expect((await git.branchAuthors("agent/1", "origin/dev")).sort()).toEqual([OPERATOR, RUNNER].sort());
  });

  it("removes the leftover worktree (even dirty) so agent/<N> can be reset to origin/dev and force-pushed over the old history", async () => {
    const wt = runnerPushesAgentBranch();
    writeFileSync(join(wt, "half-done.txt"), "uncommitted");
    const git = createGit({ repoPath: bot });
    await git.fetch();

    const leftover = (await git.listWorktrees()).find((w) => w.name === "agent-1");
    await git.removeWorktree(leftover!.path);
    await git.resetBranch("agent/1", "origin/dev");
    await git.push("agent/1");

    expect({
      worktreeGone: !existsSync(wt),
      remoteAtDev: sh(remote, "rev-parse", "agent/1") === sh(remote, "rev-parse", "dev"),
    }).toEqual({ worktreeGone: true, remoteAtDev: true });
  });

  it("tells whether a branch is on origin after fetch", async () => {
    runnerPushesAgentBranch();
    const git = createGit({ repoPath: bot });
    await git.fetch();

    expect([await git.hasRemoteBranch("agent/1"), await git.hasRemoteBranch("agent/7")]).toEqual([true, false]);
  });

  /** 整合分支 agent/7 從 dev 開；人在上面先 push 一顆 commit */
  function integrationBranchWithHumanCommit(file: string) {
    sh(human, "switch", "-q", "-c", "agent/7", "origin/dev");
    writeFileSync(join(human, file), "human");
    sh(human, "add", file);
    sh(human, "-c", `user.name=${OPERATOR}`, "-c", `user.email=${EMAIL}`, "commit", "-q", "-m", `human ${file}`);
    sh(human, "push", "-q", "origin", "agent/7");
  }

  /** runner 在人那顆 commit 之前就開了 agent/1（這裡直接從 dev 開），commit 一個檔（不 push） */
  function runnerCommitsBesideHuman(file: string, content: string) {
    const wt = join(bot, ".sandcastle/worktrees/agent-1");
    mkdirSync(join(bot, ".sandcastle/worktrees"), { recursive: true });
    sh(bot, "fetch", "-q");
    sh(bot, "worktree", "add", "-q", "-b", "agent/1", wt, "origin/dev");
    writeFileSync(join(wt, file), content);
    sh(wt, "add", file);
    sh(wt, "commit", "-q", "-m", `runner ${file}`);
    sh(bot, "worktree", "remove", "--force", wt);
  }

  it("merges agent/<A> into the integration branch with `git merge --no-edit` and pushes it, keeping the human's commit pushed meanwhile", async () => {
    integrationBranchWithHumanCommit("human.txt");
    runnerCommitsBesideHuman("runner.txt", "runner");
    const git = createGit({ repoPath: bot });
    await git.fetch();

    const outcome = await git.mergeInto("agent/7", "agent/1");

    const head = sh(remote, "rev-parse", "agent/7");
    expect({
      outcome,
      parents: sh(remote, "rev-list", "--parents", "-n", "1", "agent/7").split(" ").length - 1,
      trackingUpdated: sh(bot, "rev-parse", "origin/agent/7") === head,
      hasBoth: sh(remote, "ls-tree", "--name-only", "agent/7").split("\n").sort(),
      tempWorktrees: sh(bot, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length,
    }).toEqual({ outcome: { kind: "merged", sha: head }, parents: 2, trackingUpdated: true, hasBoth: ["base.txt", "human.txt", "runner.txt"], tempWorktrees: 1 });
  });

  it("aborts on a conflict, pushes nothing and leaves no temporary worktree", async () => {
    integrationBranchWithHumanCommit("same.txt");
    runnerCommitsBesideHuman("same.txt", "runner");
    const git = createGit({ repoPath: bot });
    await git.fetch();
    const before = sh(remote, "rev-parse", "agent/7");

    const outcome = await git.mergeInto("agent/7", "agent/1");

    expect({
      outcome,
      unchanged: sh(remote, "rev-parse", "agent/7") === before,
      tempWorktrees: sh(bot, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length,
    }).toEqual({ outcome: { kind: "conflict" }, unchanged: true, tempWorktrees: 1 });
  });

  /** merge run：在 agent/7 的 worktree 裡合 agent/1、解掉衝突（兩邊都留）、commit；回傳 worktree */
  function agentResolvesConflict() {
    const wt = join(bot, ".sandcastle/worktrees/agent-7");
    sh(bot, "branch", "-f", "--no-track", "agent/7", "origin/agent/7");
    sh(bot, "worktree", "add", "-q", wt, "agent/7");
    try {
      sh(wt, "merge", "--no-edit", "agent/1");
    } catch {
      writeFileSync(join(wt, "same.txt"), "human\nrunner\n");
      sh(wt, "add", "same.txt");
      sh(wt, "commit", "-q", "--no-edit");
    }
    return wt;
  }

  it("pushes the integration branch a merge run resolved, without force, when it holds both sides", async () => {
    integrationBranchWithHumanCommit("same.txt");
    runnerCommitsBesideHuman("same.txt", "runner");
    const git = createGit({ repoPath: bot });
    await git.fetch();
    agentResolvesConflict();

    const outcome = await git.pushMerge("agent/7", "agent/1");

    const head = sh(remote, "rev-parse", "agent/7");
    expect({ outcome, parents: sh(remote, "rev-list", "--parents", "-n", "1", "agent/7").split(" ").length - 1 }).toEqual({
      outcome: { kind: "merged", sha: head },
      parents: 2,
    });
  });

  it("pushes nothing when the local integration branch does not contain agent/<A>", async () => {
    integrationBranchWithHumanCommit("same.txt");
    runnerCommitsBesideHuman("same.txt", "runner");
    const git = createGit({ repoPath: bot });
    await git.fetch();
    const before = sh(remote, "rev-parse", "agent/7");
    sh(bot, "branch", "-f", "--no-track", "agent/7", "origin/agent/7");

    const outcome = await git.pushMerge("agent/7", "agent/1");

    expect({ outcome, unchanged: sh(remote, "rev-parse", "agent/7") === before }).toEqual({ outcome: { kind: "not-merged" }, unchanged: true });
  });

  it("reports a rejected push, without overwriting, when a human pushed to the integration branch during the merge run", async () => {
    integrationBranchWithHumanCommit("same.txt");
    runnerCommitsBesideHuman("same.txt", "runner");
    const git = createGit({ repoPath: bot });
    await git.fetch();
    agentResolvesConflict();
    commit(human, OPERATOR, "later.txt");
    sh(human, "push", "-q", "origin", "agent/7");
    const humans = sh(remote, "rev-parse", "agent/7");

    const outcome = await git.pushMerge("agent/7", "agent/1");

    expect({ outcome, unchanged: sh(remote, "rev-parse", "agent/7") === humans }).toEqual({ outcome: { kind: "rejected" }, unchanged: true });
  });

  it("still throws on push errors other than a rejection", async () => {
    integrationBranchWithHumanCommit("same.txt");
    runnerCommitsBesideHuman("same.txt", "runner");
    const git = createGit({ repoPath: bot });
    await git.fetch();
    agentResolvesConflict();
    sh(bot, "remote", "set-url", "origin", join(bot, "no-such-remote.git"));

    await expect(git.pushMerge("agent/7", "agent/1")).rejects.toThrow();
  });
});
