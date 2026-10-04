import { describe, expect, it } from "vitest";
import { decide } from "../src/decide.js";
import { issue } from "./support/fakes.js";

const now = new Date("2026-10-04T15:00:00Z");
const autoOff = { weekdays: [1, 2, 3, 4, 5], hour: 8, minute: 0, timeZone: "Asia/Taipei" };
const snapshot = (operator: string, candidates: ReturnType<typeof issue>[], maxPerRound = 10) => ({
  operator,
  candidates,
  maxPerRound,
  autoOff,
  timeoutMinutes: 60,
});
const picked = (candidates: ReturnType<typeof issue>[], at: Date) =>
  decide(snapshot("henry5720", candidates), at).flatMap((a) => (a.kind === "pickup" ? [a.issue.number] : []));
const pickedNumbers = (operator: string, candidates: ReturnType<typeof issue>[], maxPerRound = 10) =>
  decide(snapshot(operator, candidates, maxPerRound), now).flatMap((a) => (a.kind === "pickup" ? [a.issue.number] : []));

describe("decide", () => {
  it.each([
    {
      name: "picks the operator's own ready-for-agent issue",
      candidates: [issue({ number: 10 })],
      picked: [10],
    },
    {
      name: "skips issues opened by someone else",
      candidates: [issue({ number: 10, author: "someone-else" })],
      picked: [],
    },
    {
      name: "skips issues without ready-for-agent",
      candidates: [issue({ number: 10, labels: ["bug"] })],
      picked: [],
    },
    {
      name: "picks in ascending issue number order",
      candidates: [issue({ number: 30 }), issue({ number: 7 }), issue({ number: 12 })],
      picked: [7, 12, 30],
    },
    {
      name: "skips wayfinder planning issues (any wayfinder:* label)",
      candidates: [issue({ number: 10, labels: ["ready-for-agent", "wayfinder:map"] }), issue({ number: 11, labels: ["ready-for-agent", "wayfinder:decision"] })],
      picked: [],
    },
    {
      name: "skips spec sub-issues (parent is not a wayfinder:map)",
      candidates: [issue({ number: 10, parentNumber: 5, parentLabels: ["ready-for-agent"] })],
      picked: [],
    },
    {
      name: "picks issues whose parent is a wayfinder:map",
      candidates: [issue({ number: 10, parentNumber: 5, parentLabels: ["wayfinder:map"] })],
      picked: [10],
    },
    {
      name: "skips parent issues (has sub-issues), e.g. the spec itself",
      candidates: [issue({ number: 10, subIssueCount: 12 })],
      picked: [],
    },
    {
      name: "skips issues already assigned to someone",
      candidates: [issue({ number: 10, assignees: ["someone-else"] })],
      picked: [],
    },
    {
      name: "skips issues with an open blocker",
      candidates: [issue({ number: 10, openBlockerCount: 1 })],
      picked: [],
    },
  ])("$name", ({ candidates, picked }) => {
    expect(pickedNumbers("henry5720", candidates)).toEqual(picked);
  });

  it.each([
    { name: "takes at most maxPerRound issues, lowest numbers first", maxPerRound: 2, picked: [7, 12] },
    { name: "takes all when there are fewer than maxPerRound", maxPerRound: 5, picked: [7, 12, 30] },
  ])("$name", ({ maxPerRound, picked }) => {
    const candidates = [issue({ number: 30 }), issue({ number: 7 }), issue({ number: 12 })];
    expect(pickedNumbers("henry5720", candidates, maxPerRound)).toEqual(picked);
  });

  it("counts the cap after filtering, so skipped issues do not use up a slot", () => {
    const candidates = [issue({ number: 1, subIssueCount: 3 }), issue({ number: 2, labels: ["ready-for-agent", "wayfinder:map"] }), issue({ number: 3 }), issue({ number: 4 })];
    expect(pickedNumbers("henry5720", candidates, 1)).toEqual([3]);
  });
});

describe("decide — auto-off (weekdays 08:00 Asia/Taipei = 00:00 UTC, timeout 60 min)", () => {
  it.each([
    { name: "picks when auto-off is exactly one timeout away (Mon 07:00 Taipei)", at: "2026-10-04T23:00:00Z", picked: [10] },
    { name: "does not pick when auto-off is 59 minutes away (Mon 07:01 Taipei)", at: "2026-10-04T23:01:00Z", picked: [] },
    { name: "does not pick right before a weekday auto-off (Fri 07:59 Taipei)", at: "2026-10-08T23:59:00Z", picked: [] },
    { name: "picks right after a weekday auto-off (Fri 08:01 Taipei)", at: "2026-10-09T00:01:00Z", picked: [10] },
    { name: "picks on Sunday 07:30 Taipei because there is no weekend auto-off", at: "2026-10-03T23:30:00Z", picked: [10] },
    { name: "picks on Saturday 07:30 Taipei", at: "2026-10-02T23:30:00Z", picked: [10] },
  ])("$name", ({ at, picked: expected }) => {
    expect(picked([issue({ number: 10 })], new Date(at))).toEqual(expected);
  });
});
