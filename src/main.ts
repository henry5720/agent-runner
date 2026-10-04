/** 跑一輪：`npm run round`。之後由 systemd timer 叫（#2702）。 */
import { readFileSync } from "node:fs";
import { systemClock } from "./clock.js";
import { config } from "./config.js";
import { createGit } from "./git.js";
import { createGitHub } from "./github.js";
import { consoleNotifier } from "./notifier.js";
import { runRound } from "./runRound.js";
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
});
