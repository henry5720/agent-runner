import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verificationSkillInvoked } from "../src/verificationSession.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const read = (cmd = "cat /home/agent/.agents/skills/verify-in-browser/SKILL.md") => ({ type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "read-skill", arguments: JSON.stringify({ cmd }) } });
const output = (text = "Process exited with code 0\nFinal output:\n---\nname: verify-in-browser\n---\n驗收規則") => ({ type: "response_item", payload: { type: "function_call_output", call_id: "read-skill", output: text } });

async function check(events: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), "runner-codex-session-"));
  roots.push(root);
  const file = join(root, "session.jsonl");
  writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n") + '\n{"partial":');
  return verificationSkillInvoked(file, "codex");
}

describe("Codex 驗收 skill 使用紀錄", () => {
  it("接受真正讀取 allowlist skill 且成功回傳內容的同一個 tool call", async () => {
    expect(await check([read(), output()])).toBe(true);
  });
  it("接受 code mode 的單一讀取呼叫與真正成功輸出", async () => {
    const call = { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "read-skill", input: 'text(await tools.exec_command({cmd:"cat /home/agent/.agents/skills/verify-in-browser/SKILL.md",max_output_tokens:16000}));' } };
    const result = { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "read-skill", output: [{ type: "input_text", text: JSON.stringify({ exit_code: 0, output: "---\nname: verify-in-browser\n---\n規則" }) }] } };
    expect(await check([call, result])).toBe(true);
    expect(await check([{ ...call, payload: { ...call.payload, input: call.payload.input + 'text("fake");' } }, result])).toBe(false);
    expect(await check([call, { ...result, payload: { ...result.payload, output: [{ type: "input_text", text: JSON.stringify({ exit_code: 1, output: "name: verify-in-browser" }) }] } }])).toBe(false);
  });

  it.each([
    [read()],
    [output()],
    [{ type: "response_item", payload: { type: "message", content: "已呼叫 verify-in-browser" } }],
    [read("echo /home/agent/.agents/skills/verify-in-browser/SKILL.md"), output()],
    [read("cat /tmp/verify-in-browser/SKILL.md"), output()],
    [read(), output("Process exited with code 1\nname: verify-in-browser")],
    [read(), output("Process exited with code 0\nno such file")],
    [read(), { ...output(), payload: { ...output().payload, call_id: "different-call" } }],
    [output(), read()],
  ])("不採信未讀取成功、僅提及或不相符的紀錄 %#", async (...events) => {
    expect(await check(events)).toBe(false);
  });
});
