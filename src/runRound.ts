import type { Config } from "./config.js";
import { decide } from "./decide.js";
import { imageTag } from "./image.js";
import { prBody, prTitle } from "./prBody.js";
import type { Deps } from "./ports.js";
import type { Issue } from "./types.js";

export const IN_PROGRESS_LABEL = "agent-in-progress";
const READY_LABEL = "ready-for-agent";

/**
 * 一輪：fetch → 確認 image → 列候選 → decide() → 一次一張處理。
 * 目前有全過與 `[WIP]` 兩種結局；needs-info／timeout／crash 收尾、Slack、flock、上限在後面的票加。
 */
export async function runRound(config: Config, deps: Deps): Promise<void> {
  const { github, git, sandbox, clock } = deps;
  const baseRef = `origin/${config.baseBranch}`;

  await git.fetch();
  const tag = await ensureImage(config, deps, baseRef);

  const candidates = await github.listCandidates();
  const actions = decide({ operator: config.operator, candidates }, clock.now());

  for (const action of actions) {
    switch (action.kind) {
      case "pickup":
        await handleIssue(config, deps, action.issue, { tag, baseRef });
        break;
    }
  }
}

async function ensureImage(config: Config, { git, sandbox }: Deps, baseRef: string): Promise<string> {
  const nvmrc = await git.showFile(baseRef, config.nvmrcPath);
  const tag = imageTag(config.imageName, await sandbox.dockerfile(), nvmrc);
  if (!(await sandbox.imageExists(tag))) await sandbox.buildImage({ tag, nodeVersion: nvmrc.trim() });
  return tag;
}

async function handleIssue(config: Config, { github, git, sandbox }: Deps, issue: Issue, ctx: { tag: string; baseRef: string }) {
  const n = issue.number;
  const branch = `agent/${n}`;

  // 接單
  await github.createLabel(IN_PROGRESS_LABEL, { color: "fbca04", description: "sandcastle runner 正在做這張單" });
  await github.removeLabel(n, READY_LABEL);
  await github.addLabel(n, IN_PROGRESS_LABEL);
  await github.assign(n, config.operator);
  await github.comment(n, `🤖 已接單：runner 開始在 sandbox 裡實作，分支 \`${branch}\`。`);

  // 實作（整張單共用一個 timeout）
  await git.resetBranch(branch, ctx.baseRef);
  const signal = AbortSignal.timeout(config.timeoutMinutes * 60_000);
  const result = await sandbox.implement({ imageTag: ctx.tag, issue, branch, baseRef: ctx.baseRef, signal });
  if (result.outcome === "needs-info") {
    // #2698（needs-info／timeout／crash）接手；先讓 agent-in-progress 留著給下一輪的殘留掃描
    throw new Error(`#${n}: outcome "${result.outcome}" 還沒有收尾流程`);
  }

  // reviewer run：乾淨 context 跑 code-review、可 commit 修正、最後重跑檢查。實作回報 wip 也跑（reviewer 可能修好）；
  // 最後的結局以 review 後的檢查為準
  const review = await sandbox.review({ imageTag: ctx.tag, issue, branch, baseRef: ctx.baseRef, signal });

  // 開 PR（push 和 gh 都在 host 做，sandbox 裡沒有 GH_TOKEN）
  await git.push(branch);
  const pr = await github.createPr({
    base: config.baseBranch,
    head: branch,
    title: prTitle(result, review),
    body: prBody(n, result, review),
    draft: true,
    assignee: config.operator,
  });
  if (review.outcome === "wip") {
    await github.comment(n, `🤖 有檢查沒過，開了 \`[WIP]\` draft PR，可以從那裡接手：${pr.url}\n\n沒過的檢查：\n\n${review.failedChecks.map((c) => `- ${c}`).join("\n")}`);
  }
  await github.removeLabel(n, IN_PROGRESS_LABEL);
}
