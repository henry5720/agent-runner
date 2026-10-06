import type { Config } from "./config.js";
import { decide, specOf } from "./decide.js";
import { wantedImage } from "./image.js";
import { failureReason, releaseIssue, removeOldWorktrees, wrapUpCrash, wrapUpNeedsInfo } from "./endings.js";
import { agentBranch, IN_PROGRESS_LABEL, NEEDS_INFO_LABEL, RUNNER_LABEL, worktreeName } from "./names.js";
import { type Ending, noticeText } from "./notice.js";
import { prBody, prTitle, specPrBody, verificationText } from "./prBody.js";
import type { Deps } from "./ports.js";
import type { ImplementResult, ReviewResult } from "./result.js";
import type { Issue } from "./types.js";

/**
 * 一輪：拿鎖（拿不到就結束）→ fetch → 刪超過 3 天的 worktree → 確認 image → 列殘留 agent-in-progress 與候選 → decide() → 照動作一個一個做。
 * decide() 決定做什麼（殘留照 crash 收尾、問人、接單，含 maxPerRound 上限、自動關前不接）；這裡只負責做。
 * 結局：全過／`[WIP]` 開 draft PR；needs-info、timeout／crash（含做完卻沒 commit）見 endings.ts。每張單收尾後發一則 Slack（notice.ts）。
 * spec 的 sub-issue（parent 不是 wayfinder:map）走整合分支 agent/<S>：agent/<A> 從 origin/agent/<S> 開；全過就 `git merge --no-edit`
 * 合進 agent/<S>、開或更新 agent/<S> → base 的 draft PR、留言後關 #A；`[WIP]` 和合併衝突開 PR 進 agent/<S>。
 * 重接：沿用 agent/<N> 與開著的 PR；agent/<N> 相對它的起點有人手做的 commit 就停手問人（人在 agent/<S> 上的 commit 不算）。
 * 全過以外的結局都要拿掉接單時 assign 的操作者（endings.ts releaseIssue），不然人貼回 agent-runner 也接不到；
 * 全過的留著：一般 issue 等 PR merge 才關，spec 的 sub-issue 已經關掉、留著當紀錄。
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

  const inProgress = await github.listInProgress();
  const candidates = await github.listCandidates();
  // 每張候選的 agent/<N> 從哪裡開：一般 issue 從 origin/<baseBranch>；spec 的 sub-issue 從整合分支 origin/agent/<S>（還沒建就從 base）
  const startRefs = new Map(await Promise.all(candidates.map(async (i) => [i.number, await startRef(deps, i, baseRef)] as const)));
  const snapshot = {
    operator: config.operator,
    candidates,
    inProgress,
    maxPerRound: config.maxPerRound,
    autoOff: config.autoOff,
    timeoutMinutes: config.timeoutMinutes,
    runnerAuthor: config.gitAuthor,
    branchAuthors: Object.fromEntries(
      await Promise.all(candidates.map(async (i) => [i.number, await git.branchAuthors(agentBranch(i.number), startRefs.get(i.number)!)] as const)),
    ),
  };
  const actions = decide(snapshot, clock.now());

  for (const action of actions) {
    switch (action.kind) {
      case "wrap-up-leftover": {
        const reason = "上一輪 runner 被中斷（硬殺或關機），沒有收尾";
        const worktreePath = await wrapUpCrash(deps, config.operator, action.issue.number, reason);
        await notify(config, deps, { issue: action.issue, ending: { kind: "crash", reason, worktreePath } });
        break;
      }
      case "ask-about-foreign-commits": {
        const reason = await askAboutForeignCommits(github, action.issue.number, action.authors, startRefs.get(action.issue.number)!);
        await notify(config, deps, { issue: action.issue, ending: { kind: "stopped", reason } });
        break;
      }
      case "pickup": {
        // 關掉（手動 off 或 autoOff 自動關）之後不接新單；正在做的那張已經做完了
        if (deps.stopSignal.aborted || !(await deps.power.isOn())) return;
        // 前一張做完時間已經過了，再問一次 decide（例如已經進入自動關前的最後一個 timeout）
        if (!decide({ ...snapshot, candidates: [action.issue], inProgress: [] }, clock.now()).some((a) => a.kind === "pickup")) return;
        await deps.runState.setCurrent({ number: action.issue.number, title: action.issue.title });
        const startedAt = clock.now().getTime();
        let ending;
        try {
          ending = await handleIssue(config, deps, action.issue, { tag, baseRef: startRefs.get(action.issue.number)! });
        } finally {
          await deps.runState.setCurrent(null);
        }
        await notify(config, deps, { issue: action.issue, durationMs: clock.now().getTime() - startedAt, ending });
        break;
      }
    }
  }
}

/** agent/<N> 的起點；「有別人的 commit」也只看 agent/<N> 相對這裡，人在整合分支上的 commit 不算 */
async function startRef({ git }: Deps, issue: Issue, baseRef: string): Promise<string> {
  const spec = specOf(issue);
  if (spec === null) return baseRef;
  const integration = agentBranch(spec);
  return (await git.hasRemoteBranch(integration)) ? `origin/${integration}` : baseRef;
}

