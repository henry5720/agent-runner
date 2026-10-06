/**
 * runRound() 測試用的 in-memory 邊界。後面的票共用這一份：要新的行為就在這裡加狀態，
 * 測試只看最終狀態（issue 的 label／留言、PR、branch、Slack 訊息），不看呼叫次數或順序。
 */
import type { Config } from "../../src/config.js";
import type { Clock, Deps, Git, GitHub, ImplementRequest, Lock, MergeRequest, NewPr, Notifier, Power, RunningIssue, RunState, Sandbox, Worktree } from "../../src/ports.js";
import type { ImplementResult, ReviewResult } from "../../src/result.js";
import type { Issue } from "../../src/types.js";

/** 建一張預設「操作者自己開、帶 agent-runner、沒 parent、沒 sub-issue」的 issue。 */
export function issue(overrides: Partial<Issue> & { number: number }): Issue {
  return {
    title: `issue ${overrides.number}`,
    body: `body of ${overrides.number}`,
    author: "henry5720",
    labels: ["agent-runner"],
    assignees: [],
    parentNumber: null,
    parentLabels: [],
    parentTitle: "",
    parentBody: "",
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
  roundIntervalMinutes: 60,
  baseBranch: "dev",
  botClonePath: "/bot/widgets",
  nvmrcPath: "frontend/.nvmrc",
  tddSkillPath: "/skills/tdd",
  mergeSkillPath: "/skills/resolving-merge-conflicts",
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
  state: "OPEN" | "CLOSED";
}

export class FakeGitHub implements GitHub {
  readonly issues = new Map<number, FakeIssue>();
  readonly repoLabels: string[];
  readonly prs: (NewPr & { number: number; url: string; state: "OPEN" | "CLOSED" | "MERGED" })[] = [];

  constructor(issues: Issue[], repoLabels = ["agent-runner"]) {
    for (const i of issues) this.issues.set(i.number, { ...i, labels: [...i.labels], assignees: [...i.assignees], comments: [], state: "OPEN" });
    this.repoLabels = [...repoLabels];
  }

  issue(n: number): FakeIssue {
    const found = this.issues.get(n);
    if (!found) throw new Error(`fake github: no issue #${n}`);
    return found;
  }

  async listCandidates() {
    return [...this.issues.values()]
      .filter((i) => i.state === "OPEN")
      .map(({ comments: _c, state: _s, ...i }) => ({ ...i, labels: [...i.labels], assignees: [...i.assignees] }));
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
  async unassign(n: number, login: string) {
    const i = this.issue(n);
    i.assignees = i.assignees.filter((a) => a !== login);
  }
  async comment(n: number, body: string) {
    this.issue(n).comments.push(body);
  }
  async closeIssue(n: number) {
    this.issue(n).state = "CLOSED";
  }
  async createPr(pr: NewPr) {
    const number = 1000 + this.prs.length;
    const url = `https://github.com/acme/widgets/pull/${number}`;
    this.prs.push({ ...pr, number, url, state: "OPEN" });
    return { number, url };
  }
  /** push 到某條 branch 時，head 是它、開著而且 ready 的 PR 會跑一次 CI（跟 ci.yml 的 agent draft gate 一樣） */
  readonly ciRuns: number[] = [];
  onPush(branch: string) {
    for (const p of this.prs) if (p.head === branch && p.state === "OPEN" && !p.draft) this.ciRuns.push(p.number);
  }
  pr(number: number) {
    const found = this.prs.find((p) => p.number === number);
    if (!found) throw new Error(`fake github: no PR #${number}`);
    return found;
  }
  async findOpenPr(head: string) {
    const found = this.prs.find((p) => p.head === head && p.state === "OPEN");
    return found ? { number: found.number, url: found.url, isDraft: found.draft, body: found.body } : null;
  }
  async updatePr(number: number, edit: { title: string; body: string }) {
    Object.assign(this.pr(number), edit);
  }
  async markPrDraft(number: number) {
    this.pr(number).draft = true;
  }
}

/** fake 的一顆 commit：只記 sha 和 author（`branchAuthors` 只看 author name） */
export interface FakeCommit {
  sha: string;
  author: string;
}

export class FakeGit implements Git {
  private fetched = false;
  private seq = 0;
  readonly localBranches = new Map<string, { base: string; fetchedFirst: boolean }>();
  readonly remoteBranches = new Map<string, { base: string; fetchedFirst: boolean }>();
  /** 每條 branch 上、不在 origin/dev 裡的 commit（由舊到新）。origin/dev 本身當成空的 */
  readonly localCommits = new Map<string, FakeCommit[]>();
  readonly remoteCommits = new Map<string, FakeCommit[]>();
  /** 合進任何 branch 都會衝突的來源 branch */
  readonly conflicts = new Set<string>();
  /** bot clone 的 `.sandcastle/worktrees/` 底下有的目錄 */
  worktrees: Worktree[] = [];

  constructor(
    private readonly files: Record<string, string>,
    private readonly onPush: (branch: string) => void = () => {},
  ) {}

  private newCommit(author: string): FakeCommit {
    return { sha: `c${++this.seq}`, author };
  }
  /** ref → 它上面不在 origin/dev 裡的 commit；ref 不存在就跟真的 git 一樣失敗 */
  private commitsOf(ref: string): FakeCommit[] {
    if (ref === `origin/${testConfig.baseBranch}`) return [];
    const found = ref.startsWith("origin/") ? this.remoteCommits.get(ref.slice("origin/".length)) : this.localCommits.get(ref);
    if (!found) throw new Error(`fake git: unknown revision ${ref}`);
    return found;
  }
  private notIn(commits: FakeCommit[], baseRef: string): FakeCommit[] {
    const base = new Set(this.commitsOf(baseRef).map((c) => c.sha));
    return commits.filter((c) => !base.has(c.sha));
  }

  /** sandbox 裡的 agent 在本地 branch 上 commit 一顆 */
  commit(branch: string, author: string) {
    const commits = this.localCommits.get(branch);
    if (!commits) throw new Error(`fake git: no local branch ${branch}`);
    commits.push(this.newCommit(author));
  }
  /** 人直接在 GitHub 上往某條 branch push 一顆 commit（branch 不存在就從 origin/dev 開） */
  humanPushes(branch: string, author: string) {
    if (!this.remoteBranches.has(branch)) this.remoteBranches.set(branch, { base: `origin/${testConfig.baseBranch}`, fetchedFirst: true });
    this.remoteCommits.set(branch, [...(this.remoteCommits.get(branch) ?? []), this.newCommit(author)]);
  }
  /** sandbox 裡的 agent 在本地 <target> 上 `git merge <source>`、解完衝突 commit */
  agentMerges(target: string, source: string) {
    const into = this.localCommits.get(target);
    if (!into) throw new Error(`fake git: no local branch ${target}`);
    const have = new Set(into.map((c) => c.sha));
    this.localCommits.set(target, [...into, ...this.commitsOf(source).filter((c) => !have.has(c.sha)), this.newCommit(testConfig.gitAuthor)]);
  }
  /** origin/<branch> 是否包含本地 <source> 上的每一顆 commit */
  remoteContains(branch: string, source: string): boolean {
    const remote = new Set((this.remoteCommits.get(branch) ?? []).map((c) => c.sha));
    return (this.localCommits.get(source) ?? []).every((c) => remote.has(c.sha));
  }

  async fetch() {
    this.fetched = true;
  }
  async showFile(ref: string, path: string) {
    const content = this.files[`${ref}:${path}`];
    if (content === undefined) throw new Error(`fake git: ${ref}:${path} does not exist`);
    return content;
  }
  async branchAuthors(branch: string, baseRef: string) {
    const remote = this.remoteCommits.get(branch);
    if (!remote) return [];
    return [...new Set(this.notIn(remote, baseRef).map((c) => c.author))];
  }
  async hasRemoteBranch(branch: string) {
    return this.remoteBranches.has(branch);
  }
  async resetBranch(branch: string, startPoint: string) {
    // 跟真的 git 一樣：branch 被某個 worktree checkout 著時 `branch -f` 會失敗
    if (this.worktrees.some((w) => w.name === branch.replace(/\//g, "-"))) throw new Error(`cannot force update the branch '${branch}' used by worktree`);
    const commits = [...this.commitsOf(startPoint)];
    this.localBranches.set(branch, { base: startPoint, fetchedFirst: this.fetched });
    this.localCommits.set(branch, commits);
  }
  async hasCommits(branch: string, baseRef: string) {
    return this.notIn(this.localCommits.get(branch) ?? [], baseRef).length > 0;
  }
  async push(branch: string) {
    const local = this.localBranches.get(branch);
    if (!local) throw new Error(`fake git: no local branch ${branch}`);
    this.remoteBranches.set(branch, { ...local });
    this.remoteCommits.set(branch, [...(this.localCommits.get(branch) ?? [])]);
    this.onPush(branch);
  }
  async mergeInto(target: string, source: string) {
    const into = this.remoteCommits.get(target);
    if (!into) throw new Error(`fake git: no remote branch ${target}`);
    if (this.conflicts.has(source)) return { kind: "conflict" as const };
    const have = new Set(into.map((c) => c.sha));
    const merge = this.newCommit(testConfig.gitAuthor);
    this.remoteCommits.set(target, [...into, ...this.commitsOf(source).filter((c) => !have.has(c.sha)), merge]);
    this.onPush(target);
    return { kind: "merged" as const, sha: merge.sha };
  }
  async pushMerge(target: string, source: string) {
    const local = this.localCommits.get(target) ?? [];
    const has = new Set(local.map((c) => c.sha));
    const contains = (ref: string) => this.commitsOf(ref).every((c) => has.has(c.sha));
    if (!contains(source) || !contains(`origin/${target}`)) return { kind: "not-merged" as const };
    await this.push(target);
    return { kind: "merged" as const, sha: local.at(-1)!.sha };
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
  /** 這些單的實作 run 回報做完，卻沒在 branch 上留下任何 commit */
  readonly commitless = new Set<number>();
  readonly merges: MergeRequest[] = [];
  /** 每張單的 merge run 結果（key 是 sub-issue #A）；沒給就丟錯（測試沒預期會跑 merge run） */
  readonly mergeResults: Record<number, ReviewResult | ScriptedFailure> = {};
  /** 這些單的 merge run 回報 pass，卻沒在 agent/<S> 上合出東西 */
  readonly mergeless = new Set<number>();

  constructor(
    private readonly results: Record<number, ScriptedRun>,
    images: string[] = [],
    private readonly dockerfileText = "FROM node\n",
    private readonly reviewResults: Record<number, ReviewResult | ScriptedFailure> = {},
    private readonly host?: { git: FakeGit; clock: FakeClock; botClonePath: string; minutesPerRun?: number },
  ) {
    this.images = new Set(images);
  }

  /** 換掉某張單之後 run 的結果（重接時第二次 run 回不一樣的東西） */
  script(n: number, result: ImplementResult, review: ReviewResult = reviewResult()) {
    this.results[n] = result;
    this.reviewResults[n] = review;
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
    if (this.host && !this.commitless.has(req.issue.number)) this.host.git.commit(req.branch, testConfig.gitAuthor);
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
  async merge(req: MergeRequest) {
    if (!this.images.has(req.imageTag)) throw new Error(`Image '${req.imageTag}' not found locally`);
    if (req.signal.aborted) throw req.signal.reason;
    this.merges.push(req);
    const result = this.mergeResults[req.issue.number];
    if (!result) throw new Error(`fake sandbox: no scripted merge result for #${req.issue.number}`);
    if ("throws" in result) throw result.throws;
    if (result.outcome === "pass" && this.host && !this.mergeless.has(req.issue.number)) this.host.git.agentMerges(req.branch, req.source);
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
  /** 合併有衝突時 merge run 的結果（key 是 sub-issue #A） */
  merges?: Record<number, ReviewResult | ScriptedFailure>;
  images?: string[];
  nvmrc?: string;
  now?: Date;
  /** 每次實作 run 讓假時鐘前進幾分鐘（算 Slack 訊息裡的「花多久」） */
  minutesPerRun?: number;
}) {
  const nvmrcKey = `origin/${testConfig.baseBranch}:${testConfig.nvmrcPath}`;
  const clock = new FakeClock(opts.now ?? new Date("2026-10-04T15:00:00Z"));
  const github = new FakeGitHub(opts.issues);
  const git = new FakeGit({ [nvmrcKey]: opts.nvmrc ?? "22.16.0" }, (branch) => github.onPush(branch));
  const sandbox = new FakeSandbox(opts.results, opts.images, undefined, opts.reviews, { git, clock, botClonePath: testConfig.botClonePath, minutesPerRun: opts.minutesPerRun });
  Object.assign(sandbox.mergeResults, opts.merges);
  return {
    github,
    git,
    sandbox,
    notifier: new FakeNotifier(),
    clock,
    lock: new FakeLock(),
    runState: new FakeRunState(),
    power: new FakePower(),
    stopSignal: new AbortController().signal,
  } satisfies Deps;
}

/** 人要 runner 重做：拿掉 issue 上的 assignee（全過的單會留著操作者），再貼回 agent-runner。 */
export function humanRequeues(deps: ReturnType<typeof fakeDeps>, n: number): void {
  const target = deps.github.issue(n);
  target.assignees = [];
  target.labels.push("agent-runner");
}
