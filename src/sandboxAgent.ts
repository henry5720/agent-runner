import { claudeCode, codex } from "@ai-hero/sandcastle";
import type { AgentKind, Config } from "./config.js";

/** 規則、skills 掛載與 prompt 使用同一組 sandbox 路徑。 */
export function agentLayout(agent: AgentKind) {
  const rulesPath = agent === "codex" ? "/home/agent/.codex/AGENTS.md" : "/home/agent/.claude/CLAUDE.md";
  const skillsDir = agent === "codex" ? "/home/agent/.agents/skills" : "/home/agent/.claude/skills";
  return {
    rulesPath,
    skillsDir,
    promptArgs: {
      GLOBAL_RULES_PATH: rulesPath,
      SKILLS_DIR: skillsDir,
      SKILL_USAGE: agent === "codex"
        ? `先以 exec_command 執行 cat ${skillsDir}/<skill 名稱>/SKILL.md，讀取成功後依內容操作；驗收 skill 必須以獨立指令 cat ${skillsDir}/verify-in-browser/SKILL.md 完整讀取，session 會核對此呼叫與成功輸出。若使用 code mode，單獨執行 text(await tools.exec_command({cmd:"cat ${skillsDir}/verify-in-browser/SKILL.md",max_output_tokens:16000}));，保持這個單一呼叫格式`
        : "用 Skill tool 呼叫該 skill",
    },
  };
}

/** 只注入選定 provider 的 secret，不繼承 host Codex 設定或登入狀態。 */
export function sandboxAgent(config: Config, secrets: Record<string, string>) {
  const key = config.agent === "codex" ? "CODEX_GATEWAY_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN";
  const value = secrets[key];
  if (!value) throw new Error(`${key} missing in ${config.secretsFile}`);
  const env = { [key]: value };
  return config.agent === "codex"
    ? codex(config.model, { effort: config.codexEffort, env })
    : claudeCode(config.model, { env });
}
