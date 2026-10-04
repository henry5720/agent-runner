/**
 * `bin/agent-runner` 需要讀設定或碰 adapter 的子指令都進這裡：`node --import tsx src/cli.ts <command>`。
 * 一輪本身是 src/main.ts。
 */
import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { systemClock } from "./clock.js";
import { config } from "./config.js";
import { reportFailure } from "./failure.js";
import { createGit } from "./git.js";
import { cleanWorktrees, rebuildImage } from "./maintenance.js";
import { consoleNotifier, createSlackNotifier } from "./notifier.js";
import { createSandbox } from "./sandbox.js";
import { writeTimerDropins } from "./systemd.js";
import { readSecrets, slackWebhookUrl } from "./secrets.js";

const run = promisify(execFile);
const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "rebuild": {
    // build 用不到 token
    const sandbox = createSandbox(config, { CLAUDE_CODE_OAUTH_TOKEN: "" });
    const tag = await rebuildImage(config, { git: createGit({ repoPath: config.botClonePath }), sandbox });
    console.log(`rebuild：${tag}`);
    break;
  }

  case "clean-worktrees": {
    const removed = await cleanWorktrees({ git: createGit({ repoPath: config.botClonePath }), clock: systemClock }, { all: args.includes("--all") });
    console.log(removed.length ? removed.map((p) => `刪掉 ${p}`).join("\n") : "沒有要刪的 worktree");
    break;
  }

  case "clean-store": {
    await rm(config.pnpmStorePath, { recursive: true, force: true });
    await mkdir(config.pnpmStorePath, { recursive: true });
    console.log(`clean-store：清空 ${config.pnpmStorePath}，下一輪 pnpm install 會重新下載`);
    break;
  }

  // agent-runner-failure.service（OnFailure=）叫的。systemd 用 $MONITOR_* 告訴它是哪個 unit、怎麼失敗
  case "notify-failure": {
    const unit = process.env.MONITOR_UNIT || "agent-runner.service";
    const invocation = process.env.MONITOR_INVOCATION_ID ? [`--invocation=${process.env.MONITOR_INVOCATION_ID}`] : ["-I"];
    // 讀不到 journal 也要發：通知比尾巴重要
    const journal = await run("journalctl", ["--user", "-u", unit, ...invocation, "-n", "20", "-o", "cat", "--no-pager"]).then(
      ({ stdout }) => stdout.trimEnd().split("\n"),
      (err: { stderr?: string }) => [`（讀不到 journal：${err.stderr?.trim() || String(err)}）`],
    );
    const webhookUrl = slackWebhookUrl(readSecrets(config.secretsFile));
    await reportFailure(
      { notifier: webhookUrl ? createSlackNotifier(webhookUrl) : consoleNotifier, stateDir: config.stateDir, now: systemClock.now(), nightEndsAt: config.autoOff },
      { unit, result: process.env.MONITOR_SERVICE_RESULT || "unknown", journal },
    );
    break;
  }

  // `agent-runner on`／`update`、install.sh 叫的：timer 的間隔與自動關時間從 config 寫成 drop-in，之後要 daemon-reload
  case "write-timer-dropins": {
    const [unitDir] = args;
    if (!unitDir) throw new Error("write-timer-dropins <unit dir>");
    for (const path of await writeTimerDropins(config, unitDir)) console.log(`寫入 ${path}`);
    break;
  }

  // install.sh 用 eval 讀，路徑與身分只在 src/config.ts 寫一次
  case "install-env": {
    const quote = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`;
    const vars = {
      REPO: config.repo,
      BOT_CLONE: config.botClonePath,
      GIT_AUTHOR: config.gitAuthor,
      PNPM_STORE: config.pnpmStorePath,
      SECRETS_FILE: config.secretsFile,
    };
    console.log(
      Object.entries(vars)
        .map(([k, v]) => `${k}=${quote(v)}`)
        .join("\n"),
    );
    break;
  }

  default:
    console.error(`agent-runner: 不認得的指令 ${command ?? "（空）"}`);
    process.exit(2);
}
