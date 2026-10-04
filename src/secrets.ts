import { readFileSync } from "node:fs";

/** secret 檔（`~/.config/agent-runner/env`）：KEY=VALUE，忽略空行與 # 註解，可帶 `export ` 與引號 */
export function readSecrets(path: string): Record<string, string> {
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

/** Slack webhook：環境變數優先（手動測試時好換），沒有就讀 secret 檔 */
export function slackWebhookUrl(secrets: Record<string, string>): string | undefined {
  return process.env.AGENT_RUNNER_SLACK_WEBHOOK_URL || secrets.AGENT_RUNNER_SLACK_WEBHOOK_URL || undefined;
}
