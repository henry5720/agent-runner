import { describe, expect, it } from "vitest";
import { prBody, specPrBody, verificationText } from "../src/prBody.js";
import { implementResultSchema, reviewResultSchema } from "../src/result.js";
import { passResult, reviewResult } from "./support/fakes.js";

describe("verification reporting", () => {
  it("renders actual commands and unverified items with reasons for both runs", () => {
    const impl = passResult({ unverified: [{ item: "UI 停用狀態", reason: "缺少角色資料" }] });
    const review = reviewResult({ unverified: [{ item: "browser", reason: "沒有 browser CLI" }] });
    const body = prBody(42, impl, review);
    expect(body).toContain("## 驗證\n");
    expect(body).toContain("`pnpm test run src/demo` → 3 passed");
    expect(body).toContain("**未驗**");
    expect(body).toContain("UI 停用狀態：缺少角色資料");
    expect(body).toContain("browser：沒有 browser CLI");
  });

  it("preserves previous integration entries and reports merge-run unverified items", () => {
    const first = { number: 42, title: "first", sha: "abc", impl: passResult(), review: reviewResult() };
    const previous = specPrBody(40, null, first);
    const body = specPrBody(40, previous, {
      ...first,
      number: 43,
      title: "second",
      resolution: reviewResult({ unverified: [{ item: "實際寄信", reason: "避免外部寫入" }] }),
    });
    expect(body.match(/^## 驗證$/gm)).toHaveLength(1);
    expect(body).toContain("### #42 first");
    expect(body).toContain("### #43 second");
    expect(body).toContain("#### 解完合併衝突後");
    expect(body).toContain("實際寄信：避免外部寫入");
  });

  it("does not invent verification evidence when no commands were reported", () => {
    const text = verificationText(passResult({ verification: [] }), reviewResult());
    expect(text).toContain("沒有回報任何驗證指令");
    expect(text).not.toContain("passed");
  });

  it("requires an explicit unverified array rather than silently defaulting missing reports", () => {
    const { unverified: omitted, ...missing } = passResult();
    expect(implementResultSchema.safeParse(missing).success).toBe(false);
    const { unverified: reviewOmitted, ...reviewMissing } = reviewResult();
    expect(reviewResultSchema.safeParse(reviewMissing).success).toBe(false);
    expect(implementResultSchema.safeParse(passResult()).success).toBe(true);
  });

  it("rejects empty unverified items or reasons", () => {
    expect(reviewResultSchema.safeParse(reviewResult({ unverified: [{ item: "UI", reason: " " }] })).success).toBe(false);
    expect(implementResultSchema.safeParse(passResult({ unverified: [{ item: "", reason: "缺少工具" }] })).success).toBe(false);
  });
});
