import { describe, expect, it } from "vitest";
import { runRound } from "../src/runRound.js";
import { fakeDeps, humanRequeues, issue, passResult, reviewResult, testConfig } from "./support/fakes.js";
import type { ImplementResult } from "../src/result.js";
import type { Issue } from "../src/types.js";

describe("runRound — happy path", () => {
  it("opens a draft PR into dev from agent/<N>, assigned to the operator, closing the issue", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult({ prTitle: "feat(x): add y" }) } });

    await runRound(testConfig, deps);

    expect(deps.github.prs).toEqual([
      expect.objectContaining({
        base: "dev",
        head: "agent/42",
        draft: true,
        title: "feat(x): add y",
        assignee: "henry5720",
        body: expect.stringContaining("Closes #42"),
      }),
    ]);
  });

  it("leaves the issue with no runner labels, the operator still assigned, and a pickup comment", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult() } });

    await runRound(testConfig, deps);

    expect(deps.github.issue(42)).toMatchObject({
      labels: [],
      assignees: [testConfig.operator],
      comments: [expect.stringContaining("已接單")],
    });
  });

  it("creates the agent-in-progress label when the repo does not have it", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult() } });

    await runRound(testConfig, deps);

    expect(deps.github.repoLabels).toContain("agent-in-progress");
  });

  it("pushes agent/<N> starting from origin/dev before opening the PR", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult() } });

    await runRound(testConfig, deps);

    expect(deps.git.remoteBranches.get("agent/42")).toEqual({ base: "origin/dev", fetchedFirst: true });
  });

  it("writes the summary and the verification commands the agent reported into the PR body", async () => {
    const deps = fakeDeps({
      issues: [issue({ number: 42 })],
      results: {
        42: passResult({
          summary: "加了 y 按鈕",
          verification: [{ command: "pnpm test run src/app/modules/x", result: "12 passed" }],
        }),
      },
    });

    await runRound(testConfig, deps);

    const body = deps.github.prs[0]?.body ?? "";
    expect([body.includes("加了 y 按鈕"), body.includes("pnpm test run src/app/modules/x"), body.includes("12 passed")]).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("gives the sandbox the issue it picked and only the agent/<N> branch", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42, title: "加 y", body: "請加 y" })], results: { 42: passResult() } });

    await runRound(testConfig, deps);

    expect(deps.sandbox.runs).toEqual([
      expect.objectContaining({ branch: "agent/42", issue: expect.objectContaining({ number: 42, title: "加 y", body: "請加 y" }) }),
    ]);
  });

  it("does not touch issues that decide() did not pick", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 7, author: "someone-else" })], results: {} });

    await runRound(testConfig, deps);

    expect(deps.github.issue(7)).toMatchObject({ labels: ["agent-runner"], assignees: [], comments: [] });
  });
});

describe("runRound — sandbox image", () => {
  it("builds the image when the tag for the current Dockerfile + .nvmrc is missing, and runs on it", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult() }, nvmrc: "22.16.0" });

    await runRound(testConfig, deps);

    expect(deps.sandbox.builtImages).toEqual([{ tag: deps.sandbox.runs[0]?.imageTag, nodeVersion: "22.16.0" }]);
  });

  it("does not rebuild an image that already exists", async () => {
    const first = fakeDeps({ issues: [], results: {} });
    await runRound(testConfig, first);
    const existing = first.sandbox.builtImages[0]!.tag;

    const deps = fakeDeps({ issues: [], results: {}, images: [existing] });
    await runRound(testConfig, deps);

    expect(deps.sandbox.builtImages).toEqual([]);
  });
});

