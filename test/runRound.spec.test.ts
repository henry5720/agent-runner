import { describe, expect, it } from "vitest";
import { runRound } from "../src/runRound.js";
import type { ReviewResult } from "../src/result.js";
import { fakeDeps, humanRequeues, issue, passResult, reviewResult, type ScriptedFailure, testConfig } from "./support/fakes.js";

/** spec #40 底下的 sub-issue #42（parent 不是 wayfinder:map） */
const subIssue = (n = 42) =>
  issue({ number: n, parentNumber: 40, parentLabels: ["ready-for-agent"], parentTitle: "Spec: 匯出報表", parentBody: "整份 spec 的內文" });

describe("runRound — spec sub-issue: where agent/<A> starts", () => {
  it("starts agent/<A> from origin/agent/<S> when the integration branch exists", async () => {
    const deps = fakeDeps({ issues: [subIssue()], results: { 42: passResult() } });
    deps.git.humanPushes("agent/40", "henry (agent)");

    await runRound(testConfig, deps);

    expect({ local: deps.git.localBranches.get("agent/42")?.base, sandboxBase: deps.sandbox.runs[0]?.baseRef }).toEqual({
      local: "origin/agent/40",
      sandboxBase: "origin/agent/40",
    });
  });
});

describe("runRound — spec sub-issue: everything passes", () => {
  it("merges agent/<A> into origin/agent/<S>, keeping what was already there", async () => {
    const deps = fakeDeps({ issues: [subIssue()], results: { 42: passResult() } });
    deps.git.humanPushes("agent/40", "henry5720");
    const before = [...deps.git.remoteCommits.get("agent/40")!];

    await runRound(testConfig, deps);

    expect({
      merged: deps.git.remoteContains("agent/40", "agent/42"),
      kept: before.every((c) => deps.git.remoteCommits.get("agent/40")!.includes(c)),
    }).toEqual({ merged: true, kept: true });
  });

  it("creates agent/<S> from origin/dev when it is not on origin yet, then merges into it", async () => {
    const deps = fakeDeps({ issues: [subIssue()], results: { 42: passResult() } });

    await runRound(testConfig, deps);

    expect({ base: deps.git.remoteBranches.get("agent/40")?.base, merged: deps.git.remoteContains("agent/40", "agent/42") }).toEqual({
      base: "origin/dev",
      merged: true,
    });
  });

  it("opens one draft PR from agent/<S> into dev for the first sub-issue, assigned to the operator, closing the spec, and no PR for agent/<A>", async () => {
    const deps = fakeDeps({ issues: [subIssue()], results: { 42: passResult() } });

    await runRound(testConfig, deps);

    expect(deps.github.prs).toEqual([
      expect.objectContaining({
        base: "dev",
        head: "agent/40",
        draft: true,
        title: "Spec: 匯出報表",
        assignee: "henry5720",
        body: expect.stringMatching(/^Closes #40\b/),
      }),
    ]);
  });

  it("falls back to `spec #<S>` as the integration PR title when the spec title is empty", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42, parentNumber: 40, parentLabels: [], parentTitle: "" })], results: { 42: passResult() } });

    await runRound(testConfig, deps);

    expect(deps.github.prs.map((p) => [p.head, p.title])).toEqual([["agent/40", "spec #40"]]);
  });

  it("updates that same draft PR for the next sub-issue, listing both, without marking it ready", async () => {
    const deps = fakeDeps({
      issues: [subIssue(42), subIssue(43)],
      results: { 42: passResult({ summary: "做了第一張" }), 43: passResult({ summary: "做了第二張" }) },
    });
    await runRound(testConfig, deps);
    await runRound(testConfig, deps);

    expect(
      deps.github.prs.map((p) => ({ head: p.head, draft: p.draft, closes: p.body.startsWith("Closes #40"), first: p.body.includes("做了第一張"), second: p.body.includes("做了第二張") })),
    ).toEqual([{ head: "agent/40", draft: true, closes: true, first: true, second: true }]);
  });

  it("comments the merged agent/<S> commit and the verification on #A, then closes it with no runner labels", async () => {
    const deps = fakeDeps({
      issues: [subIssue()],
      results: { 42: passResult({ verification: [{ command: "pnpm test run src/report", result: "8 passed" }] }) },
    });

    await runRound(testConfig, deps);

    const mergeSha = deps.git.remoteCommits.get("agent/40")!.at(-1)!.sha;
    expect(deps.github.issue(42)).toMatchObject({
      state: "CLOSED",
      labels: [],
      comments: [expect.stringContaining("已接單"), expect.stringMatching(new RegExp(`agent/40[\\s\\S]*${mergeSha}[\\s\\S]*pnpm test run src/report[\\s\\S]*8 passed`))],
    });
  });
});

