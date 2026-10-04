import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reportFailure, type RunnerFailure } from "../src/failure.js";
import { FakeNotifier, testConfig } from "./support/fakes.js";

const stateDir = () => join(mkdtempSync(join(tmpdir(), "agent-runner-failure-")), "agent-runner");

/** node 沒接住的錯誤在 journal 裡長這樣（`journalctl -o cat`） */
function crash(message: string, overrides: Partial<RunnerFailure> = {}): RunnerFailure {
  return {
    unit: "agent-runner.service",
    result: "exit-code",
    journal: [
      "file:///home/ubuntu/agents/agent-runner/src/main.ts:30",
      "  throw new Error(...)",
      "        ^",
      "",
      `Error: ${message}`,
      "    at file:///home/ubuntu/agents/agent-runner/src/main.ts:30:17",
      "    at ModuleJob.run (node:internal/modules/esm/module_job:271:25)",
      "",
      "Node.js v22.16.0",
    ],
    ...overrides,
  };
}

function setup() {
  const notifier = new FakeNotifier();
  const dir = stateDir();
  const at = (iso: string) => reportFailure.bind(null, { notifier, stateDir: dir, now: new Date(iso), nightEndsAt: testConfig.autoOff });
  return { notifier, dir, at };
}

describe("runner failure notice", () => {
  it("tells the operator which unit failed, how, and the last journal lines", async () => {
    const { notifier, at } = setup();

    await at("2026-10-04T15:00:00Z")(crash("CLAUDE_CODE_OAUTH_TOKEN missing"));

    expect(notifier.messages).toEqual([
      [
        "💥 agent-runner 自己失敗了：`agent-runner.service`（exit-code）",
        "```",
        "file:///home/ubuntu/agents/agent-runner/src/main.ts:30",
        "  throw new Error(...)",
        "        ^",
        "",
        "Error: CLAUDE_CODE_OAUTH_TOKEN missing",
        "    at file:///home/ubuntu/agents/agent-runner/src/main.ts:30:17",
        "    at ModuleJob.run (node:internal/modules/esm/module_job:271:25)",
        "",
        "Node.js v22.16.0",
        "```",
      ].join("\n"),
    ]);
  });

  it("stays quiet when the same reason fails again the same night", async () => {
    const { notifier, at } = setup();

    await at("2026-10-04T15:00:00Z")(crash("gh: HTTP 502"));
    await at("2026-10-04T16:00:00Z")(crash("gh: HTTP 502"));

    expect(notifier.messages).toHaveLength(1);
  });

  it("posts again when a different error fails the runner the same night", async () => {
    const { notifier, at } = setup();

    await at("2026-10-04T15:00:00Z")(crash("gh: HTTP 502"));
    await at("2026-10-04T16:00:00Z")(crash("docker: no space left on device"));

    expect(notifier.messages).toHaveLength(2);
  });

  it("posts the same reason again once the night is over at 08:00 Asia/Taipei", async () => {
    const { notifier, at } = setup();

    // 07:59 與 08:00 Asia/Taipei（UTC+8）
    await at("2026-10-04T23:59:00Z")(crash("gh: HTTP 502"));
    await at("2026-10-05T00:00:00Z")(crash("gh: HTTP 502"));

    expect(notifier.messages).toHaveLength(2);
  });

  it("counts the night from the evening before, so 01:00 and 07:00 are the same night as 22:00", async () => {
    const { notifier, at } = setup();

    await at("2026-10-04T14:00:00Z")(crash("gh: HTTP 502"));
    await at("2026-10-04T17:00:00Z")(crash("gh: HTTP 502"));
    await at("2026-10-04T23:00:00Z")(crash("gh: HTTP 502"));

    expect(notifier.messages).toHaveLength(1);
  });

  it("treats every timeout of the same unit as one reason, whatever it printed last", async () => {
    const { notifier, at } = setup();
    const timeout = (lastLine: string) => ({ unit: "agent-runner.service", result: "timeout", journal: ["[sandbox] pnpm install", lastLine] });

    await at("2026-10-04T15:00:00Z")(timeout("[sandbox] running vitest"));
    await at("2026-10-04T18:00:00Z")(timeout("[sandbox] running playwright"));

    expect(notifier.messages).toHaveLength(1);
  });

  it("ignores stack frames when deciding the reason is the same", async () => {
    const { notifier, at } = setup();
    const withTrailer = (frame: string) =>
      crash("gh: HTTP 502", {
        journal: ["Error: gh: HTTP 502", `    at ${frame}`, "Node.js v22.16.0"],
      });

    await at("2026-10-04T15:00:00Z")(withTrailer("listCandidates (src/github.ts:40:11)"));
    await at("2026-10-04T16:00:00Z")(withTrailer("comment (src/github.ts:88:5)"));

    expect(notifier.messages).toHaveLength(1);
  });

  it("tries again next time when Slack did not take the notice", async () => {
    const { notifier, dir, at } = setup();
    const rejecting = { notify: () => Promise.reject(new Error("Slack webhook 回 500")) };
    await reportFailure({ notifier: rejecting, stateDir: dir, now: new Date("2026-10-04T15:00:00Z"), nightEndsAt: testConfig.autoOff }, crash("gh: HTTP 502")).catch(() => {});

    await at("2026-10-04T16:00:00Z")(crash("gh: HTTP 502"));

    expect(notifier.messages).toHaveLength(1);
  });
});
