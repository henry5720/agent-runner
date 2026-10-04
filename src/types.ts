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
  /** 一輪最多接幾張 */
  maxPerRound: number;
  /** runner 的 git author name；agent/<N> 上有別的 author 就是人動過 */
  runnerAuthor: string;
  /** origin 上 agent/<N> 相對 base 的 commit author name；branch 不存在 → 沒有這個 key 或空陣列 */
  branchAuthors: Record<number, string[]>;
}

/** decide() 產出的動作。後面的票往這個 union 加種類。 */
export type Action =
  | { kind: "pickup"; issue: Issue }
  /** 重接時 agent/<N> 上有人手做的 commit：不碰 branch，留言請人決定 */
  | { kind: "ask-about-foreign-commits"; issue: Issue; authors: string[] };
