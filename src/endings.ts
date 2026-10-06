/**
 * 沒開成 PR 的結局：needs-info、timeout／crash（含 install 失敗、上一輪被硬殺的殘留）。
 * 都不自動重試：agent-runner 不會被貼回去，要重來由開單的人手動貼。
 */
import type { Deps } from "./ports.js";
import { agentBranch, IN_PROGRESS_LABEL, NEEDS_INFO_LABEL, RUNNER_LABEL, worktreeName } from "./names.js";
import type { ImplementResult } from "./result.js";

/**
 * 每種結局的收尾：拿掉 agent-in-progress。
 * 全過（`keepAssignee`）的 issue 還在等 PR 用 `Closes #N` merge 關掉，操作者留著＝有人在跟；
 * spec 的 sub-issue 全過時 runner 自己關掉，操作者一樣留著當紀錄；
 * 其他結局拿掉接單時 assign 的操作者（PR 的 assignee 留著）—— 挑單條件有 `no:assignee`，
 * 不拿掉的話人貼回 agent-runner 也接不到。
 */
export async function releaseIssue(
  { github }: Pick<Deps, "github">,
  operator: string,
  n: number,
  { keepAssignee = false }: { keepAssignee?: boolean } = {},
): Promise<void> {
  await github.removeLabel(n, IN_PROGRESS_LABEL);
  if (!keepAssignee) await github.unassign(n, operator);
}

export async function wrapUpNeedsInfo(deps: Deps, operator: string, n: number, result: ImplementResult): Promise<void> {
  const { github } = deps;
  const questions = result.questions.length > 0 ? result.questions : ["（agent 沒有列出具體問題）"];
  await github.createLabel(NEEDS_INFO_LABEL, { color: "d876e3", description: "單子不清楚，等開單的人補資訊" });
  await github.addLabel(n, NEEDS_INFO_LABEL);
  await releaseIssue(deps, operator, n);
  await github.comment(
    n,
    [
      "🤖 這張單不夠清楚，agent 沒有實作，也沒有開 PR。卡在：",
      "",
      ...questions.map((q) => `- ${q}`),
      "",
      `補完單子後手動貼回 \`${RUNNER_LABEL}\` 就會重接。`,
    ].join("\n"),
  );
}

/** sandbox run 丟出來的錯 → 給人看的原因（一行） */
export function failureReason(err: unknown, signal: AbortSignal, timeoutMinutes: number): string {
  if (signal.aborted || (err as { name?: unknown } | null)?.name === "TimeoutError") return `超過 ${timeoutMinutes} 分鐘上限（timeout）`;
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n")[0]?.trim() || "未知錯誤";
}

/**
 * timeout／crash：拿掉 agent-in-progress 與操作者 assignee、留言寫原因；只有 worktree 真的還在才附路徑。回傳保留的 worktree 路徑（沒有就 undefined）。
 * `note`：附在留言裡的額外說明（例如 merge run 解到一半的 agent/<S> worktree）
 */
export async function wrapUpCrash(deps: Deps, operator: string, n: number, reason: string, note?: string): Promise<string | undefined> {
  const { github, git } = deps;
  const branch = agentBranch(n);
  const kept = (await git.listWorktrees()).find((w) => w.name === worktreeName(branch));
  const where = kept
    ? `沒 commit 的變更留在 worktree \`${kept.path}\`（3 天後自動刪），commit 在分支 \`${branch}\`。`
    : `已 commit 的東西在 runner bot clone 的分支 \`${branch}\`（沒有推上 GitHub）。`;
  await releaseIssue(deps, operator, n);
  await github.comment(
    n,
    [`🤖 這張單沒做完，沒有開 PR：${reason}`, "", where, ...(note ? ["", note] : []), "", `不會自動重試；要重來就手動貼回 \`${RUNNER_LABEL}\`。`].join("\n"),
  );
  return kept?.path;
}

/** crash 留言承諾的「3 天後自動刪」 */
export const WORKTREE_RETENTION_MS = 3 * 24 * 60 * 60_000;

export async function removeOldWorktrees({ git, clock }: Pick<Deps, "git" | "clock">): Promise<void> {
  const cutoff = clock.now().getTime() - WORKTREE_RETENTION_MS;
  for (const w of await git.listWorktrees()) {
    if (w.modifiedAt.getTime() < cutoff) await git.removeWorktree(w.path);
  }
}
