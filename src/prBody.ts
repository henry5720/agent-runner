import { agentBranch } from "./names.js";
import type { ImplementResult, ReviewResult } from "./result.js";

type Verification = ImplementResult["verification"];

const list = (items: string[]) => items.map((i) => `- ${i}`).join("\n");
const commands = (v: Verification) => list(v.map((c) => `\`${c.command}\` → ${c.result}`));

/**
 * PR body 固定四段＋ Claude Code 署名（draft 階段沒有 CI 燈號，人只能靠 body 判斷這張 PR）。
 * `[WIP]` 多一段「沒過的檢查」（以 review 後那次為準）。依賴變動放在變更摘要裡；驗證分「實作後」和「review 後」兩組，review 後那組是最後一次檢查。
 */
export function prBody(issueNumber: number, impl: ImplementResult, review: ReviewResult): string {
  const dependencies = [...new Set([...impl.dependencies, ...review.dependencies])];
  const summary = [
    impl.summary,
    ...(review.summary.trim() ? [`### Review 修正\n\n${review.summary}`] : []),
    ...(dependencies.length ? [`### 依賴變動\n\n${list(dependencies)}`] : []),
  ].join("\n\n");

  const verification = verificationText(impl, review);

  return [
    `Closes #${issueNumber}`,
    `## 變更摘要\n\n${summary}`,
    `## 驗證（sandbox 內實際跑過）\n\n${verification}`,
    ...(review.outcome === "wip" ? [`## 沒過的檢查\n\n${list(review.failedChecks) || "（reviewer 沒有列出是哪一項）"}`] : []),
    `---\n\n由 sandcastle runner 自動產生。`,
    `🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
  ].join("\n\n");
}

/** 驗證分「實作後」和「review 後」兩組，review 後那組是最後一次檢查；合併衝突由 merge run 解掉時多一組「解完合併衝突後」，那組才是最後一次 */
export function verificationText(impl: ImplementResult, review: ReviewResult, heading = "###", resolution?: ReviewResult): string {
  return [
    `${heading} 實作後\n\n${commands(impl.verification) || "（agent 沒有回報任何驗證指令）"}`,
    `${heading} review 後\n\n${commands(review.verification) || "（reviewer 沒有回報任何驗證指令）"}`,
    ...(resolution ? [`${heading} 解完合併衝突後\n\n${commands(resolution.verification) || "（merge run 沒有回報任何驗證指令）"}`] : []),
  ].join("\n\n");
}

/** 一張合進整合分支的 sub-issue，在整合分支 PR body 裡的一段 */
export interface MergedSubIssue {
  number: number;
  title: string;
  /** 合併後 agent/<S> 的 HEAD */
  sha: string;
  impl: ImplementResult;
  review: ReviewResult;
  /** 合併有衝突、由 merge run 解掉時的回報 */
  resolution?: ReviewResult;
}

const entryPattern = /<!-- sub-issue #(\d+) -->[\s\S]*?<!-- \/sub-issue #\1 -->/g;

/**
 * 整合分支 `agent/<S>` → base 的 draft PR body：`Closes #S` → 每張合進來的 sub-issue 一段（合進來的順序）→ 署名。
 * 每段用 HTML 註解標起來，下一張合進來時從現有 body 撈回前面的段落再整份重寫；同一張重做就換掉它那段。段落以外人改的字會被蓋掉。
 */
export function specPrBody(spec: number, previousBody: string | null, merged: MergedSubIssue): string {
  const entries = [...(previousBody ?? "").matchAll(entryPattern)].map((m) => ({ number: Number(m[1]), text: m[0] }));
  const text = [
    `<!-- sub-issue #${merged.number} -->`,
    `### #${merged.number} ${merged.title}`,
    `合併後的 commit \`${merged.sha}\``,
    merged.impl.summary,
    ...(merged.review.summary.trim() ? [`**Review 修正**\n\n${merged.review.summary}`] : []),
    ...(merged.resolution ? [`**合併衝突**（由 agent 解掉）${merged.resolution.summary.trim() ? `\n\n${merged.resolution.summary}` : ""}`] : []),
    verificationText(merged.impl, merged.review, "####", merged.resolution),
    `<!-- /sub-issue #${merged.number} -->`,
  ].join("\n\n");
  const at = entries.findIndex((e) => e.number === merged.number);
  if (at >= 0) entries[at] = { number: merged.number, text };
  else entries.push({ number: merged.number, text });

  return [
    `Closes #${spec}`,
    `## 已合進整合分支的 sub-issue\n\nrunner 一張一張合進 \`${agentBranch(spec)}\`，每張合進來就關掉。這張 PR 一直是 draft，什麼時候轉 ready 由人決定。`,
    ...entries.map((e) => e.text),
    `---\n\n由 sandcastle runner 自動產生。`,
    `🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
  ].join("\n\n");
}

/** PR 標題：agent 回報的 conventional commit subject；review 後檢查沒過就加 `[WIP] ` */
export function prTitle(impl: ImplementResult, review: ReviewResult): string {
  return review.outcome === "wip" ? `[WIP] ${impl.prTitle}` : impl.prTitle;
}
