import type { Notifier } from "./ports.js";

/** 印到 stdout（journald 會收）。沒設 webhook 時的退路。 */
export const consoleNotifier: Notifier = {
  async notify(text) {
    console.log(`[notify] ${text}`);
  },
};

/**
 * Slack incoming webhook（`AGENT_RUNNER_SLACK_WEBHOOK_URL`），每張單一則。
 * 也照樣印到 stdout，Slack 收不到時 journald 裡還有。Slack 拒收就 throw；要不要吞掉由呼叫端決定。
 */
export function createSlackNotifier(webhookUrl: string): Notifier {
  return {
    async notify(text) {
      await consoleNotifier.notify(text);
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Slack webhook 回 ${res.status}：${(await res.text()).slice(0, 200)}`);
    },
  };
}
