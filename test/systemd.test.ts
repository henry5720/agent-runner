import { describe, expect, it } from "vitest";
import { timerDropins } from "../src/systemd.js";
import { testConfig } from "./support/fakes.js";

describe("timer drop-ins written from config", () => {
  it("sets the round interval and the weekday auto-off calendar from config", () => {
    expect(timerDropins({ ...testConfig, roundIntervalMinutes: 45 })).toEqual({
      "agent-runner.timer.d/config.conf": expect.stringMatching(/\[Timer\]\nOnUnitActiveSec=45min\n$/),
      "agent-runner-autooff.timer.d/config.conf": expect.stringMatching(/\[Timer\]\nOnCalendar=\nOnCalendar=Mon,Tue,Wed,Thu,Fri \*-\*-\* 08:00:00 Asia\/Taipei\n$/),
    });
  });

  it("pads the auto-off time and names any weekday, Sunday included", () => {
    const { "agent-runner-autooff.timer.d/config.conf": autoOff } = timerDropins({
      ...testConfig,
      autoOff: { weekdays: [0, 6], hour: 7, minute: 5, timeZone: "UTC" },
    });
    expect(autoOff).toContain("OnCalendar=Sun,Sat *-*-* 07:05:00 UTC\n");
  });
});
