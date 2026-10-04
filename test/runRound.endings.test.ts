import { describe, expect, it } from "vitest";
import { runRound } from "../src/runRound.js";
import { fakeDeps, humanRequeues, issue, passResult, testConfig } from "./support/fakes.js";

const needsInfo = (questions: string[]) =>
  passResult({ outcome: "needs-info", prTitle: "", summary: "", verification: [], questions });

describe("runRound — needs-info", () => {
  it("opens no PR, swaps agent-in-progress for needs-info and lists every question in a comment", async () => {
    const deps = fakeDeps({
      issues: [issue({ number: 42 })],
      results: { 42: needsInfo(["按鈕要放在哪一頁？", "匯出格式是 CSV 還是 XLSX？"]) },
    });

    await runRound(testConfig, deps);

    expect({ prs: deps.github.prs, issue: deps.github.issue(42) }).toMatchObject({
      prs: [],
      issue: {
        labels: ["needs-info"],
        comments: [expect.stringContaining("已接單"), expect.stringMatching(/按鈕要放在哪一頁？[\s\S]*匯出格式是 CSV 還是 XLSX？/)],
      },
    });
  });

  it("creates the needs-info label when the repo does not have it", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: needsInfo(["缺規格"]) } });

    await runRound(testConfig, deps);

    expect(deps.github.repoLabels).toContain("needs-info");
  });

  it("carries on with the next picked issue", async () => {
    const deps = fakeDeps({
      issues: [issue({ number: 42 }), issue({ number: 43 })],
      results: { 42: needsInfo(["缺規格"]), 43: passResult() },
    });

    await runRound(testConfig, deps);

    expect(deps.github.prs.map((pr) => pr.head)).toEqual(["agent/43"]);
  });
});

const timeout = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

describe("runRound — timeout", () => {
  it("opens no PR, drops agent-in-progress without retrying, and says it hit the 60-minute limit", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: { throws: timeout() } } });

    await runRound(testConfig, deps);

    expect({ prs: deps.github.prs, issue: deps.github.issue(42) }).toMatchObject({
      prs: [],
      issue: { labels: [], comments: [expect.anything(), expect.stringContaining("60 分鐘")] },
    });
  });

  it("points at agent/<N> and promises no cleanup when sandcastle kept no worktree", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: { throws: timeout() } } });

    await runRound(testConfig, deps);

    const comment = deps.github.issue(42).comments[1] ?? "";
    expect([comment.includes("`agent/42`"), comment.includes(".sandcastle/worktrees"), comment.includes("3 天")]).toEqual([true, false, false]);
  });

  it("gives the kept worktree's path and says it is deleted after 3 days when sandcastle kept one", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: { throws: timeout(), leavesWorktree: true } } });

    await runRound(testConfig, deps);

    expect(deps.github.issue(42).comments[1]).toMatch(/\/bot\/widgets\/\.sandcastle\/worktrees\/agent-42[\s\S]*3 天後自動刪/);
  });
  it("wraps up the same way when the reviewer run is the one that times out", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult() }, reviews: { 42: { throws: timeout() } } });

    await runRound(testConfig, deps);

    expect({ prs: deps.github.prs, issue: deps.github.issue(42) }).toMatchObject({
      prs: [],
      issue: { labels: [], comments: [expect.anything(), expect.stringContaining("60 分鐘")] },
    });
  });
});

describe("runRound — crash", () => {
  it("writes the sandbox's reason into the comment, e.g. a failed pnpm install, and opens no PR", async () => {
    const deps = fakeDeps({
      issues: [issue({ number: 42 })],
      results: { 42: { throws: new Error("pnpm install 失敗：ERR_PNPM_OUTDATED_LOCKFILE\n  at hook onSandboxReady") } },
    });

    await runRound(testConfig, deps);

    expect({ prs: deps.github.prs, issue: deps.github.issue(42) }).toMatchObject({
      prs: [],
      issue: { labels: [], comments: [expect.anything(), expect.stringContaining("pnpm install 失敗：ERR_PNPM_OUTDATED_LOCKFILE")] },
    });
  });

  it("carries on with the next picked issue", async () => {
    const deps = fakeDeps({
      issues: [issue({ number: 42 }), issue({ number: 43 })],
      results: { 42: { throws: new Error("container exited 137") }, 43: passResult() },
    });

    await runRound(testConfig, deps);

    expect(deps.github.prs.map((pr) => pr.head)).toEqual(["agent/43"]);
  });
});

