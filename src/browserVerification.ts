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

export interface VerificationRunResult {
  report: BrowserVerification;
  skillInvoked: boolean;
}

export async function browserVerificationSchema(config: Config) {
  const skill = config.sandboxSkills.find((s) => s.name === "verify-in-browser" && s.phases.includes("verify"));
  if (!skill) throw new Error("驗收 run 缺少 verify-in-browser allowlist");
  const jsonSchema = JSON.parse(await readFile(join(skill.hostPath, "result.schema.json"), "utf8"));
  return z.fromJSONSchema(jsonSchema) as z.ZodType<BrowserVerification>;
}

const cell = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("|", "&#124;").replace(/\r\n|\r|\n/g, "<br>");

export function browserVerificationText(report: BrowserVerification): string {
  const rows = report.criteria.map((c) => `| ${[c.criterion, c.status, c.account ?? "—", c.reason ? `${c.observed}／${c.reason}` : c.observed, c.evidence.join("、") || "—"].map(cell).join(" | ")} |`);
  return [
    `證據：${report.evidenceDir}（runner 主機本機，不在 git）`,
    ["| 條件 | 結果 | 帳號 | 看到什麼／原因 | 證據 |", "|---|---|---|---|---|", ...rows].join("\n"),
  ].join("\n\n");
}
