import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AutoOffSchedule } from "./autoOff.js";
import type { Notifier } from "./ports.js";

/** `agent-runner-failure.service`（`OnFailure=`）看到的那次失敗 */
export interface RunnerFailure {
  /** 失敗的 unit（`$MONITOR_UNIT`） */
  unit: string;
  /** systemd 的 Result：exit-code、timeout、signal…（`$MONITOR_SERVICE_RESULT`） */
  result: string;
  /** 那個 unit 的 journal 最後幾行（`journalctl -o cat`） */
  journal: string[];
}

export interface FailureDeps {
  notifier: Notifier;
  stateDir: string;
  now: Date;
  /** 「一晚」在自動關那一刻結束（平日 08:00 Asia/Taipei） */
  nightEndsAt: AutoOffSchedule;
}

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** `<stateDir>/failure-notified.json`：這一晚已經通知過的原因 */
interface NotifiedRecord {
  night: string;
  reasons: string[];
}

/**
 * runner 自己失敗時發一則 Slack，附 journal 最後幾行。同一原因一晚只發一次（不然 runner 壞掉會每輪洗版）：
 * 一晚 = 到下一次自動關的時間點為止；原因 = systemd 的 Result，exit-code 再加上錯誤訊息那一行。
 * 發出去才記；Slack 拒收就 throw，下次同一原因還會再試。
 */
export async function reportFailure(deps: FailureDeps, failure: RunnerFailure): Promise<void> {
  const path = join(deps.stateDir, "failure-notified.json");
  const night = nightOf(deps.now, deps.nightEndsAt);
  const reason = reasonOf(failure);
  const record = await readRecord(path);
  const sent = record?.night === night ? record.reasons : [];
  if (sent.includes(reason)) return;

  const text = [`💥 agent-runner 自己失敗了：\`${failure.unit}\`（${failure.result}）`, "```", ...failure.journal.map(escape), "```"].join("\n");
  await deps.notifier.notify(text);

  await mkdir(deps.stateDir, { recursive: true });
  await writeFile(path, `${JSON.stringify({ night, reasons: [...sent, reason] } satisfies NotifiedRecord, null, 2)}\n`);
}

async function readRecord(path: string): Promise<NotifiedRecord | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as NotifiedRecord;
  } catch {
    // 沒有記錄、或記錄壞掉 → 當作這一晚還沒通知過（寧可多發一則）
    return undefined;
  }
}

/** 這一晚的名字：`now` 往回推 hour:minute 之後、在那個時區的日期（08:00 前算前一晚） */
function nightOf(now: Date, endsAt: AutoOffSchedule): string {
  const shifted = new Date(now.getTime() - (endsAt.hour * 60 + endsAt.minute) * 60_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: endsAt.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(shifted);
}

/**
 * exit-code 才看錯誤訊息：取最後一行不是 stack frame、不是 node 版本、不是 systemd 自己講的話的那一行。
 * timeout／signal 之類只看 Result —— 被砍時最後印的是什麼不固定，拿它當原因會每次都不一樣。
 */
function reasonOf({ unit, result, journal }: RunnerFailure): string {
  if (result !== "exit-code") return `${unit} ${result}`;
  const message = [...journal].reverse().find((line) => line.trim() && !NOISE.some((re) => re.test(line)));
  return `${unit} ${result} ${message?.trim() ?? ""}`;
}

const NOISE = [/^\s+at /, /^Node\.js v\d/, /^\s*\^+\s*$/, /^agent-runner[\w-]*\.service: /, /^(Failed to start|Started|Starting|Finished|Stopped|Stopping) /];
