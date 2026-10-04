/**
 * 沒開成 PR 的結局：needs-info、timeout／crash（含 install 失敗、上一輪被硬殺的殘留）。
 * 都不自動重試：ready-for-agent 不會被貼回去，要重來由開單的人手動貼。
 */
import type { Deps } from "./ports.js";
import type { ImplementResult } from "./result.js";

export const IN_PROGRESS_LABEL = "agent-in-progress";
export const NEEDS_INFO_LABEL = "needs-info";

/**
 * 每種結局的收尾：拿掉 agent-in-progress 和接單時 assign 的操作者（PR 的 assignee 留著）。
 * 挑單條件有 `no:assignee`，不拿掉的話人貼回 ready-for-agent 也接不到。
 */
export async function releaseIssue({ github }: Pick<Deps, "github">, operator: string, n: number): Promise<void> {
  await github.removeLabel(n, IN_PROGRESS_LABEL);
  await github.unassign(n, operator);
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
      "補完單子後手動貼回 `ready-for-agent` 就會重接。",
    ].join("\n"),
  );
}

/** sandbox run 丟出來的錯 → 給人看的原因（一行） */
export function failureReason(err: unknown, signal: AbortSignal, timeoutMinutes: number): string {
  if (signal.aborted || (err as { name?: unknown } | null)?.name === "TimeoutError") return `超過 ${timeoutMinutes} 分鐘上限（timeout）`;
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n")[0]?.trim() || "未知錯誤";
}

/** timeout／crash：拿掉 agent-in-progress 與操作者 assignee、留言寫原因；只有 worktree 真的還在才附路徑。回傳保留的 worktree 路徑（沒有就 undefined） */
export async function wrapUpCrash(deps: Deps, operator: string, n: number, reason: string): Promise<string | undefined> {
  const { github, git } = deps;
  const name = `agent-${n}`;
  const kept = (await git.listWorktrees()).find((w) => w.name === name);
  const where = kept
    ? `沒 commit 的變更留在 worktree \`${kept.path}\`（3 天後自動刪），commit 在分支 \`agent/${n}\`。`
    : `已 commit 的東西在 runner bot clone 的分支 \`agent/${n}\`（沒有推上 GitHub）。`;
  await releaseIssue(deps, operator, n);
  await github.comment(
    n,
    [`🤖 這張單沒做完，沒有開 PR：${reason}`, "", where, "", "不會自動重試；要重來就手動貼回 `ready-for-agent`。"].join("\n"),
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
