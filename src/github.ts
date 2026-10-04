import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
}

const ISSUE_FIELDS = "number,title,body,labels,assignees,author,parent,subIssuesSummary";

export function parseIssues(json: string): Issue[] {
  return (JSON.parse(json) as GhIssue[]).map((i) => ({
    number: i.number,
    title: i.title,
    body: i.body,
    author: i.author.login,
    labels: i.labels.map((l) => l.name),
    assignees: i.assignees.map((a) => a.login),
    parentNumber: i.parent?.number ?? null,
    subIssueCount: i.subIssuesSummary.total,
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
        "--author", "@me", "--label", "ready-for-agent", "--state", "open",
        "--search", pickSearch, "--limit", "200", "--json", ISSUE_FIELDS,
      ]);
      return parseIssues(stdout);
    },
    async createLabel(name, { color, description }) {
      await gh(["label", "create", name, "-R", repo, "--color", color, "--description", description, "--force"]);
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
    async comment(issue, body) {
      await withBodyFile(body, (path) => gh(["issue", "comment", String(issue), "-R", repo, "--body-file", path]));
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
  };
}
