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
}

/** decide() 產出的動作。後面的票往這個 union 加種類。 */
export type Action = { kind: "pickup"; issue: Issue };
