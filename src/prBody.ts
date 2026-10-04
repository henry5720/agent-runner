import type { ImplementResult, ReviewResult } from "./result.js";

type Verification = ImplementResult["verification"];

const list = (items: string[]) => items.map((i) => `- ${i}`).join("\n");
const commands = (v: Verification) => list(v.map((c) => `\`${c.command}\` → ${c.result}`));

/**
 * PR body 固定四段（spec user story 29）＋ Claude Code 署名。
 * `[WIP]` 多一段「沒過的檢查」（以 review 後那次為準）。依賴變動放在變更摘要裡；驗證分「實作後」和「review 後」兩組，review 後那組是最後一次檢查。
 */
export function prBody(issueNumber: number, impl: ImplementResult, review: ReviewResult): string {
  const dependencies = [...new Set([...impl.dependencies, ...review.dependencies])];
  const summary = [
    impl.summary,
    ...(review.summary.trim() ? [`### Review 修正\n\n${review.summary}`] : []),
    ...(dependencies.length ? [`### 依賴變動\n\n${list(dependencies)}`] : []),
  ].join("\n\n");

  const verification = [
    `### 實作後\n\n${commands(impl.verification) || "（agent 沒有回報任何驗證指令）"}`,
    `### review 後\n\n${commands(review.verification) || "（reviewer 沒有回報任何驗證指令）"}`,
  ].join("\n\n");

  return [
    `Closes #${issueNumber}`,
    `## 變更摘要\n\n${summary}`,
    `## 驗證（sandbox 內實際跑過）\n\n${verification}`,
    ...(review.outcome === "wip" ? [`## 沒過的檢查\n\n${list(review.failedChecks) || "（reviewer 沒有列出是哪一項）"}`] : []),
    `---\n\n由 sandcastle runner 自動產生。`,
    `🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
  ].join("\n\n");
}

/** PR 標題：agent 回報的 conventional commit subject；review 後檢查沒過就加 `[WIP] ` */
export function prTitle(impl: ImplementResult, review: ReviewResult): string {
  return review.outcome === "wip" ? `[WIP] ${impl.prTitle}` : impl.prTitle;
}
