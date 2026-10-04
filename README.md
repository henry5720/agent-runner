# agent-runner

在 company-ec2 上把帶 `ready-for-agent` 的 issue 丟進 Docker sandbox（[sandcastle](https://github.com/mattpocock/sandcastle)）實作，
然後從 `agent/<N>` 開 draft PR。設計見 ShuChenAI/teamsync-frontend#2692。

目前可以手動跑一輪：實作 run → reviewer run → 全過開 draft PR，檢查沒過開 `[WIP]` draft PR（#2696、#2697）。

```bash
npm ci
npm run round       # 跑一輪：挑單 → sandbox 實作 → draft PR
npm test            # unit test（不連網）
npm run typecheck
```

開關（systemd user units；連結 units 與 CLI 由 `install.sh` 負責，ShuChenAI/teamsync-frontend#2703）：

```bash
agent-runner on          # 立刻跑一輪，之後每 60 分鐘一輪；平日 08:00 Asia/Taipei 自動關
agent-runner off         # 正在做的那張做完就停
agent-runner off --now   # 立刻停，正在做的那張照 crash 收尾
agent-runner status      # 開關、下次觸發、目前在跑哪張、runner commit
```

## 結構

| 檔案 | 做什麼 |
| --- | --- |
| `src/config.ts` | 全部設定（目標 repo、挑單條件、路徑、git author、timeout…） |
| `src/decide.ts` | 純函式 `decide(snapshot, now)`：這一輪要做哪些事 |
| `src/runRound.ts` | 一輪的流程，邊界全部從 `deps` 注入 |
| `src/notice.ts` | 每張單收尾的 Slack 訊息文字（結局 emoji、單名、PR、花多久、一句原因） |
| `src/ports.ts` | `github`／`git`／`sandbox`／`notifier`／`clock` 的介面 |
| `src/github.ts` `src/git.ts` `src/sandbox.ts` `src/notifier.ts` `src/clock.ts` | 真的實作（`gh`、bot clone、sandcastle＋docker、通知、時間） |
| `src/autoOff.ts` | 下一次自動關的時間（`decide` 用它判斷「剩不到一個 timeout 就不接」） |
| `src/lock.ts` `src/runState.ts` `src/power.ts` | `flock -n` 輪次鎖、`~/.local/state/agent-runner/current`（給 `status`）、開關＝`agent-runner.timer` 有沒有在跑 |
| `bin/agent-runner` | CLI（bash 薄殼，`systemctl --user`） |
| `systemd/` | `agent-runner.service`／`.timer`、`agent-runner-autooff.timer`／`.service` |
| `src/image.ts` | image tag = hash(Dockerfile + 目標 repo 的 `.nvmrc`) |
| `src/endings.ts` | 沒開成 PR 的結局：`needs-info`、timeout／crash 留言、殘留 `agent-in-progress`、刪超過 3 天的 worktree |
| `src/prBody.ts` `src/result.ts` | PR body、agent 回報的結構化結果 schema |
| `prompts/implement.md` `prompts/review.md` | 實作 prompt、reviewer prompt（只指向目標 repo 的 `CLAUDE.md` 和 skills） |
| `Dockerfile` | sandbox image |
| `test/support/fakes.ts` | in-memory 假邊界，測試共用 |
| `docs/verification.md` | sandcastle 行為的實測紀錄 |

secret（`CLAUDE_CODE_OAUTH_TOKEN`）放 `~/.config/agent-runner/env`（chmod 600），不進 repo。
