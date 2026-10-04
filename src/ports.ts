/**
 * runRound() 的系統邊界。一個操作一個 method（SDK 風格），測試用 test/support/fakes.ts 的 in-memory 版本。
 * 真的實作：github.ts（gh）、git.ts（bot clone）、sandbox.ts（sandcastle + docker）、notifier.ts、clock.ts。
 */
import type { ImplementResult, ReviewResult } from "./result.js";
import type { Issue } from "./types.js";

export interface NewPr {
  base: string;
  head: string;
  title: string;
  body: string;
  draft: boolean;
  assignee: string;
}

export interface OpenPr {
  number: number;
  url: string;
  isDraft: boolean;
}

export interface GitHub {
  /** 候選單（設定裡的挑單條件）；順序不保證 */
  listCandidates(): Promise<Issue[]>;
  /** 還開著、帶 agent-in-progress 的單（一輪開頭還帶著 = 上一輪被硬殺的殘留）。只回 number：收尾用不到 parent／blocker，不另外查 */
  listInProgress(): Promise<Pick<Issue, "number">[]>;
  /** 沒有就建、有就更新（idempotent） */
  createLabel(name: string, opts: { color: string; description: string }): Promise<void>;
  /** label 不存在會失敗，先 createLabel */
  addLabel(issue: number, label: string): Promise<void>;
  removeLabel(issue: number, label: string): Promise<void>;
  assign(issue: number, login: string): Promise<void>;
  unassign(issue: number, login: string): Promise<void>;
  comment(issue: number, body: string): Promise<void>;
  createPr(pr: NewPr): Promise<{ number: number; url: string }>;
  /** head 是這條 branch、還開著的 PR；沒有 → null（關掉或 merge 掉的不算，重接會開新的） */
  findOpenPr(head: string): Promise<OpenPr | null>;
  updatePr(number: number, edit: { title: string; body: string }): Promise<void>;
  /** ready → draft（`gh pr ready --undo`）；只對 ready 的 PR 呼叫 */
  markPrDraft(number: number): Promise<void>;
}

export interface Git {
  /** `git fetch origin`（sandcastle 不會自己 fetch） */
  fetch(): Promise<void>;
  /** 讀某個 ref 上的檔案內容 */
  showFile(ref: string, path: string): Promise<string>;
  /** origin/<branch> 上、不在 baseRef 裡的 commit 的 author name（`%an`；runner 和操作者共用 email，只能比名字）。branch 不在 origin → [] */
  branchAuthors(branch: string, baseRef: string): Promise<string[]>;
  /** `git branch -f <branch> <startPoint>` */
  resetBranch(branch: string, startPoint: string): Promise<void>;
  /** `git push --force-with-lease origin <branch>` */
  push(branch: string): Promise<void>;
  /** bot clone 的 `.sandcastle/worktrees/` 底下現有的目錄（sandcastle 保留的、或被硬殺留下的） */
  listWorktrees(): Promise<Worktree[]>;
  /** 刪掉一個 sandcastle worktree（`git worktree remove --force`，失敗就直接刪目錄再 prune） */
  removeWorktree(path: string): Promise<void>;
}

export interface Worktree {
  /** 目錄名，`agent/<N>` → `agent-<N>` */
  name: string;
  /** 絕對路徑 */
  path: string;
  /** 目錄最後修改時間（算「超過 3 天」用） */
  modifiedAt: Date;
}

export interface ImplementRequest {
  imageTag: string;
  issue: Issue;
  branch: string;
  /** agent/<N> 的起點，例如 origin/dev */
  baseRef: string;
  signal: AbortSignal;
}

export interface Sandbox {
  /** runner 的 Dockerfile 內容（算 image tag 用） */
  dockerfile(): Promise<string>;
  imageExists(tag: string): Promise<boolean>;
  buildImage(opts: { tag: string; nodeVersion: string }): Promise<void>;
  /**
   * 一次實作 run，回傳 agent 的結構化結果。
   * 失敗就 throw：timeout 時丟的是 `signal.reason`（`name === "TimeoutError"`）；
   * 其他錯誤的 message 第一行要能直接當原因給人看（install 失敗要寫明）。
   */
  implement(req: ImplementRequest): Promise<ImplementResult>;
  /** 實作之後另一次乾淨 context 的 reviewer run（同一條 branch、同一個 signal），可 commit 修正，最後重跑檢查 */
  review(req: ImplementRequest): Promise<ReviewResult>;
}

export interface Notifier {
  notify(text: string): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface Deps {
  github: GitHub;
  git: Git;
  sandbox: Sandbox;
  notifier: Notifier;
  clock: Clock;
}
