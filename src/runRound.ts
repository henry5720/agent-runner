import type { Config } from "./config.js";
import { decide } from "./decide.js";
import { imageTag } from "./image.js";
import { prBody } from "./prBody.js";
import type { Deps } from "./ports.js";
import type { Issue } from "./types.js";

export const IN_PROGRESS_LABEL = "agent-in-progress";
const READY_LABEL = "ready-for-agent";

/**
 * 一輪：拿鎖（拿不到就結束）→ fetch → 確認 image → 列候選 → decide() → 一次一張處理。
 * 這張票只有全過的 happy path；檢查、reviewer、失敗收尾、Slack、flock、上限在後面的票加。
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
  const tag = await ensureImage(config, deps, baseRef);

  const candidates = await github.listCandidates();
  const snapshot = { operator: config.operator, candidates, autoOff: config.autoOff, timeoutMinutes: config.timeoutMinutes };
  const actions = decide(snapshot, clock.now());

  for (const action of actions) {
    switch (action.kind) {
      case "pickup":
        // 關掉（手動 off 或 08:00 自動關）之後不接新單；正在做的那張已經做完了
        if (!(await deps.power.isOn())) return;
        // 前一張做完時間已經過了，再問一次 decide（例如已經進入自動關前的最後一個 timeout）
        if (!decide({ ...snapshot, candidates: [action.issue] }, clock.now()).length) return;
        await deps.runState.setCurrent({ number: action.issue.number, title: action.issue.title });
        try {
          await handleIssue(config, deps, action.issue, { tag, baseRef });
        } finally {
          await deps.runState.setCurrent(null);
        }
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
  if (result.outcome !== "pass") {
    // #2697（[WIP]）、#2698（needs-info／timeout／crash）接手；先讓 agent-in-progress 留著給下一輪的殘留掃描
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
