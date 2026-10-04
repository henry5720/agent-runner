import type { AutoOffSchedule } from "./autoOff.js";

/** runner 看到的一張 issue（從 gh 輸出解析後的 domain 形狀）。 */
export interface Issue {
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  assignees: string[];
  /** 沒有 parent → null */
  parentNumber: number | null;
  /** parent 的 labels；沒有 parent → [] */
  parentLabels: string[];
  subIssueCount: number;
  /** 還沒關的 blocker 數（已關的不算） */
  openBlockerCount: number;
}

/** 這一輪看到的世界。後面的票（殘留 agent-in-progress、agent/<N> 狀態、既有 PR…）往這裡加欄位。 */
export interface Snapshot {
  operator: string;
  candidates: Issue[];
  /** 自動關時間；距離它不到一個 timeout 就不接新單 */
  autoOff: AutoOffSchedule;
  timeoutMinutes: number;
  /** 一輪最多接幾張 */
  maxPerRound: number;
  /** runner 的 git author name；agent/<N> 上有別的 author 就是人動過 */
  runnerAuthor: string;
  /** origin 上 agent/<N> 相對 base 的 commit author name；branch 不存在 → 沒有這個 key 或空陣列 */
  branchAuthors: Record<number, string[]>;
  /** 一輪開頭還帶 agent-in-progress 的單。flock 保證同時只有一輪，所以都是被硬殺的殘留 */
  inProgress: Pick<Issue, "number">[];
}

/** decide() 產出的動作。後面的票往這個 union 加種類。 */
export type Action =
  /** 上一輪被硬殺的殘留：不重跑，照 crash 收尾 */
  | { kind: "wrap-up-leftover"; issue: Pick<Issue, "number"> }
  | { kind: "pickup"; issue: Issue }
  /** 重接時 agent/<N> 上有人手做的 commit：不碰 branch，留言請人決定 */
  | { kind: "ask-about-foreign-commits"; issue: Issue; authors: string[] };