describe("runRound — reviewer run", () => {
  it("runs a second, separate review run on the same agent/<N> branch under the same per-issue signal", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult() } });

    await runRound(testConfig, deps);

    const [impl] = deps.sandbox.runs;
    expect(deps.sandbox.reviews).toEqual([expect.objectContaining({ branch: "agent/42", issue: expect.objectContaining({ number: 42 }) })]);
    expect(deps.sandbox.reviews[0]?.signal).toBe(impl?.signal);
  });

  it("writes what the reviewer fixed and the checks re-run after review into the PR body", async () => {
    const deps = fakeDeps({
      issues: [issue({ number: 42 })],
      results: { 42: passResult() },
      reviews: {
        42: reviewResult({ summary: "補上空陣列的邊界判斷", verification: [{ command: "pnpm run typecheck", result: "0 errors" }] }),
      },
    });

    await runRound(testConfig, deps);

    const body = deps.github.prs[0]?.body ?? "";
    expect([body.includes("補上空陣列的邊界判斷"), body.includes("pnpm run typecheck"), body.includes("0 errors")]).toEqual([true, true, true]);
  });

  it("lists dependencies added or upgraded by either run in the PR body", async () => {
    const deps = fakeDeps({
      issues: [issue({ number: 42 })],
      results: { 42: passResult({ dependencies: ["dayjs ^1.11.13（新增）"] }) },
      reviews: { 42: reviewResult({ dependencies: ["zod ^4.6.5（升級）"] }) },
    });

    await runRound(testConfig, deps);

    const body = deps.github.prs[0]?.body ?? "";
    expect([body.includes("dayjs ^1.11.13（新增）"), body.includes("zod ^4.6.5（升級）")]).toEqual([true, true]);
  });

  it("keeps the four fixed sections and the Claude Code attribution in a passing PR body, without a dependency section when none changed", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult() } });

    await runRound(testConfig, deps);

    const body = deps.github.prs[0]?.body ?? "";
    expect({
      closes: body.startsWith("Closes #42"),
      summary: body.includes("## 變更摘要"),
      verification: body.includes("## 驗證"),
      generated: body.includes("由 sandcastle runner 自動產生"),
      attribution: body.trimEnd().endsWith("🤖 Generated with [Claude Code](https://claude.com/claude-code)"),
      dependencies: body.includes("依賴變動"),
      failed: body.includes("## 沒過的檢查"),
    }).toEqual({ closes: true, summary: true, verification: true, generated: true, attribution: true, dependencies: false, failed: false });
  });
});

