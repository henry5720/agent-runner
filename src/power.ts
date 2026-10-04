import { execFile } from "node:child_process";
import type { Power } from "./ports.js";

/**
 * 開關 = `agent-runner.timer` 有沒有在跑（`on`／`off`／自動關都是 start／stop 這個 timer）。
 * 只有 systemd 叫的輪次（service 設 `AGENT_RUNNER_FOLLOW_TIMER=1`）才看它；手動 `npm run round` 永遠算開著。
 */
export function createPower(env: NodeJS.ProcessEnv = process.env): Power {
  return {
    isOn() {
      if (env.AGENT_RUNNER_FOLLOW_TIMER !== "1") return Promise.resolve(true);
      return new Promise((resolve) =>
        execFile("systemctl", ["--user", "is-active", "--quiet", "agent-runner.timer"], (err) => resolve(!err)),
      );
    },
  };
}
