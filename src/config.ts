import { homedir } from "node:os";
import { join } from "node:path";

/**
 * runner 的全部設定都在這一個檔。第一階段的值見 spec #2692「第一階段設定值」。
 * 要放寬挑單、換目標 repo、換身分 → 改這裡，不改程式。
 * secret 不在這裡：`CLAUDE_CODE_OAUTH_TOKEN` 等放 `secretsFile`（chmod 600）。
 */
export interface Config {
  /** 目標 repo slug，所有 gh 指令都帶 `-R` */
  repo: string;
  /** 操作者的 GitHub login：開單的人、PR／issue 的 assignee */
  operator: string;
  /** `gh issue list --search` 的額外條件（`--author @me --label ready-for-agent --state open` 固定帶） */
  pickSearch: string;
  /** PR 的 base，也是 agent/<N> 的起點（`origin/<baseBranch>`） */
  baseBranch: string;
  /** bot clone 的絕對路徑（sandcastle 的 cwd） */
  botClonePath: string;
  /** `.nvmrc` 在目標 repo 裡的路徑 */
  nvmrcPath: string;
  /** `/tdd` skill 在 host 上的路徑（realpath），唯讀掛進 sandbox */
  tddSkillPath: string;
  /** runner 的 git author name（bot clone 的 repo 層 user.name） */
  gitAuthor: string;
  /** 每張單的上限（實作＋檢查＋review 全部算在內） */
  timeoutMinutes: number;
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
  baseBranch: "dev",
  botClonePath: join(home, "agents/teamsync-frontend"),
  nvmrcPath: "frontend/.nvmrc",
  tddSkillPath: join(home, ".config/skillshare/skills/tdd"),
  gitAuthor: "henry (agent)",
  timeoutMinutes: 60,
  model: "claude-opus-4-8",
  imageName: "sandcastle-teamsync",
  pnpmStorePath: join(home, "agents/pnpm-store"),
  repoEnvPath: join(home, "agents/env/teamsync-frontend.env"),
  secretsFile: join(home, ".config/agent-runner/env"),
};
