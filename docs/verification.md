# sandcastle 行為實測

> 寫 runner 之前有兩件 sandcastle 的行為沒有把握，先拿拋棄式 repo 實測，結果記在這裡。
> 第 3 段是之後加 merge run 時補測的，環境寫在該段開頭。

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

## 3. merge run 在 sandbox 裡合得到 `agent/<A>` 嗎→ **合得到，但 runner 現在的 `merge()` 一跑就失敗**

- 日期：2026-10-06，同一台 company-ec2、同一個 image `sandcastle-teamsync:82de6ac7627b`（sandbox 內 Claude Code `2.1.289`），
  runner 在 `fd59348`（main），model `claude-haiku-4-5`。
- 對象：拋棄式 bare repo 當 origin、一份 clone 當 bot clone（repo 層 `user.name` = `henry (agent)`），都不在 GitHub 上。
  `agent/40`（整合分支，已有另一張 sub-issue 把 `value.txt` 的 `color:` 改成 red）和 `agent/42`（sub-issue，同一行改成 blue），
  `git merge` 一定衝突。repo 裡有 `package.json`（`test` 檢查 `value.txt` 沒有衝突標記、`typecheck` 直接 exit 0）、
  `CLAUDE.md`（寫驗證範圍），和讓 `onSandboxReady` 的 `pnpm install --frozen-lockfile && pnpm exec playwright install chromium`
  跑得過的 `frontend/`（釘 `pnpm@9.15.9`、`playwright` 是 `file:` 進來的假套件）。
- 呼叫方式：一次性 tsx script import runner 真的 `createSandbox`、`createGit`，`config` 只換 `botClonePath`、`pnpmStorePath`、
  `repoEnvPath`、`model`；照 `resolveConflict` 的順序 `fetch` → 刪殘留 worktree → `resetBranch("agent/40", "origin/agent/40")` →
  `sandbox.merge({ branch: "agent/40", baseRef: "origin/agent/40", source: "agent/42", ... })` → `pushMerge("agent/40", "agent/42")`。
  用 Node 的 module resolve hook 把 `run()` 包一層，只多加 `logging: { type: "file", verbose: true }`（拿 raw stream）。

### 3.0 runner 的 `merge()` 直接被 sandcastle 擋下→ **不行**（bug，已在同一個 PR 修掉）

`src/sandbox.ts:129` 傳 `args: { SOURCE_BRANCH, TARGET_BRANCH }`，這兩個是 sandcastle 的內建 prompt 參數
（`node_modules/@ai-hero/sandcastle/dist/index.js:661-663` 的 `BUILT_IN_PROMPT_ARG_KEYS`），不能從 `promptArgs` 蓋掉：

```
PromptError: "SOURCE_BRANCH" is a built-in prompt argument and cannot be overridden via promptArgs
```

在開 container、開 worktree 之前就丟出來，所以每次合併衝突都會走 `resolveConflict` 的 catch，照 crash 收尾，agent 從來沒機會解。
就算沒被擋，內建值也不對：`SOURCE_BRANCH` 是 sandbox 那條 branch（`agent/<S>`）、`TARGET_BRANCH` 是 host 主 checkout
目前的 branch（`index.js:1132-1133`），prompt 會叫 agent 把自己合進自己。
**修法**（已修）：`prompts/merge.md` 和 `merge()` 的參數改名成 `MERGE_SOURCE`／`MERGE_TARGET`。下面 3.1 起的實測就是用這兩個名字跑的。

下面 3.1–3.4 為了驗其餘行為，在 hook 裡只把這兩個 placeholder 改名（prompt 其餘一字不改）再跑。

### 3.1 sandbox 裡 `git merge agent/<A> --no-edit` 找得到 ref、真的衝突→ **可以**

raw stream 裡 agent 跑 `git merge agent/42 --no-edit` 的結果：

```
Exit code 1
Auto-merging value.txt
CONFLICT (content): Merge conflict in value.txt
Automatic merge failed; fix conflicts and then commit the result.
```

沒有 `not something we can merge`。worktree 掛在 container 的 `/home/agent/workspace`，`.git` 照 host 路徑掛進去，
本地的 `agent/42` 看得到（agent 也跑了 `git show agent/42:value.txt`）。

### 3.2 agent 用 Skill tool 叫得到 `resolving-merge-conflicts`→ **可以**

- init 事件的 `skills` 清單有 `resolving-merge-conflicts`（從 host 唯讀掛到 `~/.claude/skills/`）。
- 衝突之後模型自己發出 `tool_use {"name":"Skill","input":{"skill":"resolving-merge-conflicts"}}`，接著是
  `Launching skill: resolving-merge-conflicts`。

### 3.3 named branch 沿用既有的本地 `agent/<S>`，合出兩個 parent 的合併 commit 並 push→ **可以**

- 開跑前把本地 `agent/40` 故意停在舊的 `3a86913`；`resetBranch` 後是 `ed2efdc`，等於 `origin/agent/40`。
- sandbox 裡第一個 `git log --oneline -5` 的第一行是 `ed2efdc feat: #41 改成 red…`→ sandcastle 沿用本地 `agent/40`，沒有從 base 重開。
- 結果 `0e29295 Merge branch 'agent/42' into agent/40`，parents 是 `ed2efdc`（第一個，就是開跑前的 `agent/40`）和 `ce9452a`（`agent/42`）。
  author 是 bot clone 的 `henry (agent)`。agent 回報 `outcome: "pass"`，重跑了 `npm test`（`1 passed`）、`npm run typecheck`。
- `pushMerge` 回 `{"kind":"merged","sha":"0e29295…"}`，bare origin 的 `agent/40` 變成 `0e29295`。
- run 結束 sandcastle 把乾淨的 worktree 收掉，bot clone 只剩主 checkout。整輪 49 秒，`total_cost_usd` 0.07。

### 3.4 merge run 期間有人往遠端 `agent/<S>` push→ **`pushMerge` 回 rejected，不蓋掉**

沒跑 sandbox：把 bare 的 `agent/40` 和 clone 的 `origin/agent/40` 都退回 `ed2efdc`（merge run 開始時的樣子），本地 `agent/40` 留在 `0e29295`，
再從另一份 clone 往 bare 的 `agent/40` push 一顆 `1df4ebd`。`pushMerge("agent/40", "agent/42")` 回 `{"kind":"rejected"}`，
bare 的 `agent/40` 還是 `1df4ebd`。

### 其他看到的

- 衝突是同一行 red／blue 二選一，prompt 第 7 步說這種「要猜才能選」的要 `git merge --abort` 回報 `wip`；haiku 直接選了 `agent/42` 的 blue、
  回報 `pass`，丟掉 #41 的改動。這是這次用的便宜 model 的判斷，實際跑 `claude-opus-4-8` 時要再看；runner 端沒有檢查擋得到這種結果
  （`pushMerge` 只看兩邊的 commit 都在）。
- bot clone 不能放在 `/tmp/claude-<uid>/` 底下：docker 為了掛 `.git` 會在 container 裡以 root 建出 `/tmp/claude-1000`，
  Claude Code 拒絕用它當暫存目錄（`Temp directory /tmp/claude-1000 is owned by uid 0, expected 1000`）。實際的 `~/agents/teamsync-frontend` 不受影響。

## 沒驗到的

- 真的 issue、真的 draft PR 的整條流程→ 在真機上用真的 issue 人工驗收，不在這份紀錄裡。
- 目標 repo 的 `pnpm install --frozen-lockfile` + `playwright install chromium` 在 sandbox 裡實際花多久、
  會不會超過 hook 的上限：這次對象是拋棄式 repo，沒有跑。
