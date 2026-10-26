import { z } from "zod";
import type { VerificationRunResult } from "./browserVerification.js";

/** agent 在 `<result>` 標籤裡回報的結構化結果（sandcastle `Output.object()` 驗證）。 */
export const implementResultSchema = z.object({
  outcome: z.enum(["pass", "wip", "needs-info"]),
  /** conventional commit subject，直接當 PR 標題 */
  prTitle: z.string(),
  /** 變更摘要（markdown） */
  summary: z.string(),
  /** 實際跑過的驗證指令與結果 */
  verification: z.array(z.object({ command: z.string(), result: z.string() })),
  unverified: z.array(z.object({ item: z.string().trim().min(1), reason: z.string().trim().min(1) })),
  /** 沒過的檢查（outcome = wip） */
  failedChecks: z.array(z.string()).default([]),
  /** 卡住的問題（outcome = needs-info） */
  questions: z.array(z.string()).default([]),
  /** 新增或升級的依賴，例如 `dayjs ^1.11.13（新增）`；PR body 會列出來 */
  dependencies: z.array(z.string()).default([]),
});

export type ImplementResult = z.infer<typeof implementResultSchema>;

/** reviewer run 與 merge run 共用的回報：重跑檢查的結果。merge run 的回報就是這個形狀。 */
export const checkResultSchema = z.object({
  /** 修正之後，重跑檢查的結果 */
  outcome: z.enum(["pass", "wip"]),
  /** 這次 run 改了什麼（markdown）；沒改就空字串 */
  summary: z.string(),
  /** 這次 run 最後重跑的驗證指令與結果 */
  verification: z.array(z.object({ command: z.string(), result: z.string() })),
  unverified: z.array(z.object({ item: z.string().trim().min(1), reason: z.string().trim().min(1) })),
  /** 重跑後仍沒過的檢查（outcome = wip） */
  failedChecks: z.array(z.string()).default([]),
  /** 新增或升級的依賴 */
  dependencies: z.array(z.string()).default([]),
});

export type CheckResult = z.infer<typeof checkResultSchema>;

/** reviewer run（乾淨 context 跑目標 repo 的 code-review）回報的結果。review 後重跑的檢查以這份為準；另外判這張單要不要做瀏覽器驗收。 */
export const reviewResultSchema = checkResultSchema.extend({
  /** 要不要做瀏覽器驗收：依 diff 有沒有碰到使用者看得到的畫面或操作 */
  browserVerify: z.object({ needed: z.boolean(), reason: z.string().trim().min(1) }),
});

export type ReviewResult = z.infer<typeof reviewResultSchema> & { browserVerification?: VerificationRunResult; browserVerificationFailure?: string };
