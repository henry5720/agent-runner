/** 自動關的時間表。systemd 那邊對應 `systemd/agent-runner-autooff.timer` 的 `OnCalendar`，改一邊要改另一邊。 */
export interface AutoOffSchedule {
  /** 0 = 星期日 … 6 = 星期六 */
  weekdays: number[];
  hour: number;
  minute: number;
  /** IANA 時區，例如 Asia/Taipei */
  timeZone: string;
}

/** `now` 之後（含 `now` 當下）的下一次自動關。 */
export function nextAutoOff(schedule: AutoOffSchedule, now: Date): Date {
  const local = wallClock(now, schedule.timeZone);
  for (let day = 0; day <= 7; day++) {
    const guess = new Date(Date.UTC(local.year, local.month - 1, local.day + day, schedule.hour, schedule.minute));
    // guess 是把當地牆上時間當成 UTC；扣掉那一刻的時區 offset 才是真的時間點
    const at = new Date(guess.getTime() - offsetMs(guess, schedule.timeZone));
    if (schedule.weekdays.includes(guess.getUTCDay()) && at.getTime() >= now.getTime()) return at;
  }
  throw new Error(`auto-off schedule has no weekdays: ${JSON.stringify(schedule)}`);
}

function wallClock(at: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" })
      .formatToParts(at)
      .map((p) => [p.type, Number(p.value)]),
  );
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute! };
}

function offsetMs(at: Date, timeZone: string): number {
  const w = wallClock(at, timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - Math.floor(at.getTime() / 60_000) * 60_000;
}
