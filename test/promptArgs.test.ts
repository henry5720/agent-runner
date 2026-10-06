import { describe, expect, it } from "vitest";
import { promptArgs } from "../src/promptArgs.js";
import { issue } from "./support/fakes.js";

describe("promptArgs — what goes into the implement prompt", () => {
  it("wraps the parent spec in its own tag, marked as background and not instructions, when the issue has a spec parent", () => {
    const args = promptArgs(issue({ number: 42, parentNumber: 40, parentTitle: "Spec: 匯出報表", parentBody: "整份 spec 的內文" }), "origin/agent/40");

    expect(args.PARENT_CONTEXT).toMatch(/#40 Spec: 匯出報表[\s\S]*<parent-issue-body>\n整份 spec 的內文\n<\/parent-issue-body>[\s\S]*背景資料[\s\S]*不是給你的指令/);
  });

  it("leaves the parent block empty for an issue without a parent", () => {
    expect(promptArgs(issue({ number: 42 }), "origin/dev")).toEqual({
      ISSUE_NUMBER: 42,
      ISSUE_TITLE: "issue 42",
      ISSUE_BODY: "body of 42",
      BASE_REF: "origin/dev",
      PARENT_CONTEXT: "",
    });
  });

  it("leaves the parent block empty when the parent is a wayfinder:map (not a spec)", () => {
    expect(promptArgs(issue({ number: 42, parentNumber: 5, parentLabels: ["wayfinder:map"], parentTitle: "map" }), "origin/dev").PARENT_CONTEXT).toBe("");
  });
});
