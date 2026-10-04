import { nextAutoOff } from "./autoOff.js";
import type { Action, Issue, Snapshot } from "./types.js";

export const READY_LABEL = "ready-for-agent";

/**
 * 純函式：這一輪看到的世界 → 要做的動作。不碰任何外部。
 *
 * 每一條挑單規則是 PICK_RULES 裡的一列；後面的票（wayfinder、parent、sub-issue、
 * 距自動關時間、每輪上限…）往表裡加列或在下面加分支，不改呼叫端。
 */
type PickRule = (issue: Issue, snapshot: Snapshot, now: Date) => boolean;

const PICK_RULES: PickRule[] = [
  (issue, snapshot) => issue.author === snapshot.operator,
  (issue) => issue.labels.includes(READY_LABEL),
  // 會在自動關時被砍成 crash 的單不接：剩下的時間要夠一整個 timeout
  (_issue, snapshot, now) => nextAutoOff(snapshot.autoOff, now).getTime() - now.getTime() >= snapshot.timeoutMinutes * 60_000,
];

export function decide(snapshot: Snapshot, now: Date): Action[] {
  return snapshot.candidates
    .filter((issue) => PICK_RULES.every((rule) => rule(issue, snapshot, now)))
    .sort((a, b) => a.number - b.number)
    .map((issue) => ({ kind: "pickup", issue }));
}