describe("runRound — [WIP]", () => {
  it("opens a [WIP] draft PR listing the checks that still fail after review", async () => {
    const deps = fakeDeps({
      issues: [issue({ number: 42 })],
      results: { 42: passResult({ prTitle: "feat(x): add y" }) },
      reviews: { 42: reviewResult({ outcome: "wip", failedChecks: ["pnpm run typecheck：2 errors in src/x.ts"] }) },
    });

    await runRound(testConfig, deps);

    expect(deps.github.prs).toEqual([
      expect.objectContaining({
        base: "dev",
        head: "agent/42",
        draft: true,
        title: "[WIP] feat(x): add y",
        assignee: "henry5720",
        body: expect.stringMatching(/## 沒過的檢查\s+- pnpm run typecheck：2 errors in src\/x\.ts/),
      }),
    ]);
  });

  it("comments the PR link on the issue and leaves no runner labels", async () => {
    const deps = fakeDeps({
      issues: [issue({ number: 42 })],
      results: { 42: passResult() },
      reviews: { 42: reviewResult({ outcome: "wip", failedChecks: ["eslint"] }) },
    });

    await runRound(testConfig, deps);

    const prUrl = deps.github.prs[0]?.url;
    expect(deps.github.issue(42)).toMatchObject({
      labels: [],
      comments: [expect.stringContaining("已接單"), expect.stringContaining(prUrl!)],
    });
  });

  it("still runs the reviewer when the implementation run reported wip, and drops [WIP] if the review fixes it", async () => {
    const deps = fakeDeps({
      issues: [issue({ number: 42 })],
      results: { 42: passResult({ outcome: "wip", prTitle: "fix(x): y", failedChecks: ["pnpm test run src/x"] }) },
      reviews: { 42: reviewResult({ outcome: "pass" }) },
    });

    await runRound(testConfig, deps);

    expect(deps.github.prs.map((p) => [p.title, p.body.includes("## 沒過的檢查")])).toEqual([["fix(x): y", false]]);
  });
});

describe("runRound — pick filters", () => {
  it("works through at most maxPerRound issues per round, lowest number first, leaving the rest ready", async () => {
    const deps = fakeDeps({
      issues: [issue({ number: 30 }), issue({ number: 7 }), issue({ number: 12 })],
      results: { 7: passResult(), 12: passResult(), 30: passResult() },
    });

    await runRound({ ...testConfig, maxPerRound: 2 }, deps);

    expect({ prs: deps.github.prs.map((p) => p.head), left: deps.github.issue(30).labels }).toEqual({
      prs: ["agent/7", "agent/12"],
      left: ["agent-runner"],
    });
  });
});

describe("runRound — re-pickup", () => {
  it("keeps the operator assigned after a pass ending, so the issue is not re-picked until a human unassigns it", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult() }, reviews: { 42: reviewResult() } });
    await runRound(testConfig, deps);
    expect(deps.github.issue(42).assignees).toEqual([testConfig.operator]);

    deps.github.issue(42).labels.push("agent-runner");
    await runRound(testConfig, deps);
    expect(deps.sandbox.runs.map((r) => r.issue.number)).toEqual([42]);

    deps.github.issue(42).assignees = [];
    deps.sandbox.script(42, passResult());
    await runRound(testConfig, deps);
    expect(deps.sandbox.runs.map((r) => r.issue.number)).toEqual([42, 42]);
  });

  it.each([
    { ending: "[WIP]", first: passResult(), review: reviewResult({ outcome: "wip", failedChecks: ["eslint"] }) },
    { ending: "needs-info", first: passResult({ outcome: "needs-info", questions: ["要哪個欄位？"] }), review: reviewResult() },
    { ending: "crash", first: { throws: new Error("pnpm install failed") }, review: reviewResult() },
  ])("can pick the same issue again after a $ending ending once a human puts agent-runner back", async ({ first, review }) => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: first }, reviews: { 42: review } });
    await runRound(testConfig, deps);
    expect(deps.github.issue(42).assignees).toEqual([]);

    humanRequeues(deps, 42);
    deps.sandbox.script(42, passResult());
    await runRound(testConfig, deps);

    expect(deps.sandbox.runs.map((r) => r.issue.number)).toEqual([42, 42]);
  });

  it("drops needs-info when a human puts agent-runner back on a needs-info issue, starting over", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult({ outcome: "needs-info", questions: ["要哪個欄位？"] }) } });
    await runRound(testConfig, deps);

    humanRequeues(deps, 42);
    deps.sandbox.script(42, passResult());
    await runRound(testConfig, deps);

    expect({ labels: deps.github.issue(42).labels, prs: deps.github.prs.map((p) => p.head) }).toEqual({ labels: [], prs: ["agent/42"] });
  });

  it("keeps the same PR, updating its title and body, and drops [WIP] once everything passes", async () => {
    const deps = fakeDeps({
      issues: [issue({ number: 42 })],
      results: { 42: passResult({ prTitle: "feat(x): add y" }) },
      reviews: { 42: reviewResult({ outcome: "wip", failedChecks: ["eslint"] }) },
    });
    await runRound(testConfig, deps);

    humanRequeues(deps, 42);
    deps.sandbox.script(42, passResult({ prTitle: "feat(x): add y properly", summary: "第二次做" }), reviewResult());
    await runRound(testConfig, deps);

    expect(deps.github.prs.map((p) => ({ head: p.head, title: p.title, draft: p.draft, secondTry: p.body.includes("第二次做"), wip: p.body.includes("## 沒過的檢查") }))).toEqual([
      { head: "agent/42", title: "feat(x): add y properly", draft: true, secondTry: true, wip: false },
    ]);
  });

  it("turns a PR the operator already marked ready back into a draft before pushing, so the redo does not run CI", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult() } });
    await runRound(testConfig, deps);
    const pr = deps.github.prs[0]!;
    pr.draft = false;

    humanRequeues(deps, 42);
    await runRound(testConfig, deps);

    expect({ draft: pr.draft, ciRuns: deps.github.ciRuns }).toEqual({ draft: true, ciRuns: [] });
  });

  it("throws away the half-done agent-<N> worktree and restarts agent/<N> from origin/dev", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult() } });
    await runRound(testConfig, deps);
    deps.git.worktrees.push({ name: "agent-42", path: "/bot/widgets/.sandcastle/worktrees/agent-42", modifiedAt: deps.clock.now() });
    deps.git.localBranches.set("agent/42", { base: "half-done", fetchedFirst: true });

    humanRequeues(deps, 42);
    await runRound(testConfig, deps);

    expect({ runs: deps.sandbox.runs.length, worktrees: deps.git.worktrees, remote: deps.git.remoteBranches.get("agent/42")?.base }).toEqual({
      runs: 2,
      worktrees: [],
      remote: "origin/dev",
    });
  });

  it("stops and asks when agent/<N> has a commit by someone other than the runner, leaving the branch and PR alone", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult({ prTitle: "feat(x): first" }) } });
    await runRound(testConfig, deps);
    deps.git.remoteAuthors.get("agent/42")!.push("henry5720");
    const remoteBefore = deps.git.remoteBranches.get("agent/42");

    humanRequeues(deps, 42);
    deps.sandbox.script(42, passResult({ prTitle: "feat(x): second" }));
    await runRound(testConfig, deps);

    expect({
      runs: deps.sandbox.runs.length,
      remote: deps.git.remoteBranches.get("agent/42"),
      prTitles: deps.github.prs.map((p) => p.title),
      issue: deps.github.issue(42),
    }).toEqual({
      runs: 1,
      remote: remoteBefore,
      prTitles: ["feat(x): first"],
      issue: expect.objectContaining({
        labels: [],
        assignees: [],
        comments: [expect.stringContaining("已接單"), expect.stringMatching(/henry5720[\s\S]*agent-runner/)],
      }),
    });
  });
});

