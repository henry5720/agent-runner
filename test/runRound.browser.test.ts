import { describe, expect, it } from "vitest";
import { InvalidVerificationResultError } from "../src/browserVerification.js";
import { runRound } from "../src/runRound.js";
import { fakeDeps, issue, passResult, reviewResult, testConfig, verificationResult } from "./support/fakes.js";

describe("runRound — browser verification", () => {
  it("opens a draft PR with the criteria table after the reviewer requests verification", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult() }, reviews: { 42: reviewResult({ browserVerify: { needed: true, reason: "刪除互動" } }) } });
    deps.sandbox.verificationResults[42] = verificationResult();
    await runRound(testConfig, deps);
    expect(deps.github.prs[0]).toMatchObject({ draft: true, title: "feat(demo): do the thing" });
    expect(deps.github.prs[0]?.body).toContain("| 條件 | 結果 | 帳號 | 看到什麼／原因 | 證據 |");
    expect(deps.github.prs[0]?.body).toContain("| 刪除後出現 toast | passed | E2E | 顯示刪除成功 | toast.png |");
  });

  it("keeps skipped-only criteria out of WIP and gives all runs the same deadline", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult() }, reviews: { 42: reviewResult({ browserVerify: { needed: true, reason: "權限畫面" } }) }, verifications: { 42: verificationResult({ criteria: [{ criterion: "管理員可刪除", observed: "缺管理員帳號", status: "skipped", reason: "缺 E2E_ADMIN_EMAIL", account: "E2E_ADMIN", evidence: [] }] }) } });
    await runRound(testConfig, deps);
    expect(deps.github.prs[0]?.title).toBe("feat(demo): do the thing");
    expect(deps.github.prs[0]?.body).toContain("| 管理員可刪除 | skipped | E2E_ADMIN | 缺管理員帳號／缺 E2E_ADMIN_EMAIL | — |");
    expect(deps.sandbox.verifications[0]?.signal).toBe(deps.sandbox.runs[0]?.signal);
    expect(deps.sandbox.verifications[0]?.signal).toBe(deps.sandbox.reviews[0]?.signal);
    expect(deps.sandbox.verifications[0]?.evidenceDir).toMatch(/^\/state\/evidence\/42-/);
  });

  it.each(["pass", "wip"] as const)("does not start verification when the reviewer returns %s and says it is unnecessary", async (outcome) => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult() }, reviews: { 42: reviewResult({ outcome }) } });
    await runRound(testConfig, deps);
    expect(deps.sandbox.verifications).toEqual([]);
    expect(deps.github.prs[0]?.body).toContain(outcome === "wip" ? "reviewer 回 wip，沒有起驗收 run" : "不驗：沒有碰到畫面或操作（reviewer 判斷）");
  });
  it("marks each failed criterion as WIP without claiming the reviewer skipped verification", async () => {
    const deps = fakeDeps({
      issues: [issue({ number: 42 })], results: { 42: passResult() },
      reviews: { 42: reviewResult({ browserVerify: { needed: true, reason: "刪除互動" } }) },
      verifications: { 42: verificationResult({ criteria: [
        { criterion: "刪除後出現 toast", observed: "沒有 toast", status: "failed", reason: "缺刪除成功提示", account: "E2E", evidence: ["delete.png"] },
        { criterion: "清單移除該筆", observed: "該筆仍在", status: "failed", reason: "清單未更新", account: "E2E", evidence: ["list.png"] },
      ] }) },
    });
    await runRound(testConfig, deps);
    expect(deps.github.prs[0]).toMatchObject({ title: "[WIP] feat(demo): do the thing", draft: true });
    expect(deps.github.prs[0]?.body).toContain("- 刪除後出現 toast：缺刪除成功提示");
    expect(deps.github.prs[0]?.body).toContain("- 清單移除該筆：清單未更新");
    expect(deps.github.prs[0]?.body).toContain("| 刪除後出現 toast | failed |");
    expect(deps.github.prs[0]?.body).not.toContain("reviewer 回 wip，沒有起驗收 run");
    expect(deps.github.issue(42).assignees).toEqual([]);
  });

  it("reports environment failure as unverifiable WIP with its own reason", async () => {
    const deps = fakeDeps({
      issues: [issue({ number: 42 })], results: { 42: passResult() },
      reviews: { 42: reviewResult({ browserVerify: { needed: true, reason: "登入流程" } }) },
      verifications: { 42: verificationResult({ status: "unverifiable", unverifiableReason: "dev server 起不來", criteria: [] }) },
    });
    await runRound(testConfig, deps);
    expect(deps.github.prs[0]?.title).toBe("[WIP] feat(demo): do the thing");
    expect(deps.github.prs[0]?.body).toContain("瀏覽器驗收驗不了：dev server 起不來");
    expect(deps.github.prs[0]?.body).toContain("驗不了：dev server 起不來");
    expect(deps.github.prs[0]?.body).not.toContain("| 條件 |");
    expect(deps.github.prs[0]?.body).not.toContain("驗收 run 沒交出合格結果");
  });

  it("turns malformed verification output into WIP instead of a crash or unverifiable result", async () => {
    const deps = fakeDeps({
      issues: [issue({ number: 42 })], results: { 42: passResult() },
      reviews: { 42: reviewResult({ browserVerify: { needed: true, reason: "畫面" } }) },
      verifications: { 42: { throws: new InvalidVerificationResultError() } },
    });
    await runRound(testConfig, deps);
    expect(deps.github.prs[0]?.title).toBe("[WIP] feat(demo): do the thing");
    expect(deps.github.prs[0]?.body).toContain("驗收 run 沒交出合格結果");
    expect(deps.github.prs[0]?.body).not.toContain("瀏覽器驗收驗不了");
    expect(deps.github.prs[0]?.body).not.toContain("reviewer 回 wip");
  });

  it("does not trust a report when verify-in-browser was never invoked", async () => {
    const deps = fakeDeps({
      issues: [issue({ number: 42 })], results: { 42: passResult() },
      reviews: { 42: reviewResult({ browserVerify: { needed: true, reason: "畫面" } }) },
      verifications: { 42: { ...verificationResult(), skillInvoked: false } },
    });
    await runRound(testConfig, deps);
    expect(deps.github.prs[0]?.title).toBe("[WIP] feat(demo): do the thing");
    expect(deps.github.prs[0]?.body).toContain("驗收 run 沒有呼叫 verify-in-browser，結果不採信");
    expect(deps.github.prs[0]?.body).not.toContain("| 刪除後出現 toast | passed |");
  });

  it.each([
    { error: new DOMException("deadline", "TimeoutError"), reason: "超過 60 分鐘上限（timeout）" },
    { error: new Error("container exited 137"), reason: "container exited 137" },
    { error: new Error("驗收 run 沒交出合格結果"), reason: "驗收 run 沒交出合格結果" },
  ])("keeps verification timeout and ordinary errors on the crash path: $reason", async ({ error, reason }) => {
    const deps = fakeDeps({
      issues: [issue({ number: 42 })], results: { 42: passResult() },
      reviews: { 42: reviewResult({ browserVerify: { needed: true, reason: "畫面" } }) },
      verifications: { 42: { throws: error } },
    });
    await runRound(testConfig, deps);
    expect(deps.github.prs).toEqual([]);
    expect(deps.github.issue(42)).toMatchObject({ labels: [], assignees: [], comments: [expect.anything(), expect.stringContaining(reason)] });
  });

  it("gives off --now precedence even when invalid output is reported at the same time", async () => {
    const deps = fakeDeps({
      issues: [issue({ number: 42 })], results: { 42: passResult() },
      reviews: { 42: reviewResult({ browserVerify: { needed: true, reason: "畫面" } }) },
    });
    const stop = new AbortController();
    deps.stopSignal = stop.signal;
    deps.sandbox.verify = async () => {
      stop.abort();
      throw new InvalidVerificationResultError();
    };
    await runRound(testConfig, deps);
    expect(deps.github.prs).toEqual([]);
    expect(deps.github.issue(42).comments[1]).toContain("被 `agent-runner off --now` 立刻停下");
  });

});