describe("runRound — spec sub-issue: [WIP]", () => {
  const wipDeps = () =>
    fakeDeps({
      issues: [subIssue()],
      results: { 42: passResult({ prTitle: "feat(report): 匯出" }) },
      reviews: { 42: reviewResult({ outcome: "wip", failedChecks: ["pnpm run typecheck"] }) },
    });

  it("pushes agent/<A> and opens a [WIP] draft PR into agent/<S>, not into dev, leaving agent/<S> without its commits", async () => {
    const deps = wipDeps();
    deps.git.humanPushes("agent/40", "henry5720");
    const before = [...deps.git.remoteCommits.get("agent/40")!];

    await runRound(testConfig, deps);

    expect({
      prs: deps.github.prs.map((p) => ({ base: p.base, head: p.head, draft: p.draft, title: p.title, assignee: p.assignee })),
      pushed: deps.git.remoteBranches.has("agent/42"),
      integration: deps.git.remoteCommits.get("agent/40"),
    }).toEqual({
      prs: [{ base: "agent/40", head: "agent/42", draft: true, title: "[WIP] feat(report): 匯出", assignee: "henry5720" }],
      pushed: true,
      integration: before,
    });
  });

  it("creates agent/<S> from origin/dev first when it is not on origin, so the [WIP] PR has a base", async () => {
    const deps = wipDeps();

    await runRound(testConfig, deps);

    expect({ base: deps.git.remoteBranches.get("agent/40")?.base, prBase: deps.github.prs[0]?.base }).toEqual({ base: "origin/dev", prBase: "agent/40" });
  });

  it("unassigns the operator and leaves #A open with the PR link", async () => {
    const deps = wipDeps();

    await runRound(testConfig, deps);

    expect(deps.github.issue(42)).toMatchObject({
      state: "OPEN",
      labels: [],
      assignees: [],
      comments: [expect.stringContaining("已接單"), expect.stringContaining(deps.github.prs[0]!.url)],
    });
  });
});


