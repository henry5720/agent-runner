/** 跑一輪：`npm run round`，或 systemd 的 `agent-runner.service`（`agent-runner on` 之後每 `roundIntervalMinutes` 分鐘）。 */
import { join } from "node:path";
import { systemClock } from "./clock.js";
import { config } from "./config.js";
import { createGit } from "./git.js";
import { createGitHub } from "./github.js";
import { createFlock } from "./lock.js";
import { consoleNotifier, createSlackNotifier } from "./notifier.js";
import { createPower } from "./power.js";
import { runRound } from "./runRound.js";
import { createRunStateFile } from "./runState.js";
import { createSandbox } from "./sandbox.js";
import { readSecrets, slackWebhookUrl } from "./secrets.js";

const secrets = readSecrets(config.secretsFile);
const token = secrets.CLAUDE_CODE_OAUTH_TOKEN;
if (!token) throw new Error(`CLAUDE_CODE_OAUTH_TOKEN missing in ${config.secretsFile}`);

// 沒設 webhook 就只印 stdout，照樣做單
const webhookUrl = slackWebhookUrl(secrets);
if (!webhookUrl) console.warn(`[notify] AGENT_RUNNER_SLACK_WEBHOOK_URL 沒設（env 或 ${config.secretsFile}），通知只印到 stdout`);

// `agent-runner off --now` = systemctl stop，unit 設 KillSignal=SIGUSR2。不用 SIGTERM：sandcastle 自己掛了
// SIGTERM handler，收到就 docker rm -f 然後 process.exit(1)，crash 收尾（gh 留言、改 label）會來不及跑。
const stop = new AbortController();
process.once("SIGUSR2", () => {
  console.error("agent-runner: off --now，中斷正在做的那張、照 crash 收尾");
  stop.abort(new Error("off --now"));
});

await runRound(config, {
  github: createGitHub({ repo: config.repo, pickSearch: config.pickSearch }),
  git: createGit({ repoPath: config.botClonePath }),
  sandbox: createSandbox(config, { CLAUDE_CODE_OAUTH_TOKEN: token }),
  notifier: webhookUrl ? createSlackNotifier(webhookUrl) : consoleNotifier,
  clock: systemClock,
  lock: createFlock(join(config.stateDir, "round.lock")),
  runState: createRunStateFile(config.stateDir),
  power: createPower(),
  stopSignal: stop.signal,
});
