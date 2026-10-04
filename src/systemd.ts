/**
 * systemd timer 的時間從 src/config.ts 來：`agent-runner on`／`update`／`install.sh` 把這裡產生的 drop-in
 * 寫進 `~/.config/systemd/user/<timer>.d/`，`systemd/*.timer` 本身不寫時間。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AutoOffSchedule } from "./autoOff.js";
import type { Config } from "./config.js";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HEADER = "# 由 src/config.ts 產生（agent-runner on／update、install.sh 會重寫），不要手改\n";
const pad = (n: number) => String(n).padStart(2, "0");

/** AutoOffSchedule → systemd OnCalendar（`Mon,Tue *-*-* 08:00:00 Asia/Taipei`） */
function onCalendar({ weekdays, hour, minute, timeZone }: AutoOffSchedule): string {
  return `${weekdays.map((d) => DAYS[d]).join(",")} *-*-* ${pad(hour)}:${pad(minute)}:00 ${timeZone}`;
}

/** unit 目錄底下的相對路徑 → 檔案內容 */
export function timerDropins(config: Pick<Config, "roundIntervalMinutes" | "autoOff">): Record<string, string> {
  return {
    "agent-runner.timer.d/config.conf": `${HEADER}[Timer]\nOnUnitActiveSec=${config.roundIntervalMinutes}min\n`,
    // 空的 OnCalendar= 先清掉別處設的值
    "agent-runner-autooff.timer.d/config.conf": `${HEADER}[Timer]\nOnCalendar=\nOnCalendar=${onCalendar(config.autoOff)}\n`,
  };
}

/** 寫進 unitDir；內容一樣就不動（install.sh 重跑不改東西）。回傳有改的檔案 */
export async function writeTimerDropins(config: Pick<Config, "roundIntervalMinutes" | "autoOff">, unitDir: string): Promise<string[]> {
  const changed: string[] = [];
  for (const [rel, content] of Object.entries(timerDropins(config))) {
    const path = join(unitDir, rel);
    const current = await readFile(path, "utf8").catch(() => null);
    if (current === content) continue;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    changed.push(path);
  }
  return changed;
}
