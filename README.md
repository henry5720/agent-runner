# agent-runner

在 company-ec2 上把帶 `ready-for-agent` 的 issue 丟進 Docker sandbox（[sandcastle](https://github.com/mattpocock/sandcastle)）實作，
然後從 `agent/<N>` 開 draft PR。設計見 ShuChenAI/teamsync-frontend#2692。

目前只有手動跑一輪的 happy path（#2696）。

```bash
npm ci
npm run round       # 跑一輪：挑單 → sandbox 實作 → draft PR
npm test            # unit test（不連網）
npm run typecheck
```

## 結構

| 檔案 | 做什麼 |
| --- | --- |
| `src/config.ts` | 全部設定（目標 repo、挑單條件、路徑、git author、timeout…） |
| `src/decide.ts` | 純函式 `decide(snapshot, now)`：這一輪要做哪些事 |
| `src/runRound.ts` | 一輪的流程，邊界全部從 `deps` 注入 |
| `src/ports.ts` | `github`／`git`／`sandbox`／`notifier`／`clock` 的介面 |
| `src/github.ts` `src/git.ts` `src/sandbox.ts` `src/notifier.ts` `src/clock.ts` | 真的實作（`gh`、bot clone、sandcastle＋docker、通知、時間） |
| `src/image.ts` | image tag = hash(Dockerfile + 目標 repo 的 `.nvmrc`) |
| `src/prBody.ts` `src/result.ts` | PR body、agent 回報的結構化結果 schema |
| `prompts/implement.md` | 實作 prompt（只指向目標 repo 的 `CLAUDE.md` 和 skills） |
| `Dockerfile` | sandbox image |
| `test/support/fakes.ts` | in-memory 假邊界，測試共用 |
| `docs/verification.md` | sandcastle 行為的實測紀錄 |

secret（`CLAUDE_CODE_OAUTH_TOKEN`）放 `~/.config/agent-runner/env`（chmod 600），不進 repo。