describe("runRound — spec sub-issue: merge conflict goes to a merge run", () => {
  const conflictDeps = (merge: ReviewResult | ScriptedFailure) => {
    const deps = fakeDeps({ issues: [subIssue()], results: { 42: passResult({ prTitle: "feat(report): 匯出" }) }, merges: { 42: merge } });
    deps.git.humanPushes("agent/40", "henry5720");
    deps.git.conflicts.add("agent/42");
    return deps;
  };
  const resolved = () => reviewResult({ summary: "兩邊都保留", verification: [{ command: "pnpm test run src/report", result: "9 passed" }] });

  it("runs a merge sandbox run on agent/<S>, starting from origin/agent/<S>, to merge agent/<A> in", async () => {
    const deps = conflictDeps(resolved());

    await runRound(testConfig, deps);

    expect(deps.sandbox.merges.map((m) => ({ branch: m.branch, baseRef: m.baseRef, source: m.source, issue: m.issue.number }))).toEqual([
      { branch: "agent/40", baseRef: "origin/agent/40", source: "agent/42", issue: 42 },
    ]);
  });

  it("does not run a merge run when the merge has no conflict", async () => {
    const deps = fakeDeps({ issues: [subIssue()], results: { 42: passResult() } });

    await runRound(testConfig, deps);

    expect(deps.sandbox.merges).toEqual([]);
  });

  it("resolved with checks passing: pushes the merged agent/<S>, keeping what was there, and opens the spec's draft PR", async () => {
    const deps = conflictDeps(resolved());
    const before = [...deps.git.remoteCommits.get("agent/40")!];

    await runRound(testConfig, deps);

    expect({
      merged: deps.git.remoteContains("agent/40", "agent/42"),
      kept: before.every((c) => deps.git.remoteCommits.get("agent/40")!.includes(c)),
      prs: deps.github.prs.map((p) => ({ base: p.base, head: p.head, draft: p.draft, closesSpec: p.body.startsWith("Closes #40") })),
    }).toEqual({ merged: true, kept: true, prs: [{ base: "dev", head: "agent/40", draft: true, closesSpec: true }] });
  });

  it("resolved with checks passing: comments the merge commit and the merge run's checks on #A, then closes it", async () => {
    const deps = conflictDeps(resolved());

    await runRound(testConfig, deps);

    const mergeSha = deps.git.remoteCommits.get("agent/40")!.at(-1)!.sha;
    expect(deps.github.issue(42)).toMatchObject({
      state: "CLOSED",
      labels: [],
      comments: [expect.stringContaining("已接單"), expect.stringMatching(new RegExp(`${mergeSha}[\\s\\S]*衝突[\\s\\S]*pnpm test run src/report[\\s\\S]*9 passed`))],
    });
  });

  it("not resolved: leaves agent/<S> untouched and opens a [WIP] draft PR from agent/<A> into agent/<S>", async () => {
    const deps = conflictDeps(reviewResult({ outcome: "wip", failedChecks: ["src/report.ts 的衝突解不掉"] }));
    const before = [...deps.git.remoteCommits.get("agent/40")!];

    await runRound(testConfig, deps);

    expect({
      integration: deps.git.remoteCommits.get("agent/40"),
      prs: deps.github.prs.map((p) => ({ base: p.base, head: p.head, draft: p.draft, title: p.title })),
    }).toEqual({ integration: before, prs: [{ base: "agent/40", head: "agent/42", draft: true, title: "[WIP] feat(report): 匯出" }] });
  });

  it("checks fail after resolving: keeps #A open and unassigned, with a comment saying it was a merge conflict and what failed", async () => {
    const deps = conflictDeps(reviewResult({ outcome: "wip", failedChecks: ["pnpm run typecheck"] }));

    await runRound(testConfig, deps);

    expect(deps.github.issue(42)).toMatchObject({
      state: "OPEN",
      labels: [],
      assignees: [],
      comments: [expect.stringContaining("已接單"), expect.stringMatching(/衝突[\s\S]*pull\/\d+[\s\S]*pnpm run typecheck/)],
    });
  });

  it("merge run says pass but agent/<S> holds no merge of agent/<A>: does not push agent/<S>, ends as [WIP]", async () => {
    const deps = conflictDeps(resolved());
    deps.sandbox.mergeless.add(42);
    const before = [...deps.git.remoteCommits.get("agent/40")!];

    await runRound(testConfig, deps);

    expect({ integration: deps.git.remoteCommits.get("agent/40"), state: deps.github.issue(42).state, prs: deps.github.prs.map((p) => [p.head, p.base]) }).toEqual({
      integration: before,
      state: "OPEN",
      prs: [["agent/42", "agent/40"]],
    });
  });

  it.each([
    { ending: "crash", merge: { throws: new Error("docker: container exited") }, reason: /docker: container exited/ },
    { ending: "timeout", merge: { throws: new DOMException("The operation timed out.", "TimeoutError") }, reason: /timeout/ },
  ])("merge run $ending: ends as a crash, agent/<S> untouched, no PR, #A open and unassigned", async ({ merge, reason }) => {
    const deps = conflictDeps(merge);
    const before = [...deps.git.remoteCommits.get("agent/40")!];

    await runRound(testConfig, deps);

    expect({
      integration: deps.git.remoteCommits.get("agent/40"),
      prs: deps.github.prs,
      issue: deps.github.issue(42),
      slack: deps.notifier.messages.at(-1),
    }).toMatchObject({
      integration: before,
      prs: [],
      issue: { state: "OPEN", labels: [], assignees: [], comments: [expect.stringContaining("已接單"), expect.stringMatching(reason)] },
      slack: expect.stringMatching(reason),
    });
  });

  it("is not blocked by a worktree of agent/<S> left behind by an earlier merge run", async () => {
    const deps = conflictDeps(resolved());
    deps.git.worktrees.push({ name: "agent-40", path: `${testConfig.botClonePath}/.sandcastle/worktrees/agent-40`, modifiedAt: deps.clock.now() });

    await runRound(testConfig, deps);

    expect({ merged: deps.git.remoteContains("agent/40", "agent/42"), closed: deps.github.issue(42).state }).toEqual({ merged: true, closed: "CLOSED" });
  });
});