describe("runRound — done but nothing committed", () => {
  const reason = "agent 回報完成但 branch 上沒有 commit";

  it("ends as a crash: no push, no PR, labels and assignee dropped, the comment and Slack give the reason", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult() } });
    deps.sandbox.commitless.add(42);

    await runRound(testConfig, deps);

    expect({
      remote: deps.git.remoteBranches.has("agent/42"),
      prs: deps.github.prs,
      issue: deps.github.issue(42),
      slack: deps.notifier.messages,
    }).toEqual({
      remote: false,
      prs: [],
      issue: expect.objectContaining({ labels: [], assignees: [], comments: [expect.anything(), expect.stringContaining(reason)] }),
      slack: [expect.stringMatching(new RegExp(`^💥[\\s\\S]*原因：${reason}`))],
    });
  });

  it("on re-pickup leaves the existing PR and its branch alone instead of force-pushing an empty branch over them", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult({ prTitle: "feat(x): first" }) } });
    await runRound(testConfig, deps);
    const remoteBefore = deps.git.remoteBranches.get("agent/42");

    humanRequeues(deps, 42);
    deps.sandbox.script(42, passResult({ prTitle: "feat(x): second" }));
    deps.sandbox.commitless.add(42);
    await runRound(testConfig, deps);

    expect({ remote: deps.git.remoteBranches.get("agent/42"), prs: deps.github.prs.map((p) => p.title), labels: deps.github.issue(42).labels }).toEqual({
      remote: remoteBefore,
      prs: ["feat(x): first"],
      labels: [],
    });
  });
});

describe("runRound — leftovers from a hard-killed round", () => {
  const stale = () => issue({ number: 50, labels: ["agent-in-progress"], assignees: ["henry5720"] });
  const keptWorktree = { name: "agent-50", path: "/bot/widgets/.sandcastle/worktrees/agent-50", modifiedAt: new Date("2026-10-04T14:30:00Z") };

  it("wraps up a leftover agent-in-progress issue as a crash, without running it again", async () => {
    const deps = fakeDeps({ issues: [stale()], results: {} });

    await runRound(testConfig, deps);

    expect({ runs: deps.sandbox.runs, prs: deps.github.prs, issue: deps.github.issue(50) }).toMatchObject({
      runs: [],
      prs: [],
      issue: { labels: [], comments: [expect.stringContaining("中斷")] },
    });
  });

  it("points at the agent-<N> worktree under the bot clone the killed run left behind", async () => {
    const deps = fakeDeps({ issues: [stale()], results: {} });
    deps.git.worktrees = [keptWorktree];

    await runRound(testConfig, deps);

    expect(deps.github.issue(50).comments[0]).toMatch(/\/bot\/widgets\/\.sandcastle\/worktrees\/agent-50[\s\S]*3 天後自動刪/);
  });

  it("still picks up new issues in the same round", async () => {
    const deps = fakeDeps({ issues: [stale(), issue({ number: 51 })], results: { 51: passResult() } });

    await runRound(testConfig, deps);

    expect(deps.github.prs.map((pr) => pr.head)).toEqual(["agent/51"]);
  });
});

describe("runRound — old sandcastle worktrees", () => {
  it("deletes worktrees older than 3 days and keeps younger ones", async () => {
    const deps = fakeDeps({ issues: [], results: {}, now: new Date("2026-10-04T15:00:00Z") });
    const at = (iso: string, name: string) => ({ name, path: `/bot/widgets/.sandcastle/worktrees/${name}`, modifiedAt: new Date(iso) });
    deps.git.worktrees = [at("2026-10-01T14:59:00Z", "agent-1"), at("2026-10-01T15:01:00Z", "agent-2"), at("2026-10-04T09:00:00Z", "agent-3")];

    await runRound(testConfig, deps);

    expect(deps.git.worktrees.map((w) => w.name)).toEqual(["agent-2", "agent-3"]);
  });
});
