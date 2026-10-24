import { describe, expect, it } from "vitest";
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
});
