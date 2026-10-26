import { readFile } from "node:fs/promises";

/** sandcastle 0.12.0 的 toolCall 不送 Skill；只信捕捉 session 中 assistant 真正發出的 tool_use。 */
export async function verificationSkillInvoked(sessionFilePath: string | undefined): Promise<boolean> {
  if (!sessionFilePath) return false;
  let session: string;
  try {
    session = await readFile(sessionFilePath, "utf8");
  } catch {
    return false;
  }
  for (const line of session.split("\n")) {
    try {
      const event = JSON.parse(line);
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
