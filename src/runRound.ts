import type { Config } from "./config.js";
import { decide } from "./decide.js";
import { imageTag } from "./image.js";
import { failureReason, IN_PROGRESS_LABEL, removeOldWorktrees, wrapUpCrash, wrapUpNeedsInfo } from "./endings.js";
import { prBody } from "./prBody.js";
import type { Deps } from "./ports.js";
import type { Issue } from "./types.js";

const READY_LABEL = "ready-for-agent";

/**
 * 一輪：fetch → 刪超過 3 天的 worktree → 確認 image → 殘留 agent-in-progress 照 crash 收尾 → 列候選 → decide() → 一次一張處理。
 * 結局：全過開 draft PR；needs-info、timeout／crash 見 endings.ts。[WIP]、reviewer、Slack、flock、上限在其他票加。
 */
export async function runRound(config: Config, deps: Deps): Promise<void> {
  const { github, git, sandbox, clock } = deps;
  const baseRef = `origin/${config.baseBranch}`;

  await git.fetch();
  await removeOldWorktrees(deps);
  const tag = await ensureImage(config, deps, baseRef);

  // flock 保證同時只有一輪，所以這時還帶 agent-in-progress 的都是被硬殺的殘留；不重跑，照 crash 收尾
  for (const stale of await github.listInProgress()) {
    await wrapUpCrash(deps, stale.number, "上一輪 runner 被中斷（硬殺或關機），沒有收尾");
  }

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

async function handleIssue(config: Config, deps: Deps, issue: Issue, ctx: { tag: string; baseRef: string }) {
  const { github, git, sandbox } = deps;
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
  let result;
  try {
    result = await sandbox.implement({ imageTag: ctx.tag, issue, branch, baseRef: ctx.baseRef, signal });
  } catch (err) {
    return wrapUpCrash(deps, n, failureReason(err, signal, config.timeoutMinutes));
  }
  if (result.outcome === "needs-info") return wrapUpNeedsInfo(deps, n, result);
  if (result.outcome !== "pass") {
    // #2697（[WIP]）接手；先讓 agent-in-progress 留著給下一輪的殘留掃描
    throw new Error(`#${n}: outcome "${result.outcome}" 還沒有收尾流程`);
  }

  // 開 PR（push 和 gh 都在 host 做，sandbox 裡沒有 GH_TOKEN）
  await git.push(branch);
  await github.createPr({
    base: config.baseBranch,
    head: branch,
    title: result.prTitle,
    body: prBody(n, result),
    draft: true,
    assignee: config.operator,
  });
  await github.removeLabel(n, IN_PROGRESS_LABEL);
}
