import type { Config } from "./config.js";
import { decide } from "./decide.js";
import { imageTag } from "./image.js";
import { failureReason, IN_PROGRESS_LABEL, releaseIssue, removeOldWorktrees, wrapUpCrash, wrapUpNeedsInfo } from "./endings.js";
import { prBody, prTitle } from "./prBody.js";
import type { Deps } from "./ports.js";
import type { Issue } from "./types.js";

const READY_LABEL = "ready-for-agent";

/**
 * 一輪：fetch → 刪超過 3 天的 worktree → 確認 image → 殘留 agent-in-progress 照 crash 收尾 → 列候選 → decide()（含 maxPerRound 上限）→ 一次一張處理。
 * 結局：全過／`[WIP]` 開 draft PR；needs-info、timeout／crash 見 endings.ts。重接（#2700）：沿用 agent/<N> 與開著的 PR；branch 上有人手做的 commit 就停手問人。Slack、flock 在其他票加。
 * 每種結局都要拿掉接單時 assign 的操作者（見 endings.ts releaseIssue），不然人貼回 ready-for-agent 也接不到。
 */
export async function runRound(config: Config, deps: Deps): Promise<void> {
  const { github, git, sandbox, clock } = deps;
  const baseRef = `origin/${config.baseBranch}`;

  await git.fetch();
  await removeOldWorktrees(deps);
  const tag = await ensureImage(config, deps, baseRef);

  // flock 保證同時只有一輪，所以這時還帶 agent-in-progress 的都是被硬殺的殘留；不重跑，照 crash 收尾
  for (const stale of await github.listInProgress()) {
    await wrapUpCrash(deps, config.operator, stale.number, "上一輪 runner 被中斷（硬殺或關機），沒有收尾");
  }

  const candidates = await github.listCandidates();
  const branchAuthors = Object.fromEntries(
    await Promise.all(candidates.map(async (i) => [i.number, await git.branchAuthors(`agent/${i.number}`, baseRef)] as const)),
  );
  const actions = decide(
    { operator: config.operator, candidates, maxPerRound: config.maxPerRound, runnerAuthor: config.gitAuthor, branchAuthors },
    clock.now(),
  );

  for (const action of actions) {
    switch (action.kind) {
      case "pickup":
        await handleIssue(config, deps, action.issue, { tag, baseRef });
        break;
      case "ask-about-foreign-commits":
        await askAboutForeignCommits(github, action.issue.number, action.authors);
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

  // 實作（整張單共用一個 timeout）。重接時舊的 worktree 會被 sandcastle 重用，先刪掉再從 origin/dev 重來
  const leftover = (await git.listWorktrees()).find((w) => w.name === branch.replace(/\//g, "-"));
  if (leftover) await git.removeWorktree(leftover.path);
  await git.resetBranch(branch, ctx.baseRef);
  const signal = AbortSignal.timeout(config.timeoutMinutes * 60_000);
  // reviewer run：乾淨 context 跑 code-review、可 commit 修正、最後重跑檢查。實作回報 wip 也跑（reviewer 可能修好）；
  // 最後的結局以 review 後的檢查為準。兩次 run 任一次 timeout／crash 都照 crash 收尾
  let result, review;
  try {
    result = await sandbox.implement({ imageTag: ctx.tag, issue, branch, baseRef: ctx.baseRef, signal });
    if (result.outcome === "needs-info") return wrapUpNeedsInfo(deps, config.operator, n, result);
    review = await sandbox.review({ imageTag: ctx.tag, issue, branch, baseRef: ctx.baseRef, signal });
  } catch (err) {
    return wrapUpCrash(deps, config.operator, n, failureReason(err, signal, config.timeoutMinutes));
  }

  // 開 PR（push 和 gh 都在 host 做，sandbox 裡沒有 GH_TOKEN）。重接時沿用還開著的那張，討論留在同一張 PR
  const title = prTitle(result, review);
  const body = prBody(n, result, review);
  const existing = await github.findOpenPr(branch);
  // 已轉 ready 的 PR 先退回 draft 再 push，不然 force push 會觸發整支 CI
  if (existing && !existing.isDraft) await github.markPrDraft(existing.number);
  await git.push(branch);
  const pr = existing
    ? (await github.updatePr(existing.number, { title, body }), existing)
    : await github.createPr({ base: config.baseBranch, head: branch, title, body, draft: true, assignee: config.operator });
  if (review.outcome === "wip") {
    await github.comment(n, `🤖 有檢查沒過，開了 \`[WIP]\` draft PR，可以從那裡接手：${pr.url}\n\n沒過的檢查：\n\n${review.failedChecks.map((c) => `- ${c}`).join("\n")}`);
  }
  await releaseIssue(deps, config.operator, n);
}

/**
 * 重接時 agent/<N> 上有人手做的 commit：不碰 branch 和 PR，拿掉 ready-for-agent（不然每輪都會再問一次），留言請人決定。
 * 沒接單，所以沒有 agent-in-progress、也沒 assign。
 */
async function askAboutForeignCommits(github: Deps["github"], n: number, authors: string[]) {
  await github.removeLabel(n, READY_LABEL);
  await github.comment(
    n,
    [
      `🤖 沒有重接：\`agent/${n}\` 上有不是 runner 做的 commit（author：${authors.join("、")}），runner 不會蓋掉人手做的成果。`,
      "",
      "請決定要怎麼做：",
      `- 要 runner 從 \`origin/dev\` 重做（會丟掉那些 commit）：刪掉遠端的 \`agent/${n}\`，再貼回 \`ready-for-agent\``,
      "- 要保留那些 commit：自己在那條 branch 上接手，不要再貼 `ready-for-agent`",
    ].join("\n"),
  );
}