/** Slack 是通知，不是結局的一部分：發不出去只記 log，不影響這張單或下一張 */
async function notify(config: Config, { notifier }: Deps, input: { issue: { number: number; title?: string }; durationMs?: number; ending: Ending }) {
  try {
    await notifier.notify(noticeText({ repo: config.repo, ...input }));
  } catch (err) {
    console.error(`[notify] #${input.issue.number} Slack 通知失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}

async function ensureImage(config: Config, deps: Deps, baseRef: string): Promise<string> {
  const { tag, nodeVersion } = await wantedImage(config, deps, baseRef);
  if (!(await deps.sandbox.imageExists(tag))) await deps.sandbox.buildImage({ tag, nodeVersion });
  return tag;
}

async function handleIssue(config: Config, deps: Deps, issue: Issue, ctx: { tag: string; baseRef: string }): Promise<Ending> {
  const { github, git, sandbox } = deps;
  const n = issue.number;
  const branch = agentBranch(n);

  // 接單。重接 needs-info 的單是從頭來過（label 狀態機），needs-info 一起拿掉
  await github.createLabel(IN_PROGRESS_LABEL, { color: "fbca04", description: "sandcastle runner 正在做這張單" });
  await github.removeLabel(n, RUNNER_LABEL);
  if (issue.labels.includes(NEEDS_INFO_LABEL)) await github.removeLabel(n, NEEDS_INFO_LABEL);
  await github.addLabel(n, IN_PROGRESS_LABEL);
  await github.assign(n, config.operator);
  await github.comment(n, `🤖 已接單：runner 開始在 sandbox 裡實作，分支 \`${branch}\`。`);

  // 實作（整張單共用一個 timeout）。重接時舊的 worktree 會被 sandcastle 重用，先刪掉再從 base 重來
  const leftover = (await git.listWorktrees()).find((w) => w.name === worktreeName(branch));
  if (leftover) await git.removeWorktree(leftover.path);
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
      await wrapUpNeedsInfo(deps, config.operator, n, result);
      return { kind: "needs-info", questions: result.questions };
    }
    review = await sandbox.review({ imageTag: ctx.tag, issue, branch, baseRef: ctx.baseRef, signal });
  } catch (err) {
    const reason = deps.stopSignal.aborted ? "被 `agent-runner off --now` 立刻停下" : failureReason(err, timeout, config.timeoutMinutes);
    return { kind: "crash", reason, worktreePath: await wrapUpCrash(deps, config.operator, n, reason) };
  }

  // agent 說做完但 branch 上什麼都沒有：不 push（重接時會用空 branch 蓋掉開著的 PR），照 crash 收尾
  if (!(await git.hasCommits(branch, ctx.baseRef))) {
    const reason = "agent 回報完成但 branch 上沒有 commit";
    return { kind: "crash", reason, worktreePath: await wrapUpCrash(deps, config.operator, n, reason) };
  }

  const spec = specOf(issue);
  // 一般 issue：agent/<N> 開 PR 進 base，等 PR merge 才關
  if (spec === null) return openAgentPr(config, deps, issue, result, review, config.baseBranch);

  // spec 的 sub-issue：全過就合進整合分支 agent/<S> 並關掉；[WIP] 和合併衝突開 PR 進 agent/<S>
  const integration = agentBranch(spec);
  await ensureIntegrationBranch(config, deps, integration);
  if (review.outcome === "wip") return openAgentPr(config, deps, issue, result, review, integration);
  // 之前 WIP 開過的 agent/<A> PR：先把新的 agent/<A> push 上去，合進整合分支後 GitHub 會把那張標成 merged
  const stale = await github.findOpenPr(branch);
  if (stale) {
    if (!stale.isDraft) await github.markPrDraft(stale.number);
    await git.push(branch);
  }
  const merge = await git.mergeInto(integration, branch);
  if (merge.kind === "merged") return closeIntoSpec(config, deps, issue, spec, merge.sha, result, review);
  // 衝突：merge 已 abort、agent/<S> 沒動，照 WIP 收尾
  const conflict = `\`git merge --no-edit\` 合進 \`${integration}\` 有衝突，沒有合併`;
  return openAgentPr(config, deps, issue, result, { ...review, outcome: "wip", failedChecks: [conflict] }, integration, `🤖 檢查都過了，但${conflict}`);
}

/**
 * 開或更新 agent/<N> 的 draft PR 進 `base`（一般 issue 是 baseBranch，spec 的 sub-issue 是整合分支）。
 * 全過的留著操作者 assignee（等 PR merge 才關）；[WIP] 留言附 PR、拿掉 assignee。`wipLead` 換掉 WIP 留言的第一句（例如合併衝突）
 */
