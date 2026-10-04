import type { Notifier } from "./ports.js";

/** 先印到 stdout（journald 會收）；Slack incoming webhook 在 #2701 換上。 */
export const consoleNotifier: Notifier = {
  async notify(text) {
    console.log(`[notify] ${text}`);
  },
};