describe("runRound — overlapping rounds", () => {
  it("ends the round without touching anything when another round holds the lock", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult() } });
    deps.lock.heldByOther = true;

    await runRound(testConfig, deps);

    expect([deps.github.prs, deps.github.issue(42).labels]).toEqual([[], ["agent-runner"]]);
  });

  it("releases the lock when the round ends", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult() } });

    await runRound(testConfig, deps);

    expect(deps.lock.held).toBe(false);
  });
});

describe("runRound — what status shows as running", () => {
  it("shows the issue as running while the sandbox works on it", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42, title: "加 y" })], results: { 42: passResult() } });
    let shownDuringRun: unknown;
    const implement = deps.sandbox.implement.bind(deps.sandbox);
    deps.sandbox.implement = async (req) => {
      shownDuringRun = deps.runState.current;
      return implement(req);
    };

    await runRound(testConfig, deps);

    expect(shownDuringRun).toEqual({ number: 42, title: "加 y" });
  });

  it("shows nothing running after the round ends", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult() } });

    await runRound(testConfig, deps);

    expect(deps.runState.current).toBeNull();
  });

  it("shows nothing running after an issue fails mid-round", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: {} });

    await runRound(testConfig, deps).catch(() => {});

    expect(deps.runState.current).toBeNull();
  });
});

describe("runRound — switched off mid-round", () => {
  it("finishes the issue it is on but picks no more once the runner is switched off", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 }), issue({ number: 43 })], results: { 42: passResult(), 43: passResult() } });
    const implement = deps.sandbox.implement.bind(deps.sandbox);
    deps.sandbox.implement = async (req) => {
      deps.power.on = false; // `agent-runner off` 或 08:00 自動關，發生在 #42 做到一半
      return implement(req);
    };

    await runRound(testConfig, deps);

    expect([deps.github.prs.map((pr) => pr.head), deps.github.issue(43).labels]).toEqual([["agent/42"], ["agent-runner"]]);
  });

  it("does not start the next issue when the first one ran into the last hour before auto-off", async () => {
    // Mon 06:30 Taipei：開頭離 08:00 還有 90 分鐘；#42 做完已經 07:30
    const deps = fakeDeps({
      issues: [issue({ number: 42 }), issue({ number: 43 })],
      results: { 42: passResult(), 43: passResult() },
      now: new Date("2026-10-04T22:30:00Z"),
    });
    const implement = deps.sandbox.implement.bind(deps.sandbox);
    deps.sandbox.implement = async (req) => {
      deps.clock.current = new Date("2026-10-04T23:30:00Z");
      return implement(req);
    };

    await runRound(testConfig, deps);

    expect(deps.github.issue(43).labels).toEqual(["agent-runner"]);
  });

  it("picks nothing when the runner was switched off before the round started", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult() } });
    deps.power.on = false;

    await runRound(testConfig, deps);

    expect(deps.github.issue(42).labels).toEqual(["agent-runner"]);
  });
});

describe("runRound — off --now", () => {
  const stoppedMidIssue = (issues: Issue[], results: Record<number, ImplementResult>) => {
    const stop = new AbortController();
    const deps = { ...fakeDeps({ issues, results }), stopSignal: stop.signal };
    const implement = deps.sandbox.implement.bind(deps.sandbox);
    deps.sandbox.implement = async (req) => {
      stop.abort(); // `agent-runner off --now` 在 sandbox 做到一半
      req.signal.throwIfAborted(); // 跟真的 sandcastle 一樣：signal 一 abort 就以 reason reject
      return implement(req);
    };
    return deps;
  };

  it("ends the issue it is on as a crash that says it was stopped by off --now", async () => {
    const deps = stoppedMidIssue([issue({ number: 42 })], { 42: passResult() });

    await runRound(testConfig, deps);

    expect([deps.github.prs, deps.github.issue(42).labels, deps.github.issue(42).comments.at(-1)]).toEqual([
      [],
      [],
      expect.stringContaining("off --now"),
    ]);
  });

  it("picks no further issue after being stopped", async () => {
    const deps = stoppedMidIssue([issue({ number: 42 }), issue({ number: 43 })], { 42: passResult(), 43: passResult() });

    await runRound(testConfig, deps);

    expect(deps.github.issue(43).labels).toEqual(["agent-runner"]);
  });
});
