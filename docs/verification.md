# sandcastle 行為實測

> 寫 runner 之前有兩件 sandcastle 的行為沒有把握，先拿拋棄式 repo 實測，結果記在這裡。

- 日期：2026-10-04，company-ec2（docker 29.8.1、node v22.16.0）
- sandcastle `0.12.0`；sandbox 內 Claude Code `2.1.289`；model `claude-haiku-4-5`（只為了快、便宜）
- image：用本 repo 的 `Dockerfile` build（`NODE_VERSION=22.16.0`、`AGENT_UID/GID=1000`），成功，約 2.9 GB。
  runner 算出的 tag 是 `sandcastle-teamsync:82de6ac7627b`。image 內確認：node v22.16.0、Python 3.11.2、
  `ortools` 9.15.6755、`pnpm`（corepack）、`claude` 在 PATH、`TZ=Asia/Taipei`、`CI=1`、
  `~/.claude/skills` 與 `~/.local/share/pnpm/store` 由 agent user 擁有。
- 對象：在 job 暫存目錄自建的拋棄式 git repo（一個 commit ＋ 一個 project skill `marker`，
  skill 內容是「執行 `echo PINEAPPLE-7731 > skill-ran.txt`」）。沒有碰 GitHub。
- 呼叫方式與 runner 相同：`run({ agent: claudeCode(model, { env: { CLAUDE_CODE_OAUTH_TOKEN } }), sandbox: docker({ imageName }),
  branchStrategy: { type: "branch", ... }, promptFile, maxIterations: 1, output: Output.object(...) })`，
  token 從 `~/.config/agent-runner/env` 讀，沒有 `.sandcastle/.env`。

## 1. provider `env` 能不能直接傳 token→ **可以**

- `onSandboxReady` hook 跑 `[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && [ -z "$GH_TOKEN$GITHUB_TOKEN" ]`，通過
  （hook 非 0 會讓整個 run 失敗）→ container 裡有 token、沒有 GitHub token。
- agent 正常登入並跑完（image 裡沒有其他憑證，能跑就代表 token 是從 provider `env` 進來的）。
- 附帶發現：agent 用 Bash tool 檢查時看到 `CLAUDE_CODE_OAUTH_TOKEN` 是**空的**——Claude Code 不把這個
  token 傳給它自己開的子程序。也就是 agent 跑的指令（測試、腳本）讀不到 token，這是好事。
- 仍成立的風險：token 是 `docker run -e` 參數，host 上 `docker inspect` 看得到（sandcastle 文件已提）。

## 2. prompt 中間寫 `/skill` 會不會展開→ **不會被 CLI 展開；靠模型自己叫 Skill tool**

- prompt 第 2 步寫「Now /marker」（在 prompt 中間，不是開頭）。
- raw stream（`logging.verbose: true`）裡，skill 內容第一次出現是在模型自己發出
  `tool_use {"name":"Skill","input":{"skill":"marker"}}` 之後（接著才是 `Launching skill: marker`）。
  在那之前的 user message 裡 `/marker` 是原字面，沒有被替換成 skill 內容。
- 結論：Claude Code print mode 不會展開 prompt 中間的 `/xxx`。這次模型有自己把它理解成「叫 Skill tool」，
  但那是模型的判斷，不保證。
- **做法**：prompt 裡不要寫 `/code-review`、`/tdd`，明寫「用 Skill tool 執行 `code-review` skill」。
  `prompts/implement.md` 已經這樣寫；`prompts/review.md` 也照做。
- 附帶確認：worktree 裡 `.claude/skills/` 的 project skill 在 sandbox 內會出現在 `skills` 清單，可以被叫到。

## 沒驗到的

- 真的 issue、真的 draft PR 的整條流程→ 在真機上用真的 issue 人工驗收，不在這份紀錄裡。
- 目標 repo 的 `pnpm install --frozen-lockfile` + `playwright install chromium` 在 sandbox 裡實際花多久、
  會不會超過 hook 的上限：這次對象是拋棄式 repo，沒有跑。
