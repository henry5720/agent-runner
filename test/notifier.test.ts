import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createSlackNotifier } from "../src/notifier.js";

/** 本機假的 Slack incoming webhook：記下收到的 body，回指定的 status */
async function fakeWebhook(status = 200) {
  const received: unknown[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ method: req.method, contentType: req.headers["content-type"], body: JSON.parse(body) });
      res.writeHead(status).end(status === 200 ? "ok" : "invalid_payload");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/services/T/B/x`, received };
}

const servers: Server[] = [];
afterEach(() => Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r)))));

describe("Slack notifier", () => {
  it("posts the text as a JSON payload to the webhook", async () => {
    const hook = await fakeWebhook();

    await createSlackNotifier(hook.url).notify("✅ <https://x/issues/1|#1 t>");

    expect(hook.received).toEqual([{ method: "POST", contentType: "application/json", body: { text: "✅ <https://x/issues/1|#1 t>" } }]);
  });

  it("fails when Slack rejects the message", async () => {
    const hook = await fakeWebhook(400);

    await expect(createSlackNotifier(hook.url).notify("hi")).rejects.toThrow(/400.*invalid_payload/);
  });
});
