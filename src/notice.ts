/**
 * 每張單收尾時發的 Slack 訊息（spec #2692 user story 38–39）：
 * 結局 emoji＋連到 issue 的單名、有 PR 才放 PR 連結、花多久、一句原因（全過不寫）。
 * 格式是 Slack mrkdwn：連結寫 `<url|文字>`，文字裡的 `& < >` 要跳脫。
 */
import { agentBranch } from "./names.js";

export type Ending =
  | { kind: "pass"; pr: { number: number; url: string } }
  | { kind: "wip"; pr: { number: number; url: string }; failedChecks: string[] }
  | { kind: "needs-info"; questions: string[] }
  | { kind: "crash"; reason: string; worktreePath?: string }
  /** 沒接單就停手（例如 agent/<N> 上有人手做的 commit） */
  | { kind: "stopped"; reason: string };

export interface NoticeInput {
  repo: string;
  issue: { number: number; title?: string };
  /** 接單到收尾；不知道（例如上一輪被硬殺的殘留）就不寫 */
  durationMs?: number;
  ending: Ending;
}

const EMOJI: Record<Ending["kind"], string> = { pass: "✅", wip: "🚧", "needs-info": "❓", crash: "💥", stopped: "✋" };

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} 分鐘`;
  return `${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分鐘`;
}

function reason(ending: Ending, issueNumber: number): string | undefined {
  switch (ending.kind) {
    case "pass":
      return undefined;
    case "wip":
      return `沒過：${ending.failedChecks.join("、") || "（reviewer 沒有列出是哪一項）"}`;
    case "needs-info":
      return `卡在：${ending.questions[0] ?? "（agent 沒有列出具體問題）"}`;
    case "stopped":
      return `原因：${ending.reason}`;
    case "crash":
      return `原因：${ending.reason}；${ending.worktreePath ? `worktree \`${ending.worktreePath}\`` : `沒有保留 worktree，commit 在分支 \`${agentBranch(issueNumber)}\``}`;
  }
}

export function noticeText({ repo, issue, durationMs, ending }: NoticeInput): string {
  const name = issue.title ? `#${issue.number} ${issue.title}` : `#${issue.number}`;
  const head = [
    `${EMOJI[ending.kind]} <https://github.com/${repo}/issues/${issue.number}|${escape(name)}>`,
    ...("pr" in ending ? [`PR <${ending.pr.url}|#${ending.pr.number}>`] : []),
    ...(durationMs === undefined ? [] : [duration(durationMs)]),
  ].join(" · ");
  const why = reason(ending, issue.number);
  return why ? `${head}\n${escape(why)}` : head;
}
