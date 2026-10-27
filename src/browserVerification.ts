import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";

/** schema 的唯一來源是 allowlist 裡 verify-in-browser skill 的 result.schema.json。 */
export interface BrowserVerification {
  sha: string;
  status: "verified" | "unverifiable";
  unverifiableReason: string | null;
  evidenceDir: string;
  verifier: { model: string; same_model: boolean };
  criteriaSource: "issue" | "inferred";
  criteria: { criterion: string; observed: string; status: "passed" | "failed" | "skipped"; reason: string | null; account: string | null; evidence: string[] }[];
  consoleErrors: { text: string; related: "yes" | "no" | "unknown" }[];
  stagingRecords: number;
}

/** 驗收 run 沒有合格的結構化結果；環境錯誤、timeout 與一般 crash 不使用此類別。 */
export class InvalidVerificationResultError extends Error {
  constructor(options?: ErrorOptions) {
    super("驗收 run 沒交出合格結果", options);
    this.name = "InvalidVerificationResultError";
  }
}

export interface VerificationRunResult {
  report: BrowserVerification;
  skillInvoked: boolean;
}

export async function browserVerificationSchema(config: Config) {
  const skill = config.sandboxSkills.find((s) => s.name === "verify-in-browser" && s.phases.includes("verify"));
  if (!skill) throw new Error("驗收 run 缺少 verify-in-browser allowlist");
  const jsonSchema = JSON.parse(await readFile(join(skill.hostPath, "result.schema.json"), "utf8"));
  const schema = z.fromJSONSchema(jsonSchema) as z.ZodType<BrowserVerification>;
  // 與 skill 的 render CLI 相同：shape 用共用 draft-07，跨欄位規則交給 StandardSchema 驗證與重交。
  return schema.superRefine((report, context) => {
    const reject = (message: string) => context.addIssue({ code: "custom", message });
    if (report.status === "unverifiable") {
      if (report.criteria.length || !report.unverifiableReason) reject("unverifiable 必須寫原因且 criteria 為空");
    } else if (report.unverifiableReason !== null || !report.criteria.length) {
      reject("verified 必須有 criteria，unverifiableReason 為 null");
    }
    if (report.status === "verified" && report.criteriaSource === "inferred" && (report.criteria.length < 1 || report.criteria.length > 3)) reject("inferred 必須有 1～3 條條件");
    for (const criterion of report.criteria) {
      if (criterion.status === "passed" && (!criterion.evidence.length || criterion.reason !== null)) reject("passed 必須有證據，reason 為 null");
      if ((criterion.status === "failed" || criterion.status === "skipped") && !criterion.reason) reject("failed、skipped 必須寫 reason");
    }
  });
}

/** 瀏覽器驗收段的「證據：」那行；prEvidence 靠它找到本次 run 的段落，兩邊都要用這個 builder。 */
export const evidenceDirLine = (directory: string) => `證據：${directory}（runner 主機本機，不在 git）`;

const cell = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("|", "&#124;").replace(/\r\n|\r|\n/g, "<br>");

export function browserVerificationText(report: BrowserVerification): string {
  const rows = report.criteria.map((c) => `| ${[c.criterion, c.status, c.account ?? "—", c.reason ? `${c.observed}／${c.reason}` : c.observed, c.evidence.join("、") || "—"].map(cell).join(" | ")} |`);
  const related = report.consoleErrors.filter((error) => error.related !== "no");
  const unrelated = report.consoleErrors.length - related.length;
  const console = [
    ...(related.length ? ["console error：", ...related.map((error) => `- ${cell(error.text)}`)] : []),
    ...(unrelated ? [`另有 ${unrelated} 則判定與本次 diff 無關`] : []),
  ].join("\n");
  return [
    evidenceDirLine(report.evidenceDir),
    report.status === "unverifiable"
      ? `驗不了：${report.unverifiableReason}`
      : ["| 條件 | 結果 | 帳號 | 看到什麼／原因 | 證據 |", "|---|---|---|---|---|", ...rows].join("\n"),
    ...(console ? [console] : []),
    `判定 model：${report.verifier.model}${report.verifier.same_model ? "（與實作同一個 model）" : ""}`,
    ...(report.stagingRecords ? [`在 staging 建了 ${report.stagingRecords} 筆資料，清單在 ${report.evidenceDir}/state.json`] : []),
    ...(report.criteriaSource === "inferred" ? ["issue 沒有 ## Acceptance criteria，以下條件由 agent 從內文推出"] : []),
  ].join("\n\n");
}
