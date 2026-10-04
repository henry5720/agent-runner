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

裝在 company-ec2（可重複跑；不 build image、不打開開關）：

```bash
git clone <runner repo> ~/agents/agent-runner && ~/agents/agent-runner/install.sh
```

`install.sh`：`npm ci` → 沒有 bot clone 就 clone，設 `.sandcastle/` exclude 與 `user.name` → `mkdir -p` pnpm store →
檢查 `~/.config/agent-runner/env` 存在且 600（不符合就印出要放的變數並停下）→ 連結 `systemd/` 到 `~/.config/systemd/user/` →
寫 timer 的 drop-in（輪次間隔、自動關時間，從 `src/config.ts` 產生）→ `daemon-reload` → `loginctl enable-linger` → `agent-runner` 連到 `~/.local/bin`。

開關（systemd user units）：

```bash
agent-runner on          # 立刻跑一輪，之後每 roundIntervalMinutes（60）分鐘一輪；到 autoOff（平日 08:00 Asia/Taipei）自動關
agent-runner off         # 正在做的那張做完就停
agent-runner off --now   # 立刻停，正在做的那張照 crash 收尾
agent-runner status      # 開關、下次觸發、目前在跑哪張、runner commit

# 維護（有一輪在跑就不動手）
agent-runner update                  # git pull --ff-only + npm ci；runner 只透過這個更新
agent-runner rebuild                 # 同一個 tag 不用 cache 重 build image（更新 Claude CLI）
agent-runner clean-store             # 清空 runner 自己的 pnpm store
agent-runner clean-worktrees [--all] # 刪超過 3 天的 sandcastle worktree；--all 全刪
```

輪次間隔與自動關時間只寫在 `src/config.ts`：`on`、`update`、`install.sh` 會把它們寫成
`~/.config/systemd/user/agent-runner{,-autooff}.timer.d/config.conf`（`src/systemd.ts`），`systemd/*.timer` 本身不寫時間。

重接時 `agent/<N>` 上有不是 runner 做的 commit：不碰 branch 和 PR，留言請人決定、發一則 Slack（✋），
並拿掉 `ready-for-agent`，不然每一輪都會再問一次。要 runner 重做就照留言刪掉遠端 branch 再貼回。

runner 自己失敗（`agent-runner.service` 的 `OnFailure=`）→ `agent-runner-failure.service` 發 Slack 附 `journalctl` 最後 20 行，
同一原因一晚（到下一次 08:00 Asia/Taipei）只發一次，記錄在 `~/.local/state/agent-runner/failure-notified.json`。

## 結構

| 檔案 | 做什麼 |
| --- | --- |
| `src/config.ts` | 全部設定（目標 repo、挑單條件、路徑、git author、timeout、輪次間隔、自動關…） |
| `src/names.ts` | label 名稱、`agent/<N>` branch、sandcastle worktree 目錄名 |
| `src/systemd.ts` | 從設定產生 timer 的 drop-in（輪次間隔、自動關 OnCalendar） |
| `src/decide.ts` | 純函式 `decide(snapshot, now)`：這一輪要做哪些事 |
| `src/runRound.ts` | 一輪的流程，邊界全部從 `deps` 注入 |
| `src/notice.ts` | 每張單收尾的 Slack 訊息文字（結局 emoji、單名、PR、花多久、一句原因） |
| `src/ports.ts` | `github`／`git`／`sandbox`／`notifier`／`clock` 的介面 |
| `src/github.ts` `src/git.ts` `src/sandbox.ts` `src/notifier.ts` `src/clock.ts` | 真的實作（`gh`、bot clone、sandcastle＋docker、通知、時間） |
| `src/autoOff.ts` | 下一次自動關的時間（`decide` 用它判斷「剩不到一個 timeout 就不接」） |
| `src/lock.ts` `src/runState.ts` `src/power.ts` | `flock -n` 輪次鎖、`~/.local/state/agent-runner/current`（給 `status`）、開關＝`agent-runner.timer` 有沒有在跑 |
| `bin/agent-runner` | CLI（bash 薄殼，`systemctl --user`） |
| `src/cli.ts` | CLI 裡要讀設定或碰 adapter 的子指令（`rebuild`、`clean-*`、`notify-failure`、給 `install.sh` 的設定值） |
| `src/maintenance.ts` | `rebuild`、`clean-worktrees` |
| `src/failure.ts` | runner 自己失敗的 Slack 通知，同一原因一晚一次 |
| `install.sh` | 安裝／修環境（可重複跑） |
| `systemd/` | `agent-runner.service`／`.timer`、`agent-runner-autooff.timer`／`.service`、`agent-runner-failure.service` |
| `src/image.ts` | image tag = hash(Dockerfile + 目標 repo 的 `.nvmrc`) |
| `src/endings.ts` | 沒開成 PR 的結局：`needs-info`、timeout／crash（含做完卻沒 commit）留言、殘留 `agent-in-progress`、刪超過 3 天的 worktree |
| `src/prBody.ts` `src/result.ts` | PR body、agent 回報的結構化結果 schema |
| `prompts/implement.md` `prompts/review.md` | 實作 prompt、reviewer prompt（只指向目標 repo 的 `CLAUDE.md` 和 skills） |
| `Dockerfile` | sandbox image |
| `test/support/fakes.ts` | in-memory 假邊界，測試共用 |
| `docs/verification.md` | sandcastle 行為的實測紀錄 |

secret（`CLAUDE_CODE_OAUTH_TOKEN`）放 `~/.config/agent-runner/env`（chmod 600），不進 repo。
