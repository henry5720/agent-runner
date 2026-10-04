/** 跑一輪：`npm run round`，或 systemd 的 `agent-runner.service`（`agent-runner on` 之後每 60 分鐘）。 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { systemClock } from "./clock.js";
import { config } from "./config.js";
import { createGit } from "./git.js";
import { createGitHub } from "./github.js";
import { createFlock } from "./lock.js";
import { consoleNotifier } from "./notifier.js";
import { createPower } from "./power.js";
import { runRound } from "./runRound.js";
import { createRunStateFile } from "./runState.js";
import { createSandbox } from "./sandbox.js";

/** KEY=VALUE，忽略空行與 # 註解 */
function readSecrets(path: string): Record<string, string> {
  const entries = readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const at = l.indexOf("=");
      return [l.slice(0, at).replace(/^export\s+/, ""), l.slice(at + 1).replace(/^["']|["']$/g, "")] as const;
    });
  return Object.fromEntries(entries);
}

const secrets = readSecrets(config.secretsFile);
const token = secrets.CLAUDE_CODE_OAUTH_TOKEN;
if (!token) throw new Error(`CLAUDE_CODE_OAUTH_TOKEN missing in ${config.secretsFile}`);

await runRound(config, {
  github: createGitHub({ repo: config.repo, pickSearch: config.pickSearch }),
  git: createGit({ repoPath: config.botClonePath }),
  sandbox: createSandbox(config, { CLAUDE_CODE_OAUTH_TOKEN: token }),
  notifier: consoleNotifier,
  clock: systemClock,
  lock: createFlock(join(config.stateDir, "round.lock")),
  runState: createRunStateFile(config.stateDir),
  power: createPower(),
});
