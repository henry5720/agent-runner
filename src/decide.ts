import type { Action, Issue, Snapshot } from "./types.js";

export const READY_LABEL = "ready-for-agent";
const WAYFINDER_PREFIX = "wayfinder:";
const WAYFINDER_MAP_LABEL = "wayfinder:map";

/**
 * 純函式：這一輪看到的世界 → 要做的動作。不碰任何外部。
 *
 * 每一條挑單規則是 PICK_RULES 裡的一列；後面的票（距自動關時間…）往表裡加列或在下面加分支，不改呼叫端。
 */
type PickRule = (issue: Issue, snapshot: Snapshot, now: Date) => boolean;

const PICK_RULES: PickRule[] = [
  (issue, snapshot) => issue.author === snapshot.operator,
  (issue) => issue.labels.includes(READY_LABEL),
  // 規劃票（map、決策單…）不是給 agent 做的
  (issue) => !issue.labels.some((l) => l.startsWith(WAYFINDER_PREFIX)),
  // spec 的子單由 spec 自己推進；只有掛在 wayfinder:map 底下的才是獨立的票
  (issue) => issue.parentNumber === null || issue.parentLabels.includes(WAYFINDER_MAP_LABEL),
  // 母單（含 spec 本身）是拆給子單做的
  (issue) => issue.subIssueCount === 0,
  // 下面兩條 pickSearch 已經擋了；設定改了也不會接到別人手上或被擋住的單
  (issue) => issue.assignees.length === 0,
  (issue) => issue.openBlockerCount === 0,
];

export function decide(snapshot: Snapshot, now: Date): Action[] {
  return snapshot.candidates
    .filter((issue) => PICK_RULES.every((rule) => rule(issue, snapshot, now)))
    .sort((a, b) => a.number - b.number)
    .slice(0, snapshot.maxPerRound)
    .map((issue) => ({ kind: "pickup", issue }));
}
