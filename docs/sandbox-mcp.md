# sandbox 的 project MCP 載入與瀏覽器條件

以下是 Claude Code 的實測記錄。Codex 使用獨立設定，不沿用 host MCP；此次 gateway 遷移以 playwright-cli 驗證瀏覽器能力，未把這些 Claude MCP 結論視為 Codex 的驗證結果。

來源：研究票 [#13](https://github.com/henry5720/agent-runner/issues/13)；完整實驗紀錄存於該 issue 留言。
原研究查核日：2026-10-06，sandcastle 0.12.0、Claude Code 2.1.291、Playwright 1.59.1、`@playwright/mcp` 0.0.83。
2026-10-15 封存整理時核對 runner 主線的 `src/sandbox.ts` 與 `Dockerfile`，沒有重跑原實驗或重新查核上游文件。

## MCP 從目標 repo 載入

原研究的結論是：sandcastle 在 worktree 根目錄執行 `claude -p`，會載入該目錄的 `.mcp.json`，
不必為此修改 runner，也不必額外傳 `--mcp-config` 或設定 `enableAllProjectMcpServers`。
這是上述版本的文件與本機實驗結論，不保證未來 Claude Code 版本維持相同行為。

- 原研究查到的 sandcastle 指令以 `--print --verbose --dangerously-skip-permissions --output-format stream-json` 啟動 Claude Code，prompt 由 `-p -` 的 stdin 傳入，沒有額外 MCP 設定旗標。
- 原研究引用的 [Claude Code MCP 文件](https://code.claude.com/docs/en/mcp) 說明：project scope 的核准提示限互動 session；`claude -p` 直接載入。`--dangerously-skip-permissions` 的用途是略過權限提示，不是啟用 MCP 的開關；參數用法見 [CLI reference](https://code.claude.com/docs/en/cli-reference)。
- 本機實驗在未信任的空目錄放 `.mcp.json`，以相同參數執行；`system/init` 回報 project server `connected`。該實驗不是 sandbox container 實測。

目前 runner 的 [sandbox adapter](../src/sandbox.ts) 仍使用 sandcastle 的 `claudeCode()` 與 `run()`，
沒有自行加入 MCP 旗標。目標 repo 必須自行提供所需的 `.mcp.json`、套件與工具；
掛入 global 規則或 skills 不代表 host 的 MCP 設定也會被掛入，掛載範圍見 [README](../README.md#共用規則不共用-host-權限)。

## 瀏覽器與 headless

以下是原研究版本的差異，升級 Playwright 或換 MCP server 時需重新核對：

| MCP server | 原研究確認的預設 | sandbox 所需條件 |
| --- | --- | --- |
| `playwright-test`（`npx playwright run-test-mcp-server`） | 未明確指定 headless 時，設有 `CI` 或 Linux 沒有 `DISPLAY` 就用 headless | 目標 repo 的 Playwright 與對應 Chromium |
| `@playwright/mcp` | Linux 沒有 `DISPLAY` 時自動 headless；預設 browser channel 是 Google Chrome | 原研究建議加 `--browser chromium`，並安裝該 MCP 自帶 Playwright 版本的瀏覽器，不能假定目標 repo 的 Chromium 可共用 |

目前 [Dockerfile](../Dockerfile) 設 `CI=1`，未設 `DISPLAY`，並安裝 Chromium 系統依賴；
[sandbox adapter](../src/sandbox.ts) 的 setup hook 先在 `frontend` 執行
`pnpm install --frozen-lockfile`，再執行 `pnpm exec playwright install chromium`。
這只能確認準備步驟，不能據此宣稱 MCP 已在真實 container 啟動成功。

## 未驗範圍與重查時機

- 原研究沒有在真實 sandbox image 裡啟動 `playwright-test` server，也沒有驗證 stdio server 的 cwd 能否讓 `cd frontend` 正常執行。
- 本次封存沒有重跑 MCP、瀏覽器、登入或瀏覽器驗收；本文件不代表 [#12](https://github.com/henry5720/agent-runner/issues/12) 已完成。
- Dockerfile 用安裝腳本取得 Claude CLI，沒有釘版本。重建 image、升級 sandcastle／Playwright 或更換 MCP server 後，重新確認載入方式、cwd、瀏覽器版本與 headless 行為。
