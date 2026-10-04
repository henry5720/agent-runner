import { describe, expect, it } from "vitest";
import { runRound } from "../src/runRound.js";
import { fakeDeps, issue, passResult, reviewResult, testConfig } from "./support/fakes.js";

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

  it("leaves the issue with no runner labels, assigned to the operator, with a pickup comment", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult() } });

    await runRound(testConfig, deps);

    expect(deps.github.issue(42)).toMatchObject({
      labels: [],
      assignees: ["henry5720"],
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

    expect(deps.github.issue(7)).toMatchObject({ labels: ["ready-for-agent"], assignees: [], comments: [] });
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
      left: ["ready-for-agent"],
    });
  });
});
