import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitHub } from "../src/github.js";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const fakeGh = join(import.meta.dirname, "support", "fake-gh.mjs");

/** 把 adapter 接到假的 gh，回傳 adapter 與「gh 被怎麼叫」的紀錄。 */
function withFakeGh(responses: { match: string[]; stdout?: string; stderr?: string; code?: number }[]) {
  const dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
  const log = join(dir, "log.jsonl");
  const responsesFile = join(dir, "responses.json");
  writeFileSync(log, "");
  writeFileSync(responsesFile, JSON.stringify(responses));
  const github = createGitHub({
    repo: "acme/widgets",
    pickSearch: "-is:blocked no:assignee",
    ghBin: fakeGh,
    env: { ...process.env, FAKE_GH_LOG: log, FAKE_GH_RESPONSES: responsesFile },
  });
  const calls = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { argv: string[]; bodyFile?: string });
  return { github, calls };
}

describe("github adapter against recorded gh output", () => {
  it("parses `gh issue list --json` into issues with author, labels, parent (and its labels) and sub-issue count", async () => {
    const { github } = withFakeGh([
      { match: ["issue", "list"], stdout: fixture("issue-list-with-parent.trimmed.json") },
      { match: ["issue", "view", "2283"], stdout: fixture("issue-view-labels-wayfinder-map.json") },
    ]);

    const issues = await github.listCandidates();

    expect(issues).toEqual([
      {
        number: 2692,
        title: "<redacted title 2692>",
        body: "<redacted body>",
        author: "henry5720",
        labels: ["ready-for-agent"],
        assignees: [],
        parentNumber: null,
        parentLabels: [],
        subIssueCount: 12,
        openBlockerCount: 0,
      },
      {
        number: 2456,
        title: "<redacted title 2456>",
        body: "<redacted body>",
        author: "henry5720",
        labels: ["ready-for-agent"],
        assignees: [],
        parentNumber: 2283,
        parentLabels: ["wayfinder:map"],
        subIssueCount: 6,
        openBlockerCount: 0,
      },
      {
        number: 2326,
        title: "<redacted title 2326>",
        body: "<redacted body>",
        author: "henry5720",
        labels: ["ready-for-agent"],
        assignees: [],
        parentNumber: null,
        parentLabels: [],
        subIssueCount: 0,
        openBlockerCount: 0,
      },
    ]);
  });

  it("looks up each distinct parent's labels once, in the configured repo", async () => {
    const list = JSON.stringify([
      { number: 11, title: "a", body: "", author: { login: "henry5720" }, labels: [], assignees: [], parent: { number: 5 }, subIssuesSummary: { total: 0 }, blockedBy: { totalCount: 0 } },
      { number: 12, title: "b", body: "", author: { login: "henry5720" }, labels: [], assignees: [], parent: { number: 5 }, subIssuesSummary: { total: 0 }, blockedBy: { totalCount: 0 } },
    ]);
    const { github, calls } = withFakeGh([
      { match: ["issue", "list"], stdout: list },
      { match: ["issue", "view", "5"], stdout: fixture("issue-view-labels-wayfinder-map.json") },
    ]);

    const issues = await github.listCandidates();

    const views = calls().filter((c) => c.argv[1] === "view");
    expect({ views: views.map((c) => c.argv), labels: issues.map((i) => i.parentLabels) }).toEqual({
      views: [["issue", "view", "5", "-R", "acme/widgets", "--json", "labels"]],
      labels: [["wayfinder:map"], ["wayfinder:map"]],
    });
  });

  it("counts only open blockers, via the REST issue's issue_dependencies_summary", async () => {
    const list = JSON.stringify([
      { number: 2699, title: "a", body: "", author: { login: "henry5720" }, labels: [], assignees: [], parent: null, subIssuesSummary: { total: 0 }, blockedBy: { totalCount: 1 } },
      { number: 3000, title: "b", body: "", author: { login: "henry5720" }, labels: [], assignees: [], parent: null, subIssuesSummary: { total: 0 }, blockedBy: { totalCount: 0 } },
    ]);
    const { github, calls } = withFakeGh([
      { match: ["issue", "list"], stdout: list },
      { match: ["api", "repos/acme/widgets/issues/2699"], stdout: fixture("rest-issue-blocked.trimmed.json") },
    ]);

    const issues = await github.listCandidates();

    expect({
      counts: issues.map((i) => [i.number, i.openBlockerCount]),
      apiCalls: calls().filter((c) => c.argv[0] === "api").map((c) => c.argv),
    }).toEqual({
      counts: [[2699, 1], [3000, 0]],
      // blockedBy 一張都沒有（含已關的）就不用查
      apiCalls: [["api", "repos/acme/widgets/issues/2699"]],
    });
  });

  it("lists only the operator's open ready-for-agent issues in the configured repo with the configured search", async () => {
    const { github, calls } = withFakeGh([{ match: ["issue", "list"], stdout: "[]" }]);

    await github.listCandidates();

    expect(calls()[0]?.argv).toEqual(
      expect.arrayContaining(["-R", "acme/widgets", "--author", "@me", "--label", "ready-for-agent", "--state", "open", "--search", "-is:blocked no:assignee"]),
    );
  });

  it("lists every open agent-in-progress issue in the configured repo, whoever opened it", async () => {
    const { github, calls } = withFakeGh([{ match: ["issue", "list"], stdout: "[]" }]);

    await github.listInProgress();

    const argv = calls()[0]?.argv ?? [];
    expect({
      flags: ["-R", "acme/widgets", "--label", "agent-in-progress", "--state", "open"].every((f) => argv.includes(f)),
      readyLabel: argv.includes("ready-for-agent"),
    }).toEqual({ flags: true, readyLabel: false });
  });

  it("returns the PR number from the URL `gh pr create` prints", async () => {
    const { github } = withFakeGh([{ match: ["pr", "create"], stdout: "https://github.com/acme/widgets/pull/2708\n" }]);

    const pr = await github.createPr({ base: "dev", head: "agent/42", title: "feat: x", body: "Closes #42", draft: true, assignee: "henry5720" });

    expect(pr).toEqual({ number: 2708, url: "https://github.com/acme/widgets/pull/2708" });
  });

  it("opens the PR as a draft into the given base, assigned, without reviewers, body passed via file", async () => {
    const { github, calls } = withFakeGh([{ match: ["pr", "create"], stdout: "https://github.com/acme/widgets/pull/1\n" }]);

    await github.createPr({ base: "dev", head: "agent/42", title: "feat: x", body: "Closes #42\n\n`code`", draft: true, assignee: "henry5720" });

    const call = calls()[0]!;
    expect({
      flags: ["--draft", "--base", "dev", "--head", "agent/42", "--assignee", "henry5720"].every((f) => call.argv.includes(f)),
      reviewer: call.argv.some((a) => a === "--reviewer" || a === "-r"),
      body: call.bodyFile,
    }).toEqual({ flags: true, reviewer: false, body: "Closes #42\n\n`code`" });
  });

  it("surfaces gh's stderr when a command fails", async () => {
    const { github } = withFakeGh([{ match: ["issue", "edit"], stderr: "'agent-in-progress' not found\n", code: 1 }]);

    await expect(github.addLabel(42, "agent-in-progress")).rejects.toThrow(/'agent-in-progress' not found/);
  });
});
