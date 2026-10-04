import { describe, expect, it } from "vitest";
import { runRound } from "../src/runRound.js";
import { fakeDeps, issue, passResult, testConfig } from "./support/fakes.js";

describe("runRound — happy path", () => {
  it("opens a draft PR into dev from agent/<N>, assigned to the operator, closing the issue", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult({ prTitle: "feat(x): add y" }) } });

    await runRound(testConfig, deps);

    expect(deps.github.prs).toEqual([
      expect.objectContaining({
        base: "dev",
        head: "agent/42",
        draft: true,
        title: "feat(x): add y",
        assignee: "henry5720",
        body: expect.stringContaining("Closes #42"),
      }),
    ]);
  });

  it("leaves the issue with no runner labels, assigned to the operator, with a pickup comment", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult() } });

    await runRound(testConfig, deps);

    expect(deps.github.issue(42)).toMatchObject({
      labels: [],
      assignees: ["henry5720"],
      comments: [expect.stringContaining("已接單")],
    });
  });

  it("creates the agent-in-progress label when the repo does not have it", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult() } });

    await runRound(testConfig, deps);

    expect(deps.github.repoLabels).toContain("agent-in-progress");
  });

  it("pushes agent/<N> starting from origin/dev before opening the PR", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult() } });

    await runRound(testConfig, deps);

    expect(deps.git.remoteBranches.get("agent/42")).toEqual({ base: "origin/dev", fetchedFirst: true });
  });

  it("writes the summary and the verification commands the agent reported into the PR body", async () => {
    const deps = fakeDeps({
      issues: [issue({ number: 42 })],
      results: {
        42: passResult({
          summary: "加了 y 按鈕",
          verification: [{ command: "pnpm test run src/app/modules/x", result: "12 passed" }],
        }),
      },
    });

    await runRound(testConfig, deps);

    const body = deps.github.prs[0]?.body ?? "";
    expect([body.includes("加了 y 按鈕"), body.includes("pnpm test run src/app/modules/x"), body.includes("12 passed")]).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("gives the sandbox the issue it picked and only the agent/<N> branch", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42, title: "加 y", body: "請加 y" })], results: { 42: passResult() } });

    await runRound(testConfig, deps);

    expect(deps.sandbox.runs).toEqual([
      expect.objectContaining({ branch: "agent/42", issue: expect.objectContaining({ number: 42, title: "加 y", body: "請加 y" }) }),
    ]);
  });

  it("does not touch issues that decide() did not pick", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 7, author: "someone-else" })], results: {} });

    await runRound(testConfig, deps);

    expect(deps.github.issue(7)).toMatchObject({ labels: ["ready-for-agent"], assignees: [], comments: [] });
  });
});

describe("runRound — sandbox image", () => {
  it("builds the image when the tag for the current Dockerfile + .nvmrc is missing, and runs on it", async () => {
    const deps = fakeDeps({ issues: [issue({ number: 42 })], results: { 42: passResult() }, nvmrc: "22.16.0" });

    await runRound(testConfig, deps);

    expect(deps.sandbox.builtImages).toEqual([{ tag: deps.sandbox.runs[0]?.imageTag, nodeVersion: "22.16.0" }]);
  });

  it("does not rebuild an image that already exists", async () => {
    const first = fakeDeps({ issues: [], results: {} });
    await runRound(testConfig, first);
    const existing = first.sandbox.builtImages[0]!.tag;

    const deps = fakeDeps({ issues: [], results: {}, images: [existing] });
    await runRound(testConfig, deps);

    expect(deps.sandbox.builtImages).toEqual([]);
  });
});
