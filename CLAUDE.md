# agent-runner

文件、註解、commit message 用繁體中文。怎麼運作看 [README.md](README.md)，用詞看 [GLOSSARY.md](GLOSSARY.md)，
決策紀錄在 [`docs/adr/`](docs/adr/)。

## 先用 sandcastle 原生的

runner 建在 [sandcastle](https://github.com/mattpocock/sandcastle) 上。要給 runner 加一項能力前，先查
`node_modules/@ai-hero/sandcastle/README.md` 與同目錄 `dist/*.d.ts` 有沒有原生的做法；有就用，沒有才自己寫。

已查過、sandcastle 做不到，所以 runner 自己做的（版本 0.12.0；升級後重查）：

| 需求 | 為什麼自己做 |
| --- | --- |
| push、開 PR | sandcastle 全在本機，不碰遠端 |
| 依天數清 worktree | `pruneStale` 只清沒登記在 git 的孤兒目錄 |
| 每次都從 base 重設分支 | 既有 worktree 會被原樣重用，`baseBranch` 只在分支不存在時生效 |
| build image 帶 `NODE_VERSION` | `sandcastle docker build-image` 不能帶 build-arg |
| 同一個 sandbox 跑多次並拿結構化結果 | `sandbox.run()` 沒有 `output`，見 [ADR 0001](docs/adr/0001-each-phase-is-its-own-run.md) |
| secret 檔與 sandbox env 分開 | `.sandcastle/.env` 會整份注入 sandbox，runner 的 secret 檔裡有不能進 sandbox 的值 |

目標 repo 的 `VITE_*`、`E2E_*` 放 bot clone 的 `.sandcastle/.env`（用 `.git/info/exclude` 排除，不 commit 進目標 repo：那是公司共用的 repo）。
