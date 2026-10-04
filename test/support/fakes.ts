/**
 * runRound() 測試用的 in-memory 邊界。後面的票共用這一份：要新的行為就在這裡加狀態，
 * 測試只看最終狀態（issue 的 label／留言、PR、branch、Slack 訊息），不看呼叫次數或順序。
 */
import type { Config } from "../../src/config.js";
import type { Clock, Deps, Git, GitHub, ImplementRequest, Lock, NewPr, Notifier, Power, RunningIssue, RunState, Sandbox, Worktree } from "../../src/ports.js";
import type { ImplementResult, ReviewResult } from "../../src/result.js";
import type { Issue } from "../../src/types.js";

/** 建一張預設「操作者自己開、帶 ready-for-agent、沒 parent、沒 sub-issue」的 issue。 */
export function issue(overrides: Partial<Issue> & { number: number }): Issue {
  return {
    title: `issue ${overrides.number}`,
    body: `body of ${overrides.number}`,
    author: "henry5720",
    labels: ["ready-for-agent"],
    assignees: [],
    parentNumber: null,
    parentLabels: [],
    subIssueCount: 0,
    openBlockerCount: 0,
    ...overrides,
  };
}

export function passResult(overrides: Partial<ImplementResult> = {}): ImplementResult {
  return {
    outcome: "pass",
    prTitle: "feat(demo): do the thing",
    summary: "did the thing",
    verification: [{ command: "pnpm test run src/demo", result: "3 passed" }],
    failedChecks: [],
    questions: [],
    dependencies: [],
    ...overrides,
  };
}

/** reviewer run 的結果；預設「沒改東西、檢查全過」 */
export function reviewResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    outcome: "pass",
    summary: "",
    verification: [],
    failedChecks: [],
    dependencies: [],
    ...overrides,
  };
}

export const testConfig: Config = {
  repo: "acme/widgets",
  operator: "henry5720",
  pickSearch: "-is:blocked no:assignee",
  maxPerRound: 2,
  baseBranch: "dev",
  botClonePath: "/bot/widgets",
  nvmrcPath: "frontend/.nvmrc",
  tddSkillPath: "/skills/tdd",
  gitAuthor: "henry (agent)",
  timeoutMinutes: 60,
  autoOff: { weekdays: [1, 2, 3, 4, 5], hour: 8, minute: 0, timeZone: "Asia/Taipei" },
  stateDir: "/state",
  model: "test-model",
  imageName: "sandcastle-test",
  pnpmStorePath: "/store",
  repoEnvPath: "/env/widgets.env",
  secretsFile: "/secrets/env",
};

export interface FakeIssue extends Issue {
  comments: string[];
}

export class FakeGitHub implements GitHub {
  readonly issues = new Map<number, FakeIssue>();
  readonly repoLabels: string[];
  readonly prs: (NewPr & { number: number; url: string })[] = [];

  constructor(issues: Issue[], repoLabels = ["ready-for-agent"]) {
    for (const i of issues) this.issues.set(i.number, { ...i, labels: [...i.labels], assignees: [...i.assignees], comments: [] });
    this.repoLabels = [...repoLabels];
  }

  issue(n: number): FakeIssue {
    const found = this.issues.get(n);
    if (!found) throw new Error(`fake github: no issue #${n}`);
    return found;
  }

  async listCandidates() {
    return [...this.issues.values()].map(({ comments: _c, ...i }) => ({ ...i, labels: [...i.labels], assignees: [...i.assignees] }));
  }
  async listInProgress() {
    return (await this.listCandidates()).filter((i) => i.labels.includes("agent-in-progress"));
  }
  async createLabel(name: string) {
    if (!this.repoLabels.includes(name)) this.repoLabels.push(name);
  }
  async addLabel(n: number, label: string) {
    // 跟真的 gh 一樣：label 不存在就失敗
    if (!this.repoLabels.includes(label)) throw new Error(`'${label}' not found`);
    const i = this.issue(n);
    if (!i.labels.includes(label)) i.labels.push(label);
  }
  async removeLabel(n: number, label: string) {
    const i = this.issue(n);
    i.labels = i.labels.filter((l) => l !== label);
  }
  async assign(n: number, login: string) {
    const i = this.issue(n);
    if (!i.assignees.includes(login)) i.assignees.push(login);
  }
  async comment(n: number, body: string) {
    this.issue(n).comments.push(body);
  }
  async createPr(pr: NewPr) {
    const number = 1000 + this.prs.length;
    const url = `https://github.com/acme/widgets/pull/${number}`;
    this.prs.push({ ...pr, number, url });
    return { number, url };
  }
}

export class FakeGit implements Git {
  private fetched = false;
  readonly localBranches = new Map<string, { base: string; fetchedFirst: boolean }>();
  readonly remoteBranches = new Map<string, { base: string; fetchedFirst: boolean }>();
  /** bot clone 的 `.sandcastle/worktrees/` 底下有的目錄 */
  worktrees: Worktree[] = [];

  constructor(private readonly files: Record<string, string>) {}

