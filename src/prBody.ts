import { agentBranch } from "./names.js";
import type { CheckResult, ImplementResult, ReviewResult } from "./result.js";

type Verification = ImplementResult["verification"];
type Unverified = ImplementResult["unverified"];

const list = (items: string[]) => items.map((i) => `- ${i}`).join("\n");
const commands = (v: Verification) => list(v.map((c) => `\`${c.command}\` → ${c.result}`));
const unverified = (v: Unverified) => list(v.map((c) => `${c.item}：${c.reason}`));

/**
 * PR body 固定五段＋ Claude Code 署名（draft 階段沒有 CI 燈號，人只能靠 body 判斷這張 PR）。
 * 「瀏覽器驗收」段永遠在，分得出沒驗是 reviewer 刻意判的、還是漏掉。
 * `[WIP]` 多一段「沒過的檢查」（以 review 後那次為準）。依賴變動放在變更摘要裡；驗證分「實作後」和「review 後」兩組，review 後那組是最後一次檢查。
 * `reviewed` 是 reviewer 原本回的結果：合併衝突解不掉時 runner 會把 `review` 改成 wip，但「瀏覽器驗收」段仍照 reviewer 的判斷寫。
 */
export function prBody(issueNumber: number, impl: ImplementResult, review: ReviewResult, reviewed: ReviewResult = review): string {
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
    `## 驗證\n\n${verification}`,
    `## 瀏覽器驗收\n\n${browserVerifyText(reviewed)}`,
    ...(review.outcome === "wip" ? [`## 沒過的檢查\n\n${list(review.failedChecks) || "（reviewer 沒有列出是哪一項）"}`] : []),
    `---\n\n由 sandcastle runner 自動產生。`,
    `🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
  ].join("\n\n");
}

/** reviewer 回 wip 就不起驗收 run；needed 時驗收 run 還沒接上，先留佔位 */
function browserVerifyText(review: ReviewResult): string {
  if (review.outcome === "wip") return "reviewer 回 wip，沒有起驗收 run";
  if (!review.browserVerify.needed) return `不驗：${review.browserVerify.reason}（reviewer 判斷）`;
  return "待驗收 run 接上";
}

/** 驗證分「實作後」和「review 後」兩組，review 後那組是最後一次檢查；合併衝突由 merge run 解掉時多一組「解完合併衝突後」，那組才是最後一次 */
export function verificationText(impl: ImplementResult, review: CheckResult, heading = "###", resolution?: CheckResult): string {
  const section = (label: string, result: ImplementResult | CheckResult) =>
    [
      `${heading} ${label}`,
      commands(result.verification) || "（沒有回報任何驗證指令）",
      ...(result.unverified.length ? [`**未驗**\n\n${unverified(result.unverified)}`] : []),
    ].join("\n\n");

  return [
    section("實作後", impl),
    section("review 後", review),
    ...(resolution ? [section("解完合併衝突後", resolution)] : []),
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
  resolution?: CheckResult;
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
    `**驗證**\n\n${verificationText(merged.impl, merged.review, "####", merged.resolution)}`,
    `<!-- /sub-issue #${merged.number} -->`,
  ].join("\n\n");
  const at = entries.findIndex((e) => e.number === merged.number);
  if (at >= 0) entries[at] = { number: merged.number, text };
  else entries.push({ number: merged.number, text });

  return [
    `Closes #${spec}`,
    `## 已合進整合分支的 sub-issue\n\nrunner 一張一張合進 \`${agentBranch(spec)}\`，每張合進來就關掉。這張 PR 一直是 draft，什麼時候轉 ready 由人決定。`,
    `## 驗證\n\n以下依 sub-issue 列出 sandbox 實際執行的指令、結果與未驗項目。`,
    ...entries.map((e) => e.text),
    `---\n\n由 sandcastle runner 自動產生。`,
    `🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
  ].join("\n\n");
}

/** PR 標題：agent 回報的 conventional commit subject；review 後檢查沒過就加 `[WIP] ` */
export function prTitle(impl: ImplementResult, review: ReviewResult): string {
  return review.outcome === "wip" ? `[WIP] ${impl.prTitle}` : impl.prTitle;
}
