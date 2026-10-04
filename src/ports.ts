/**
 * runRound() 的系統邊界。一個操作一個 method（SDK 風格），測試用 test/support/fakes.ts 的 in-memory 版本。
 * 真的實作：github.ts（gh）、git.ts（bot clone）、sandbox.ts（sandcastle + docker）、notifier.ts、clock.ts。
 */
import type { ImplementResult } from "./result.js";
import type { Issue } from "./types.js";

export interface NewPr {
  base: string;
  head: string;
  title: string;
  body: string;
  draft: boolean;
  assignee: string;
}

export interface GitHub {
  /** 候選單（設定裡的挑單條件）；順序不保證 */
  listCandidates(): Promise<Issue[]>;
  /** 沒有就建、有就更新（idempotent） */
  createLabel(name: string, opts: { color: string; description: string }): Promise<void>;
  /** label 不存在會失敗，先 createLabel */
  addLabel(issue: number, label: string): Promise<void>;
  removeLabel(issue: number, label: string): Promise<void>;
  assign(issue: number, login: string): Promise<void>;
  comment(issue: number, body: string): Promise<void>;
  createPr(pr: NewPr): Promise<{ number: number; url: string }>;
}

export interface Git {
  /** `git fetch origin`（sandcastle 不會自己 fetch） */
  fetch(): Promise<void>;
  /** 讀某個 ref 上的檔案內容 */
  showFile(ref: string, path: string): Promise<string>;
  /** `git branch -f <branch> <startPoint>` */
  resetBranch(branch: string, startPoint: string): Promise<void>;
  /** `git push --force-with-lease origin <branch>` */
  push(branch: string): Promise<void>;
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
  /** 一次實作 run，回傳 agent 的結構化結果 */
  implement(req: ImplementRequest): Promise<ImplementResult>;
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
