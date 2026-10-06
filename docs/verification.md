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

## 3. merge run 在 sandbox 裡合得到 `agent/<A>` 嗎→ **待實測**（只讀過 sandcastle 原始碼）

解合併衝突的 merge run（`prompts/merge.md`）用 `branchStrategy: { type: "branch", branch: "agent/<S>" }`，
要 agent 在 sandbox 裡 `git merge agent/<A>`。`agent/<A>` 只是 bot clone 的本地 branch，沒有另外傳進去。
以下是讀 `node_modules/@ai-hero/sandcastle/dist/chunk-VOG34SRF.js`（`0.12.0`）的判斷，還沒在真的 docker 上跑過：

- **refs 共用**（:25266-25309）：worktree 是 bot clone 的 linked worktree（`git worktree add <.sandcastle/worktrees/agent-<S>> agent/<S>`），
  跟主 checkout 共用同一份 refs，所以 `agent/<A>` 在 worktree 裡看得到。`agent/<S>` 已經存在時直接 `worktree add` 那條 branch；
  同一條 branch 已有 sandcastle 管的 worktree 就沿用它（乾淨的話先從 origin fast-forward，dirty 的話照原樣沿用），runner 在 merge run 前會先刪掉殘留的。
- **`.git` 掛進 container**（:26454-26458 起的 `resolveGitMounts`）：worktree 的 `.git` 檔和它指向的主 `.git` 目錄都以 host 上的原路徑掛進去，
  container 裡的 git 讀得到主 repo 的 objects 和 refs。
- **`~` 展開**（:26813-26820 的 `resolveSandboxPath`）：mount 的 `sandboxPath` 開頭的 `~` 用 provider 的 `sandboxHomedir` 展開，
  `~/.claude/skills/resolving-merge-conflicts` 會掛在 agent user 的家目錄底下，跟 `/tdd` 一樣。

上線後第一次遇到合併衝突時要確認（看那一輪的 sandcastle log 和 issue 留言）：

1. sandbox 裡 `git merge agent/<A> --no-edit` 找得到 ref（不是 `merge: agent/<A> - not something we can merge`）。
2. agent 用 Skill tool 叫得到 `resolving-merge-conflicts`（log 有 `Launching skill: resolving-merge-conflicts`）。
3. named branch 沿用既有的本地 `agent/<S>`：merge run 一開始的 HEAD 是 `origin/agent/<S>`，不是從 base 新開的 branch；
   全過時 host push 上去的 `agent/<S>` 有一顆兩個 parent 的合併 commit。

## 沒驗到的

- 真的 issue、真的 draft PR 的整條流程→ 在真機上用真的 issue 人工驗收，不在這份紀錄裡。
- 目標 repo 的 `pnpm install --frozen-lockfile` + `playwright install chromium` 在 sandbox 裡實際花多久、
  會不會超過 hook 的上限：這次對象是拋棄式 repo，沒有跑。
