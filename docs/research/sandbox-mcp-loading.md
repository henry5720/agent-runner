# sandbox 裡的 claude 會不會載入 repo 的 `.mcp.json`

研究票：[#13](https://github.com/henry5720/agent-runner/issues/13)（map [#12](https://github.com/henry5720/agent-runner/issues/12)）。
調查日期 2026-10-06；sandcastle 0.12.0、Claude Code 2.1.291、playwright 1.59.1、@playwright/mcp 0.0.83。

## 結論

**會載入，不用改 agent-runner。** `claude -p` 不跳核准提示，直接載入 project scope 的 MCP server，
不需要 `enableAllProjectMcpServers`、`enabledMcpjsonServers` 或 `--mcp-config`。
`playwright-test` MCP 在 container 裡自動走 headless（Dockerfile 有 `CI=1`、沒有 `DISPLAY`）。
`@playwright/mcp` 也會自動 headless，但預設開 Google Chrome，container 裡沒有，要加 `--browser chromium`。

| 問題 | 答案 | 依據 |
|---|---|---|
| sandcastle 怎麼呼叫 claude | `claude --print --verbose --dangerously-skip-permissions --output-format stream-json --model <m> -p -`，prompt 走 stdin，沒有任何 MCP 相關旗標 | sandcastle `dist/index.js:3426-3431` |
| cwd 是不是 worktree 根目錄 | 是。`sandbox.exec(..., { cwd: sandboxRepoDir })`，`sandboxRepoDir` = worktree 在 container 裡的路徑（docker 預設 `/home/agent/workspace`） | `dist/index.js:252-288`、`dist/chunk-CP3TYXZA.js:134-136` |
| worktree 裡有沒有 `.mcp.json` | 有。teamsync-frontend 的 `.mcp.json` 有進 git（`git ls-tree origin/main -- .mcp.json` 有輸出），worktree checkout 出來就在根目錄 | 本機指令 |
| `-p` 會不會載入 `.mcp.json` | 會，不問 | Claude Code MCP 文件（下面引文） |
| 要不要 `enableAllProjectMcpServers` | 不用；那是給互動模式的核准提示用的 | 同上 |
| `playwright-test` MCP 能不能 headless | 能，自動判斷 | playwright `lib/mcp/test/testContext.js:82-85` |
| `@playwright/mcp` 能不能 headless | 能，自動判斷；但預設 channel 是 `chrome`，要改 `--browser chromium` | playwright-core `lib/coreBundle.js:74232-74233`、`74297-74303`、`74350-74351` |

## 1. sandcastle 傳給 claude 的參數

`claudeCode()` 的 `buildPrintCommand`（`node_modules/@ai-hero/sandcastle/dist/index.js:3426-3431`）：

```js
command: `claude --print --verbose${permissionFlag} --output-format stream-json --model ${shellEscape(model)}${effortFlag}${resumeFlag}${forkFlag} -p -`,
stdin: prompt
```

`invokeAgent` 固定傳 `dangerouslySkipPermissions: true`（`index.js:252-257`），所以 `permissionFlag` 是
` --dangerously-skip-permissions`。整條指令沒有 `--mcp-config`、`--strict-mcp-config`、`--setting-sources`、`--bare`，
`claudeCode()` 的 options 也沒有塞額外 CLI 參數的欄位（只有 `env`、`effort`、`permissionMode` 等）。

執行時 `cwd: sandboxRepoDir`（`index.js:286`），就是 worktree 根目錄，Claude Code 會在這裡找 `.mcp.json`。

## 2. Claude Code 官方文件

[MCP 文件](https://code.claude.com/docs/en/mcp)，project scope 的核准一段：

> For security reasons, Claude Code prompts for approval in interactive sessions before using project-scoped servers from `.mcp.json` files.

> In `claude -p` runs, Agent SDK sessions, and cloud sessions, Claude Code can't show that prompt: it loads project-scoped servers without asking.

要擋掉的方法文件列了三個，sandcastle 一個都沒用：`disabledMcpjsonServers`、`--setting-sources`、`--strict-mcp-config`。

`enableAllProjectMcpServers`／`enabledMcpjsonServers` 是用來在互動模式**事先核准**的；文件說 repo 自己的
`.claude/settings.json` 寫這兩個在未信任的資料夾會被忽略（v2.1.196 起）。這跟 `-p` 無關，`-p` 根本不走核准。

[CLI reference](https://code.claude.com/docs/en/cli-reference) 對 `--dangerously-skip-permissions` 的描述只有
「Skip permission prompts. Equivalent to `--permission-mode bypassPermissions`」，跟 MCP 載入無關。

## 3. 本機實驗

空資料夾（從沒信任過，`~/.claude.json` 裡沒有它的 `hasTrustDialogAccepted`）放一份 `.mcp.json`，
用跟 sandcastle 一樣的參數跑：

```bash
cd /tmp/claude-1000/mcp-exp   # .mcp.json: {"mcpServers":{"pw":{"command":"npx","args":["-y","@playwright/mcp@latest","--headless"]}}}
echo 'reply ok' | claude --print --verbose --dangerously-skip-permissions --output-format stream-json --model haiku -p -
```

stream-json 的 `system/init` 事件：

```
{'name': 'pw', 'status': 'connected', 'source': 'project'}
```

project scope 的 server 在第一個 turn 前就是 `connected`。

## 4. Playwright MCP 在無頭 container

### `playwright-test`（`npx playwright run-test-mcp-server`）

teamsync-frontend `.mcp.json` 用的是這個。`--headless` 旗標的說明寫「headed by default」，但實際預設看環境
（playwright 1.59.1 `lib/mcp/test/testContext.js:82-85`）：

```js
if (options?.headless !== void 0)
  this.computedHeaded = !options.headless;
else
  this.computedHeaded = !process.env.CI && !(import_os.default.platform() === "linux" && !process.env.DISPLAY);
```

sandbox image 的 `Dockerfile` 有 `ENV CI=1`、沒有設 `DISPLAY`，兩個條件都成立 → headless。
瀏覽器用 frontend 自己的 playwright 1.59，setup hook（`src/sandbox.ts:32`）已經 `pnpm exec playwright install chromium`，
系統依賴由 Dockerfile 的 `npx -y playwright install-deps chromium` 裝好。

### `@playwright/mcp`

目前 `.mcp.json` 沒有設定它。若要加：

- headless 自動判斷（playwright-core `lib/coreBundle.js:74232-74233`）：
  `browser.launchOptions.headless = platform() === "linux" && !process.env.DISPLAY;`
- 預設 channel 是 `chrome`，也就是系統裝的 Google Chrome（`coreBundle.js:74297-74303`），container 裡沒有。
  要加 `--browser chromium`（對應 `chrome-for-testing` channel，`coreBundle.js:74350-74351`），
  而且瀏覽器版本跟著 @playwright/mcp 自帶的 playwright（0.0.83 帶 1.64 alpha），不是 frontend 的 1.59，
  要另外裝那一版的瀏覽器。

## 5. agent-runner 要改什麼

**不用改。** `src/sandbox.ts:70-84` 的 `run()` 已經讓 claude 在 worktree 根目錄以 `-p` 執行，`.mcp.json` 會被載入；
setup hook（`src/sandbox.ts:32`、`:84`）在 agent 啟動前跑完 `pnpm install`，`npx playwright` 找得到 frontend 的本地 bin。

沒驗到的部分：

- 沒有在真的 sandbox image 裡跑過 `playwright-test` server（照指示沒動真 runner 和 teamsync-frontend）。
  `sh -c "cd frontend && ..."` 依賴 Claude Code 用專案根目錄當 stdio server 的 cwd；本機實驗沒驗這一點。
- 本機實驗的 Claude Code 是 2.1.291；sandbox image 的 Claude CLI 沒釘版本（`Dockerfile` 用 install.sh 裝最新），
  文件說的行為若在未來版本改變，這裡不會知道。
