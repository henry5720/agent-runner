import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRunStateFile } from "../src/runState.js";

// `agent-runner status` 直接 cat 這個檔，所以格式就是要給人看的那一行
const stateDir = () => join(mkdtempSync(join(tmpdir(), "agent-runner-state-")), "agent-runner");

describe("run state file", () => {
  it("writes the running issue as one line status can print", async () => {
    const dir = stateDir();

    await createRunStateFile(dir).setCurrent({ number: 42, title: "加 y" });

    expect(readFileSync(join(dir, "current"), "utf8")).toBe("#42 加 y\n");
  });

  it("removes the file when nothing is running", async () => {
    const dir = stateDir();
    const state = createRunStateFile(dir);
    await state.setCurrent({ number: 42, title: "加 y" });

    await state.setCurrent(null);

    expect(existsSync(join(dir, "current"))).toBe(false);
  });
});
