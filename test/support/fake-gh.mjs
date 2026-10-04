#!/usr/bin/env node
// 假的 gh：照 FAKE_GH_RESPONSES 裡的設定回應，並把每次的 argv（和 --body-file 的內容）記到 FAKE_GH_LOG。
// responses 格式：[{ "match": ["issue", "list"], "stdout": "...", "stderr": "...", "code": 0 }]，取第一個 argv 前綴吻合的。
import { appendFileSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const bodyFileAt = argv.findIndex((a) => a === "--body-file" || a === "-F");
const bodyFile = bodyFileAt >= 0 ? readFileSync(argv[bodyFileAt + 1], "utf8") : undefined;
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ argv, bodyFile }) + "\n");

const responses = JSON.parse(readFileSync(process.env.FAKE_GH_RESPONSES, "utf8"));
const hit = responses.find((r) => r.match.every((m, i) => argv[i] === m));
if (!hit) {
  process.stderr.write(`fake gh: no response for ${argv.join(" ")}\n`);
  process.exit(2);
}
process.stdout.write(hit.stdout ?? "");
process.stderr.write(hit.stderr ?? "");
process.exit(hit.code ?? 0);