async function openAgentPr(
  config: Config,
  deps: Deps,
  issue: Issue,
  result: ImplementResult,
  review: ReviewResult,
  base: string,
  wipLead = "🤖 有檢查沒過",
): Promise<Ending> {
  const n = issue.number;
  // push 和 gh 都在 host 做，sandbox 裡沒有 GH_TOKEN
  const pr = await pushWithDraftPr(config, deps, { head: agentBranch(n), base, title: prTitle(result, review), body: prBody(n, result, review) });
  if (review.outcome === "wip") {
    await deps.github.comment(
      n,
      `${wipLead}，開了 \`[WIP]\` draft PR 進 \`${base}\`，可以從那裡接手：${pr.url}\n\n沒過的檢查：\n\n${review.failedChecks.map((c) => `- ${c}`).join("\n")}`,
    );
  }
  await releaseIssue(deps, config.operator, n, { keepAssignee: review.outcome !== "wip" });
  return review.outcome === "wip" ? { kind: "wip", pr, failedChecks: review.failedChecks } : { kind: "pass", pr };
}

/** 整合分支到要用時才建（第一張全過或 [WIP]；needs-info、crash 不碰它）：從 origin/<baseBranch> 開 */
async function ensureIntegrationBranch(config: Config, { git }: Deps, integration: string): Promise<void> {
  if (await git.hasRemoteBranch(integration)) return;
  await git.resetBranch(integration, `origin/${config.baseBranch}`);
  await git.push(integration);
}

/** 合進整合分支之後：開或更新 agent/<S> → base 的 draft PR（不轉 ready）→ 留言（合併後的 commit、怎麼驗的）→ 關 #A */
async function closeIntoSpec(
  config: Config,
  deps: Deps,
  issue: Issue,
  spec: number,
  sha: string,
  result: ImplementResult,
  review: ReviewResult,
): Promise<Ending> {
  const { github } = deps;
  const n = issue.number;
  const integration = agentBranch(spec);
  const existing = await github.findOpenPr(integration);
  const body = specPrBody(spec, existing?.body ?? null, { number: n, title: issue.title, sha, impl: result, review });
  const title = issue.parentTitle;
  const pr = existing
    ? (await github.updatePr(existing.number, { title, body }), existing)
    : await github.createPr({ base: config.baseBranch, head: integration, title, body, draft: true, assignee: config.operator });
  await github.comment(
    n,
    [
      `🤖 全過，已合進整合分支 \`${integration}\`（合併後的 commit \`${sha}\`），整份 spec 的 draft PR：${pr.url}`,
      "",
      "驗證（sandbox 內實際跑過）：",
      "",
      verificationText(result, review),
    ].join("\n"),
  );
  // 關掉的 issue 留著操作者當紀錄；被它擋的下一張 sub-issue 下一輪就解鎖
  await releaseIssue(deps, config.operator, n, { keepAssignee: true });
  await github.closeIssue(n);
  return { kind: "pass", pr };
}

/** push branch，開或更新以它為 head 的 draft PR。重接時沿用還開著的那張；已轉 ready 的先退回 draft 再 push，不然 force push 會觸發整支 CI */
async function pushWithDraftPr(
  config: Config,
  { github, git }: Deps,
  pr: { head: string; base: string; title: string; body: string },
): Promise<{ number: number; url: string }> {
  const existing = await github.findOpenPr(pr.head);
  if (existing && !existing.isDraft) await github.markPrDraft(existing.number);
  await git.push(pr.head);
  if (existing) {
    await github.updatePr(existing.number, { title: pr.title, body: pr.body });
    return existing;
  }
  return github.createPr({ ...pr, draft: true, assignee: config.operator });
}

/**
 * 重接時 agent/<N> 上有人手做的 commit：不碰 branch 和 PR，拿掉 agent-runner（不然每輪都會再問一次），留言請人決定。
 * 沒接單，所以沒有 agent-in-progress、也沒 assign。回傳給 Slack 的一句原因。
 */
async function askAboutForeignCommits(github: Deps["github"], n: number, authors: string[], startRef: string): Promise<string> {
  const branch = agentBranch(n);
  const reason = `\`${branch}\` 上有不是 runner 做的 commit（author：${authors.join("、")}），沒有重接`;
  await github.removeLabel(n, RUNNER_LABEL);
  await github.comment(
    n,
    [
      `🤖 沒有重接：\`${branch}\` 上有不是 runner 做的 commit（author：${authors.join("、")}），runner 不會蓋掉人手做的成果。`,
      "",
      "請決定要怎麼做：",
      `- 要 runner 從 \`${startRef}\` 重做（會丟掉那些 commit）：刪掉遠端的 \`${branch}\`，再貼回 \`${RUNNER_LABEL}\``,
      `- 要保留那些 commit：自己在那條 branch 上接手，不要再貼 \`${RUNNER_LABEL}\``,
    ].join("\n"),
  );
  return reason;
}
