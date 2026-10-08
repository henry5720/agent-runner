import { homedir } from "node:os";
import { join } from "node:path";
import type { AutoOffSchedule } from "./autoOff.js";

export type SandboxPhase = "implement" | "review" | "merge";

export interface SandboxSkill {
  name: string;
  hostPath: string;
  phases: SandboxPhase[];
  dependencies: string[];
}

/**
 * runner 的全部設定都在這一個檔。目前的值是第一階段：只挑操作者自己開的單，先把流程跑順。
 * 要放寬挑單、換目標 repo、換身分 → 改這裡，不改程式。
 * secret 不在這裡：`CLAUDE_CODE_OAUTH_TOKEN` 等放 `secretsFile`（chmod 600）。
 */
export interface Config {
  /** 目標 repo slug，所有 gh 指令都帶 `-R` */
  repo: string;
  /** 操作者的 GitHub login：開單的人、PR／issue 的 assignee */
  operator: string;
  /** `gh issue list --search` 的額外條件（`--author @me --label agent-runner --state open` 固定帶） */
  pickSearch: string;
  /** 一輪最多接幾張（一次一張，做完才接下一張） */
  maxPerRound: number;
  /** 打開之後每幾分鐘一輪（systemd `agent-runner.timer` 的 OnUnitActiveSec，見 src/systemd.ts） */
  roundIntervalMinutes: number;
  /** PR 的 base，也是 agent/<N> 的起點（`origin/<baseBranch>`） */
  baseBranch: string;
  /** bot clone 的絕對路徑（sandcastle 的 cwd） */
  botClonePath: string;
  /** `.nvmrc` 在目標 repo 裡的路徑 */
  nvmrcPath: string;
  globalClaudePath: string;
  sandboxSkills: SandboxSkill[];
  /** runner 的 git author name（bot clone 的 repo 層 user.name） */
  gitAuthor: string;
  /** 每張單的上限（實作＋檢查＋review 全部算在內） */
  timeoutMinutes: number;
  /** 自動關（也是 systemd `agent-runner-autooff.timer` 的 OnCalendar，見 src/systemd.ts）；距離它不到一個 timeout 就不接新單 */
  autoOff: AutoOffSchedule;
  /** runner 狀態目錄：輪次鎖、目前在跑哪張（`agent-runner status` 讀） */
  stateDir: string;
  /** sandbox 裡 claude 用的 model */
  model: string;
  /** image 名稱；tag 由 hash(Dockerfile + .nvmrc) 算 */
  imageName: string;
  /** runner 自己的 pnpm store（可寫掛進 sandbox） */
  pnpmStorePath: string;
  /** repo env 檔；存在才唯讀掛成 frontend/.env.local */
  repoEnvPath: string;
  /** secret 檔（KEY=VALUE） */
  secretsFile: string;
}

const home = homedir();

export const config: Config = {
  repo: "ShuChenAI/teamsync-frontend",
  operator: "henry5720",
  pickSearch: "-is:blocked no:assignee",
  maxPerRound: 2,
  roundIntervalMinutes: 60,
  baseBranch: "dev",
  botClonePath: join(home, "agents/teamsync-frontend"),
  nvmrcPath: "frontend/.nvmrc",
  globalClaudePath: join(home, ".claude/CLAUDE.md"),
  sandboxSkills: [
    { name: "tdd", hostPath: join(home, ".config/skillshare/skills/tdd"), phases: ["implement"], dependencies: ["codebase-design"] },
    { name: "codebase-design", hostPath: join(home, ".config/skillshare/skills/codebase-design"), phases: ["implement"], dependencies: [] },
    { name: "writing-for-agents", hostPath: join(home, ".config/skillshare/skills/writing-for-agents"), phases: ["implement", "review", "merge"], dependencies: [] },
    { name: "show-me", hostPath: join(home, ".config/skillshare/skills/show-me"), phases: ["implement", "review", "merge"], dependencies: [] },
    { name: "resolving-merge-conflicts", hostPath: join(home, ".config/skillshare/skills/resolving-merge-conflicts"), phases: ["merge"], dependencies: [] },
  ],
  gitAuthor: "henry (agent)",
  timeoutMinutes: 60,
  autoOff: { weekdays: [1, 2, 3, 4, 5], hour: 8, minute: 0, timeZone: "Asia/Taipei" },
  stateDir: join(home, ".local/state/agent-runner"),
  model: "claude-opus-4-8",
  imageName: "sandcastle-teamsync",
  pnpmStorePath: join(home, "agents/pnpm-store"),
  repoEnvPath: join(home, "agents/env/teamsync-frontend.env"),
  secretsFile: join(home, ".config/agent-runner/env"),
};
