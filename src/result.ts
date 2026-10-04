import { z } from "zod";

/** agent 在 `<result>` 標籤裡回報的結構化結果（sandcastle `Output.object()` 驗證）。 */
export const implementResultSchema = z.object({
  outcome: z.enum(["pass", "wip", "needs-info"]),
  /** conventional commit subject，直接當 PR 標題 */
  prTitle: z.string(),
  /** 變更摘要（markdown） */
  summary: z.string(),
  /** 實際跑過的驗證指令與結果 */
  verification: z.array(z.object({ command: z.string(), result: z.string() })),
  /** 沒過的檢查（outcome = wip） */
  failedChecks: z.array(z.string()).default([]),
  /** 卡住的問題（outcome = needs-info） */
  questions: z.array(z.string()).default([]),
});

export type ImplementResult = z.infer<typeof implementResultSchema>;
