/** runner 在 GitHub 與 bot clone 上用到的名字，只在這裡寫一次。 */

/** 人貼上去讓 runner 接的單。跟 `ready-for-agent`（單子寫清楚了）分開：寫清楚不代表要交給 runner */
export const READY_LABEL = "agent-runner";
/** runner 正在做（一輪開頭還帶著 = 上一輪被硬殺的殘留） */
export const IN_PROGRESS_LABEL = "agent-in-progress";
/** 單子不清楚，等開單的人補 */
export const NEEDS_INFO_LABEL = "needs-info";

/** 每張單的 branch：`agent/<N>` */
export const agentBranch = (n: number) => `agent/${n}`;

/** sandcastle 開在 `.sandcastle/worktrees/` 底下的目錄名：branch 的 `/` 換成 `-`（`agent/42` → `agent-42`） */
export const worktreeName = (branch: string) => branch.replace(/\//g, "-");
