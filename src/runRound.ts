import type { Config } from "./config.js";
import { decide } from "./decide.js";
import { imageTag } from "./image.js";
import { failureReason, IN_PROGRESS_LABEL, removeOldWorktrees, wrapUpCrash, wrapUpNeedsInfo } from "./endings.js";
import { type Ending, noticeText } from "./notice.js";
import { prBody, prTitle } from "./prBody.js";
import type { Deps } from "./ports.js";
import type { Issue } from "./types.js";

const READY_LABEL = "ready-for-agent";

/**
 * 一輪：拿鎖（拿不到就結束）→ fetch → 刪超過 3 天的 worktree → 確認 image → 殘留 agent-in-progress 照 crash 收尾 → 列候選 → decide()（含 maxPerRound 上限、自動關前不接）→ 一次一張處理。
 * 結局：全過／`[WIP]` 開 draft PR；needs-info、timeout／crash 見 endings.ts。每張單收尾後發一則 Slack（notice.ts）。
 */
export async function runRound(config: Config, deps: Deps): Promise<void> {
  const release = await deps.lock.tryAcquire();
  if (!release) return;
  try {
    await runLockedRound(config, deps);
  } finally {
    await release();
  }
}

async function runLockedRound(config: Config, deps: Deps): Promise<void> {
  const { github, git, clock } = deps;
  const baseRef = `origin/${config.baseBranch}`;

  await git.fetch();
  await removeOldWorktrees(deps);
  const tag = await ensureImage(config, deps, baseRef);

  // flock 保證同時只有一輪，所以這時還帶 agent-in-progress 的都是被硬殺的殘留；不重跑，照 crash 收尾
  for (const stale of await github.listInProgress()) {
    const reason = "上一輪 runner 被中斷（硬殺或關機），沒有收尾";
    const worktreePath = await wrapUpCrash(deps, stale.number, reason);
    await notify(config, deps, { issue: stale, ending: { kind: "crash", reason, worktreePath } });
  }

  const candidates = await github.listCandidates();
  const snapshot = {
    operator: config.operator,
    candidates,
    maxPerRound: config.maxPerRound,
    autoOff: config.autoOff,
    timeoutMinutes: config.timeoutMinutes,
  };
  const actions = decide(snapshot, clock.now());

  for (const action of actions) {
    switch (action.kind) {
      case "pickup": {
        // 關掉（手動 off 或 08:00 自動關）之後不接新單；正在做的那張已經做完了
        if (deps.stopSignal.aborted || !(await deps.power.isOn())) return;
        // 前一張做完時間已經過了，再問一次 decide（例如已經進入自動關前的最後一個 timeout）
        if (!decide({ ...snapshot, candidates: [action.issue] }, clock.now()).length) return;
        await deps.runState.setCurrent({ number: action.issue.number, title: action.issue.title });
        const startedAt = clock.now().getTime();
        let ending;
        try {
          ending = await handleIssue(config, deps, action.issue, { tag, baseRef });
        } finally {
          await deps.runState.setCurrent(null);
        }
        await notify(config, deps, { issue: action.issue, durationMs: clock.now().getTime() - startedAt, ending });
        break;
      }
    }
  }
}

/** Slack 是通知，不是結局的一部分：發不出去只記 log，不影響這張單或下一張 */
async function notify(config: Config, { notifier }: Deps, input: { issue: { number: number; title?: string }; durationMs?: number; ending: Ending }) {
  try {
    await notifier.notify(noticeText({ repo: config.repo, ...input }));
  } catch (err) {
    console.error(`[notify] #${input.issue.number} Slack 通知失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}

async function ensureImage(config: Config, { git, sandbox }: Deps, baseRef: string): Promise<string> {
  const nvmrc = await git.showFile(baseRef, config.nvmrcPath);
  const tag = imageTag(config.imageName, await sandbox.dockerfile(), nvmrc);
  if (!(await sandbox.imageExists(tag))) await sandbox.buildImage({ tag, nodeVersion: nvmrc.trim() });
  return tag;
}

async function handleIssue(config: Config, deps: Deps, issue: Issue, ctx: { tag: string; baseRef: string }): Promise<Ending> {
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
  const timeout = AbortSignal.timeout(config.timeoutMinutes * 60_000);
  // off --now 也走同一個 signal：sandcastle abort 時會 docker stop + rm 自己的 container
  const signal = AbortSignal.any([timeout, deps.stopSignal]);
  // reviewer run：乾淨 context 跑 code-review、可 commit 修正、最後重跑檢查。實作回報 wip 也跑（reviewer 可能修好）；
  // 最後的結局以 review 後的檢查為準。兩次 run 任一次 timeout／crash 都照 crash 收尾
  let result, review;
  try {
    result = await sandbox.implement({ imageTag: ctx.tag, issue, branch, baseRef: ctx.baseRef, signal });
    if (result.outcome === "needs-info") {
      await wrapUpNeedsInfo(deps, n, result);
      return { kind: "needs-info", questions: result.questions };
    }
    review = await sandbox.review({ imageTag: ctx.tag, issue, branch, baseRef: ctx.baseRef, signal });
  } catch (err) {
    const reason = deps.stopSignal.aborted ? "被 `agent-runner off --now` 立刻停下" : failureReason(err, timeout, config.timeoutMinutes);
    return { kind: "crash", reason, worktreePath: await wrapUpCrash(deps, n, reason) };
  }

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
  return review.outcome === "wip" ? { kind: "wip", pr, failedChecks: review.failedChecks } : { kind: "pass", pr };
}
