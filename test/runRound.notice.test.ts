import { describe, expect, it } from "vitest";
import { runRound } from "../src/runRound.js";
import { fakeDeps, humanRequeues, issue, passResult, reviewResult, testConfig } from "./support/fakes.js";

describe("runRound — Slack notice per issue", () => {
  it("all checks pass: emoji, linked title, PR link, duration, no reason", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42, title: "匯出按鈕" })], results: { 42: passResult() }, minutesPerRun: 12 });

    await runRound(testConfig, deps);

    expect(deps.notifier.messages).toEqual([
      "✅ <https://github.com/acme/widgets/issues/42|#42 匯出按鈕> · PR <https://github.com/acme/widgets/pull/1000|#1000> · 12 分鐘",
    ]);
  });

  it("[WIP]: names the checks that still fail after review", async () => {
    const deps = fakeDeps({
      issues: [issue({ number: 42, title: "匯出按鈕" })],
      results: { 42: passResult() },
      reviews: { 42: reviewResult({ outcome: "wip", failedChecks: ["pnpm run typecheck", "pnpm test run src/x"] }) },
      minutesPerRun: 35,
    });

    await runRound(testConfig, deps);

    expect(deps.notifier.messages).toEqual([
      "🚧 <https://github.com/acme/widgets/issues/42|#42 匯出按鈕> · PR <https://github.com/acme/widgets/pull/1000|#1000> · 35 分鐘\n沒過：pnpm run typecheck、pnpm test run src/x",
    ]);
  });

  it("needs-info: no PR link, gives the first open question", async () => {
    const deps = fakeDeps({
      issues: [issue({ number: 42, title: "匯出按鈕" })],
      results: { 42: passResult({ outcome: "needs-info", questions: ["按鈕要放在哪一頁？", "格式是 CSV 嗎？"] }) },
      minutesPerRun: 5,
    });

    await runRound(testConfig, deps);

    expect(deps.notifier.messages).toEqual(["❓ <https://github.com/acme/widgets/issues/42|#42 匯出按鈕> · 5 分鐘\n卡在：按鈕要放在哪一頁？"]);
  });

  it("crash: no PR link, gives the reason and the kept worktree path", async () => {
    const deps = fakeDeps({
      issues: [issue({ number: 42, title: "匯出按鈕" })],
      results: { 42: { throws: new Error("container exited 137"), leavesWorktree: true } },
      minutesPerRun: 61,
    });

    await runRound(testConfig, deps);

    expect(deps.notifier.messages).toEqual([
      "💥 <https://github.com/acme/widgets/issues/42|#42 匯出按鈕> · 1 小時 1 分鐘\n原因：container exited 137；worktree `/bot/widgets/.sandcastle/worktrees/agent-42`",
    ]);
  });

  it("stopped because agent/<N> has someone else's commit: no PR link, gives the stop reason", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42, title: "匯出按鈕" })], results: { 42: passResult() } });
    await runRound(testConfig, deps);
    deps.git.humanPushes("agent/42", "henry5720");
    humanRequeues(deps, 42);
    deps.notifier.messages.length = 0;

    await runRound(testConfig, deps);

    expect(deps.notifier.messages).toEqual([
      "✋ <https://github.com/acme/widgets/issues/42|#42 匯出按鈕>\n原因：`agent/42` 上有不是 runner 做的 commit（author：henry5720），沒有重接",
    ]);
  });

  it("escapes Slack control characters in the issue title", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42, title: "a <b> & c" })], results: { 42: passResult() } });

    await runRound(testConfig, deps);

    expect(deps.notifier.messages[0]).toContain("|#42 a &lt;b&gt; &amp; c>");
  });

  it("a Slack failure leaves the issue's ending alone and the round carries on", async () => {
    const deps = fakeDeps({
      issues: [issue({ number: 42 }), issue({ number: 43 })],
      results: { 42: passResult({ outcome: "needs-info", questions: ["缺規格"] }), 43: passResult() },
    });
    deps.notifier.notify = async () => {
      throw new Error("Slack webhook 500");
    };

    await runRound(testConfig, deps);

    expect({ labels: deps.github.issue(42).labels, prs: deps.github.prs.map((pr) => pr.head) }).toEqual({ labels: ["needs-info"], prs: ["agent/43"] });
  });
});
