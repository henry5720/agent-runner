import { readFileSync } from "node:fs";
import type { BrowserVerification } from "../src/browserVerification.js";
import { describe, expect, it } from "vitest";
import { prBody } from "../src/prBody.js";
import { passResult, reviewResult, verificationResult } from "./support/fakes.js";

describe("PR 瀏覽器驗收附註", () => {
  it("相關與不確定的 console error 列原文，無關的只列數量", () => {
    const browserVerification = verificationResult({ consoleErrors: [
      { text: "TypeError: cannot read user", related: "yes" },
      { text: "Failed <request>\nsecond line", related: "unknown" },
      { text: "不要逐條印出的既有錯誤", related: "no" },
      { text: "另一則既有錯誤", related: "no" },
    ] });
    const body = prBody(42, passResult(), reviewResult({ browserVerification }));
    expect(body).toContain("console error：\n- TypeError: cannot read user\n- Failed &lt;request&gt;<br>second line");
    expect(body).toContain("另有 2 則判定與本次 diff 無關");
    expect(body).not.toContain("不要逐條印出的既有錯誤");
    expect(body).not.toContain("另一則既有錯誤");
  });
  it.each([true, false])("寫判定 model，same_model=%s 時照實標示", (same_model) => {
    const body = prBody(42, passResult(), reviewResult({ browserVerification: verificationResult({ verifier: { model: "verifier-model", same_model } }) }));
    expect(body).toContain("判定 model：verifier-model");
    expect(body.includes("（與實作同一個 model）")).toBe(same_model);
  });

  it.each([0, 3])("stagingRecords=%s 時只列實際建立的資料", (stagingRecords) => {
    const body = prBody(42, passResult(), reviewResult({ browserVerification: verificationResult({ stagingRecords }) }));
    if (stagingRecords) expect(body).toContain("在 staging 建了 3 筆資料，清單在 /state/evidence/run/state.json");
    else expect(body).not.toContain("在 staging 建了");
  });

  it.each(["issue", "inferred"] as const)("criteriaSource=%s 時標示條件來源", (criteriaSource) => {
    const body = prBody(42, passResult(), reviewResult({ browserVerification: verificationResult({ criteriaSource }) }));
    expect(body.includes("issue 沒有 ## Acceptance criteria，以下條件由 agent 從內文推出")).toBe(criteriaSource === "inferred");
  });

  // agent-config 5a0ebc6 的人工預期 fixture，同一份契約在兩個呼叫端呈現一致。
  it.each(["mixed", "issue", "unverifiable"])("%s 報告與 skill render script 的預期完全一致", (name) => {
    const report: BrowserVerification = JSON.parse(readFileSync(new URL(`./fixtures/browser-report/${name}.json`, import.meta.url), "utf8"));
    const expected = readFileSync(new URL(`./fixtures/browser-report/${name}.md`, import.meta.url), "utf8");
    const body = prBody(42, passResult(), reviewResult({ browserVerification: { report, skillInvoked: true } }));
    expect(body.split("## 瀏覽器驗收")[1]?.split("\n\n---")[0]?.trim()).toBe(expected.replace("## 瀏覽器驗收", "").trim());
  });

});