  async fetch() {
    this.fetched = true;
  }
  async showFile(ref: string, path: string) {
    const content = this.files[`${ref}:${path}`];
    if (content === undefined) throw new Error(`fake git: ${ref}:${path} does not exist`);
    return content;
  }
  async resetBranch(branch: string, startPoint: string) {
    this.localBranches.set(branch, { base: startPoint, fetchedFirst: this.fetched });
  }
  async push(branch: string) {
    const local = this.localBranches.get(branch);
    if (!local) throw new Error(`fake git: no local branch ${branch}`);
    this.remoteBranches.set(branch, { ...local });
  }
  async listWorktrees() {
    return this.worktrees.map((w) => ({ ...w }));
  }
  async removeWorktree(path: string) {
    this.worktrees = this.worktrees.filter((w) => w.path !== path);
  }
}

/** sandbox run 失敗：丟出 `throws`（跟真的 sandcastle 一樣原樣丟出）；`leavesWorktree` = sandcastle 因為有未 commit 的變更而保留 worktree */
export interface ScriptedFailure {
  throws: unknown;
  leavesWorktree?: boolean;
}

export type ScriptedRun = ImplementResult | ScriptedFailure;

export class FakeSandbox implements Sandbox {
  readonly images: Set<string>;
  readonly builtImages: { tag: string; nodeVersion: string; fresh?: boolean }[] = [];
  readonly runs: ImplementRequest[] = [];
  readonly reviews: ImplementRequest[] = [];

  constructor(
    private readonly results: Record<number, ScriptedRun>,
    images: string[] = [],
    private readonly dockerfileText = "FROM node\n",
    private readonly reviewResults: Record<number, ReviewResult | ScriptedFailure> = {},
    private readonly host?: { git: FakeGit; clock: FakeClock; botClonePath: string; minutesPerRun?: number },
  ) {
    this.images = new Set(images);
  }

  async dockerfile() {
    return this.dockerfileText;
  }
  async imageExists(tag: string) {
    return this.images.has(tag);
  }
  async buildImage(opts: { tag: string; nodeVersion: string; fresh?: boolean }) {
    this.builtImages.push(opts);
    this.images.add(opts.tag);
  }
  async implement(req: ImplementRequest) {
    // 跟真的 sandcastle 一樣：image 不存在就失敗，不會自己 build
    if (!this.images.has(req.imageTag)) throw new Error(`Image '${req.imageTag}' not found locally`);
    this.runs.push(req);
    if (this.host?.minutesPerRun) this.host.clock.advance(this.host.minutesPerRun * 60_000);
    const result = this.results[req.issue.number];
    if (!result) throw new Error(`fake sandbox: no scripted result for #${req.issue.number}`);
    if ("throws" in result) {
      if (result.leavesWorktree && this.host) {
        const name = req.branch.replaceAll("/", "-");
        this.host.git.worktrees.push({ name, path: `${this.host.botClonePath}/.sandcastle/worktrees/${name}`, modifiedAt: this.host.clock.now() });
      }
      throw result.throws;
    }
    return result;
  }
  async review(req: ImplementRequest) {
    if (!this.images.has(req.imageTag)) throw new Error(`Image '${req.imageTag}' not found locally`);
    // 跟真的 sandcastle 一樣：共用的 signal 已經 abort 就立刻 reject
    if (req.signal.aborted) throw req.signal.reason;
    this.reviews.push(req);
    const result = this.reviewResults[req.issue.number] ?? reviewResult();
    if ("throws" in result) throw result.throws;
    return result;
  }
}

export class FakeNotifier implements Notifier {
  readonly messages: string[] = [];
  async notify(text: string) {
    this.messages.push(text);
  }
}

export class FakeClock implements Clock {
  constructor(public current: Date) {}
  now() {
    return this.current;
  }
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** 另一輪拿著鎖 → `heldByOther = true` */
export class FakeLock implements Lock {
  heldByOther = false;
  held = false;

  async tryAcquire() {
    if (this.heldByOther || this.held) return null;
    this.held = true;
    return async () => {
      this.held = false;
    };
  }
}

export class FakeRunState implements RunState {
  current: RunningIssue | null = null;

  async setCurrent(issue: RunningIssue | null) {
    this.current = issue;
  }
}

export class FakePower implements Power {
  on = true;

  async isOn() {
    return this.on;
  }
}

export function fakeDeps(opts: {
  issues: Issue[];
  results: Record<number, ScriptedRun>;
  /** 沒給的單 reviewer 回「沒改東西、全過」 */
  reviews?: Record<number, ReviewResult | ScriptedFailure>;
  images?: string[];
  nvmrc?: string;
  now?: Date;
  /** 每次實作 run 讓假時鐘前進幾分鐘（算 Slack 訊息裡的「花多久」） */
  minutesPerRun?: number;
}) {
  const nvmrcKey = `origin/${testConfig.baseBranch}:${testConfig.nvmrcPath}`;
  const git = new FakeGit({ [nvmrcKey]: opts.nvmrc ?? "22.16.0" });
  const clock = new FakeClock(opts.now ?? new Date("2026-10-04T15:00:00Z"));
  return {
    github: new FakeGitHub(opts.issues),
    git,
    sandbox: new FakeSandbox(opts.results, opts.images, undefined, opts.reviews, { git, clock, botClonePath: testConfig.botClonePath, minutesPerRun: opts.minutesPerRun }),
    notifier: new FakeNotifier(),
    clock,
    lock: new FakeLock(),
    runState: new FakeRunState(),
    power: new FakePower(),
    stopSignal: new AbortController().signal,
  } satisfies Deps;
}