describe("runRound — spec sub-issue: needs-info and crash leave agent/<S> alone", () => {
  it.each([
    { ending: "needs-info", run: passResult({ outcome: "needs-info", questions: ["要哪個欄位？"] }) },
    { ending: "crash", run: { throws: new Error("pnpm install failed") } },
  ])("does not create agent/<S> on $ending", async ({ run }) => {
    const deps = fakeDeps({ issues: [subIssue()], results: { 42: run } });

    await runRound(testConfig, deps);

    expect({ integration: deps.git.remoteBranches.has("agent/40"), prs: deps.github.prs }).toEqual({ integration: false, prs: [] });
  });

  it.each([
    { ending: "needs-info", run: passResult({ outcome: "needs-info", questions: ["要哪個欄位？"] }) },
    { ending: "crash", run: { throws: new Error("pnpm install failed") } },
  ])("does not change an existing agent/<S> on $ending", async ({ run }) => {
    const deps = fakeDeps({ issues: [subIssue()], results: { 42: run } });
    deps.git.humanPushes("agent/40", "henry5720");
    const before = [...deps.git.remoteCommits.get("agent/40")!];

    await runRound(testConfig, deps);

    expect(deps.git.remoteCommits.get("agent/40")).toEqual(before);
  });
});

describe("runRound — spec sub-issue: redo", () => {
  it("restarts agent/<A> from the latest agent/<S>, including commits pushed there since the last try", async () => {
    const deps = fakeDeps({ issues: [subIssue()], results: { 42: passResult({ outcome: "needs-info", questions: ["?"] }) } });
    deps.git.humanPushes("agent/40", "henry (agent)");
    await runRound(testConfig, deps);
    deps.git.humanPushes("agent/40", "henry5720");
    const latest = deps.git.remoteCommits.get("agent/40")!.at(-1)!;

    humanRequeues(deps, 42);
    deps.sandbox.script(42, passResult());
    await runRound(testConfig, deps);

    expect(deps.git.remoteContains("agent/40", "agent/42") && deps.git.localCommits.get("agent/42")!.includes(latest)).toBe(true);
  });

  it("does not stop for a human's commit on agent/<S> that agent/<A> was built on", async () => {
    const deps = fakeDeps({
      issues: [subIssue()],
      results: { 42: passResult() },
      reviews: { 42: reviewResult({ outcome: "wip", failedChecks: ["eslint"] }) },
    });
    deps.git.humanPushes("agent/40", "henry5720");
    await runRound(testConfig, deps);

    humanRequeues(deps, 42);
    deps.sandbox.script(42, passResult());
    await runRound(testConfig, deps);

    expect({ runs: deps.sandbox.runs.length, closed: deps.github.issue(42).state }).toEqual({ runs: 2, closed: "CLOSED" });
  });

  it("still stops and asks when a human committed on agent/<A> itself", async () => {
    const deps = fakeDeps({
      issues: [subIssue()],
      results: { 42: passResult() },
      reviews: { 42: reviewResult({ outcome: "wip", failedChecks: ["eslint"] }) },
    });
    await runRound(testConfig, deps);
    deps.git.humanPushes("agent/42", "henry5720");

    humanRequeues(deps, 42);
    await runRound(testConfig, deps);

    expect({ runs: deps.sandbox.runs.length, comment: deps.github.issue(42).comments.at(-1) }).toEqual({
      runs: 1,
      comment: expect.stringMatching(/沒有重接[\s\S]*origin\/agent\/40/),
    });
  });

  it("pushes the redone agent/<A> over its old [WIP] PR before merging, so that PR ends up in agent/<S>", async () => {
    const deps = fakeDeps({
      issues: [subIssue()],
      results: { 42: passResult() },
      reviews: { 42: reviewResult({ outcome: "wip", failedChecks: ["eslint"] }) },
    });
    await runRound(testConfig, deps);

    humanRequeues(deps, 42);
    deps.sandbox.script(42, passResult());
    await runRound(testConfig, deps);

    expect({
      remoteIsRedo: deps.git.remoteCommits.get("agent/42")?.map((c) => c.sha),
      merged: deps.git.remoteContains("agent/40", "agent/42"),
    }).toEqual({ remoteIsRedo: deps.git.localCommits.get("agent/42")!.map((c) => c.sha), merged: true });
  });
});

describe("runRound — spec sub-issue: what the agent gets", () => {
  it("hands the sandbox the parent spec's title and body along with the sub-issue", async () => {
    const deps = fakeDeps({ issues: [subIssue()], results: { 42: passResult() } });

    await runRound(testConfig, deps);

    expect(deps.sandbox.runs[0]?.issue).toMatchObject({ number: 42, parentTitle: "Spec: 匯出報表", parentBody: "整份 spec 的內文" });
  });
});
