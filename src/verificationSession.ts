import { readFile } from "node:fs/promises";
import type { AgentKind } from "./config.js";

const skillReadCommand = "cat /home/agent/.agents/skills/verify-in-browser/SKILL.md";
// 僅接受單一工具呼叫的 code-mode 包裝；不執行 session 裡的 JavaScript。
const codeModeRead = /^\s*text\(\s*await\s+tools\.exec_command\(\s*\{\s*cmd\s*:\s*(["'])cat \/home\/agent\/\.agents\/skills\/verify-in-browser\/SKILL\.md\1\s*(?:,\s*max_output_tokens\s*:\s*\d+\s*)?\}\s*\)\s*\)\s*;?\s*$/;

function successfulSkillRead(output: unknown): boolean {
  if (typeof output === "string") {
    return /^Process exited with code 0\s*$/m.test(output) && /^name: verify-in-browser\s*$/m.test(output);
  }
  // Codex code mode 的 custom_tool_call_output 是文字 content blocks。
  if (!Array.isArray(output)) return false;
  return output.some((block) => {
    if (block?.type !== "input_text" || typeof block.text !== "string") return false;
    try {
      const result = JSON.parse(block.text);
      return result.exit_code === 0 && typeof result.output === "string" && /^name: verify-in-browser\s*$/m.test(result.output);
    } catch {
      return false;
    }
  });
}

/** 只採信捕捉 session 的工具紀錄：Claude Skill 呼叫，或 Codex 成功讀取 allowlist skill。 */
export async function verificationSkillInvoked(sessionFilePath: string | undefined, agent: AgentKind = "claude"): Promise<boolean> {
  if (!sessionFilePath) return false;
  let session: string;
  try {
    session = await readFile(sessionFilePath, "utf8");
  } catch {
    return false;
  }
  const skillReads = new Set<string>();
  for (const line of session.split("\n")) {
    try {
      const event = JSON.parse(line);
      if (agent === "codex") {
        if (event?.type !== "response_item") continue;
        const item = event.payload;
        if (item?.type === "function_call" && item.name === "exec_command" && typeof item.call_id === "string") {
          const args = JSON.parse(item.arguments);
          // 獨立讀完整 allowlist 檔案；echo、註解、搜尋或把路徑當資料都不算。
          if (args.cmd?.trim() === skillReadCommand) skillReads.add(item.call_id);
        }
        if (item?.type === "custom_tool_call" && item.name === "exec" && typeof item.call_id === "string"
          && typeof item.input === "string" && codeModeRead.test(item.input)) skillReads.add(item.call_id);
        if (["function_call_output", "custom_tool_call_output"].includes(item?.type)
          && skillReads.has(item.call_id) && successfulSkillRead(item.output)) {
          return true;
        }
        continue;
      }
      if (event?.type !== "assistant" || !Array.isArray(event.message?.content)) continue;
      if (event.message.content.some((block: { type?: unknown; name?: unknown; input?: { skill?: unknown } } | null) =>
        block?.type === "tool_use" && block.name === "Skill" && block.input?.skill === "verify-in-browser",
      )) return true;
    } catch {
      // session 可能只捕捉到最後一行的一部分；不把文字片段當成呼叫。
    }
  }
  return false;
}
