import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { IN_PROGRESS_LABEL, RUNNER_LABEL } from "./names.js";
import type { GitHub, NewPr } from "./ports.js";
import type { Issue } from "./types.js";

const run = promisify(execFile);

/** `gh issue list --json` 的一筆（只列用到的欄位；形狀見 test/fixtures/issue-list-with-parent.trimmed.json） */
interface GhIssue {
  number: number;
  title: string;
  body: string;
  author: { login: string };
  labels: { name: string }[];
  assignees: { login: string }[];
  parent: { number: number } | null;
  subIssuesSummary: { total: number };
  /** 含已關的 blocker，只拿來判斷要不要再查 open 的數量 */
  blockedBy: { totalCount: number };
}

const ISSUE_FIELDS = "number,title,body,labels,assignees,author,parent,subIssuesSummary,blockedBy";

type ListedIssue = Omit<Issue, "parentLabels" | "parentTitle" | "parentBody" | "openBlockerCount"> & { blockerCount: number };

/** parent 的 labels／標題／內文與 open blocker 數不在 list 輸出裡，listCandidates() 另外查 */
export function parseIssues(json: string): ListedIssue[] {
  return (JSON.parse(json) as GhIssue[]).map((i) => ({
    number: i.number,
    title: i.title,
    body: i.body,
    author: i.author.login,
    labels: i.labels.map((l) => l.name),
    assignees: i.assignees.map((a) => a.login),
    parentNumber: i.parent?.number ?? null,
    subIssueCount: i.subIssuesSummary.total,
    blockerCount: i.blockedBy.totalCount,
  }));
}

/** 操作者的 `gh`。所有指令都帶 `-R <repo>`，不依賴 cwd。 */
export function createGitHub(opts: { repo: string; pickSearch: string; ghBin?: string; env?: NodeJS.ProcessEnv }): GitHub {
  const { repo, pickSearch, ghBin = "gh", env = process.env } = opts;

  async function gh(args: string[]): Promise<string> {
    try {
      const { stdout } = await run(ghBin, args, { env, maxBuffer: 64 * 1024 * 1024 });
      return stdout;
    } catch (err) {
      const e = err as { stderr?: string; message: string };
      throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${(e.stderr || e.message).trim()}`);
    }
  }

  async function parentOf(issue: number): Promise<{ labels: string[]; title: string; body: string }> {
    const stdout = await gh(["issue", "view", String(issue), "-R", repo, "--json", "labels,title,body"]);
    const parent = JSON.parse(stdout) as { labels: { name: string }[]; title: string; body: string };
    return { labels: parent.labels.map((l) => l.name), title: parent.title, body: parent.body };
  }

  async function openBlockerCountOf(issue: number): Promise<number> {
    const stdout = await gh(["api", `repos/${repo}/issues/${issue}`]);
    return (JSON.parse(stdout) as { issue_dependencies_summary: { blocked_by: number } }).issue_dependencies_summary.blocked_by;
  }

  /** body 有反引號、多行，一律走 --body-file */
  async function withBodyFile<T>(body: string, fn: (path: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "agent-runner-"));
    const path = join(dir, "body.md");
    try {
      await writeFile(path, body);
      return await fn(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  return {
    async listCandidates() {
      // gh 預設 --limit 30、新到舊；順序交給 decide()
      const stdout = await gh([
        "issue", "list", "-R", repo,
        "--author", "@me", "--label", RUNNER_LABEL, "--state", "open",
        "--search", pickSearch, "--limit", "200", "--json", ISSUE_FIELDS,
      ]);
      const issues = parseIssues(stdout);
      // decide() 要知道 parent 是不是 wayfinder:map；spec 的 sub-issue 要把 parent 的標題、內文給 agent。同一個 parent 只查一次
      const parentNumbers = [...new Set(issues.flatMap((i) => (i.parentNumber === null ? [] : [i.parentNumber])))];
      const parents = new Map(await Promise.all(parentNumbers.map(async (n) => [n, await parentOf(n)] as const)));
      // blockedBy 含已關的 blocker；有的才用 REST 的 issue_dependencies_summary.blocked_by 查 open 的數量
      const openBlockers = await Promise.all(issues.map((i) => (i.blockerCount === 0 ? 0 : openBlockerCountOf(i.number))));
      return issues.map(({ blockerCount: _b, ...i }, at) => {
        const parent = i.parentNumber === null ? undefined : parents.get(i.parentNumber);
        return {
          ...i,
          parentLabels: parent?.labels ?? [],
          parentTitle: parent?.title ?? "",
          parentBody: parent?.body ?? "",
          openBlockerCount: openBlockers[at] ?? 0,
        };
      });
    },
    async listInProgress() {
      const stdout = await gh([
        "issue", "list", "-R", repo,
        "--label", IN_PROGRESS_LABEL, "--state", "open", "--limit", "200", "--json", ISSUE_FIELDS,
      ]);
      return parseIssues(stdout);
    },
    async createLabel(name, { color, description }) {
      // 不帶 --force：已經有就不動（人可能改過顏色或說明）。gh 對已存在的 label 回 exit 1 + "already exists"
      try {
        await gh(["label", "create", name, "-R", repo, "--color", color, "--description", description]);
      } catch (err) {
        if (!/already exists/.test((err as Error).message)) throw err;
      }
    },
    async addLabel(issue, label) {
      await gh(["issue", "edit", String(issue), "-R", repo, "--add-label", label]);
    },
    async removeLabel(issue, label) {
      await gh(["issue", "edit", String(issue), "-R", repo, "--remove-label", label]);
    },
    async assign(issue, login) {
      await gh(["issue", "edit", String(issue), "-R", repo, "--add-assignee", login]);
    },
    async unassign(issue, login) {
      await gh(["issue", "edit", String(issue), "-R", repo, "--remove-assignee", login]);
    },
    async comment(issue, body) {
      await withBodyFile(body, (path) => gh(["issue", "comment", String(issue), "-R", repo, "--body-file", path]));
    },
    async closeIssue(issue) {
      await gh(["issue", "close", String(issue), "-R", repo]);
    },
    async createPr(pr: NewPr) {
      const stdout = await withBodyFile(pr.body, (path) =>
        gh([
          "pr", "create", "-R", repo,
          "--base", pr.base, "--head", pr.head, "--title", pr.title, "--body-file", path,
          "--assignee", pr.assignee, ...(pr.draft ? ["--draft"] : []),
        ]),
      );
      // gh pr create 沒有 --json，成功時 stdout 印 PR URL
      const url = stdout.trim().split("\n").pop() ?? "";
      const match = /\/pull\/(\d+)$/.exec(url);
      if (!match) throw new Error(`gh pr create: unexpected output ${JSON.stringify(stdout)}`);
      return { number: Number(match[1]), url };
    },
    async findOpenPr(head) {
      const stdout = await gh(["pr", "list", "-R", repo, "--head", head, "--state", "open", "--json", "number,url,isDraft,body"]);
      const [pr] = JSON.parse(stdout) as { number: number; url: string; isDraft: boolean; body: string }[];
      return pr ? { number: pr.number, url: pr.url, isDraft: pr.isDraft, body: pr.body } : null;
    },
    async updatePr(number, { title, body }) {
      await withBodyFile(body, (path) => gh(["pr", "edit", String(number), "-R", repo, "--title", title, "--body-file", path]));
    },
    async markPrDraft(number) {
      await gh(["pr", "ready", String(number), "-R", repo, "--undo"]);
    },
  };
}
