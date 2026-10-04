import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunState } from "./ports.js";

/** `<stateDir>/current`：一行 `#<N> <title>`，沒在跑就不存在。`agent-runner status` 直接讀。 */
export function createRunStateFile(stateDir: string): RunState {
  const path = join(stateDir, "current");
  return {
    async setCurrent(issue) {
      if (!issue) return rm(path, { force: true });
      await mkdir(stateDir, { recursive: true });
      await writeFile(path, `#${issue.number} ${issue.title}\n`);
    },
  };
}
