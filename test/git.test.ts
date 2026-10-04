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
});
