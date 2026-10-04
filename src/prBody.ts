import type { ImplementResult } from "./result.js";

/** PR body 固定四段（spec user story 29）＋ Claude Code 署名。 */
export function prBody(issueNumber: number, result: ImplementResult): string {
  const verification = result.verification.map((v) => `- \`${v.command}\` → ${v.result}`).join("\n");
  return [
    `Closes #${issueNumber}`,
    `## 變更摘要\n\n${result.summary}`,
    `## 驗證（sandbox 內實際跑過）\n\n${verification || "（agent 沒有回報任何驗證指令）"}`,
    `---\n\n由 sandcastle runner 自動產生。`,
    `🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
  ].join("\n\n");
}
