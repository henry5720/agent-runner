# 每個 phase 各開一次 run()，不共用 sandbox

實作 run、reviewer run 和之後加的驗收 run，各自呼叫一次 sandcastle 的 `run()`，每次重開 container。
原因：結構化結果（`Output.object`）與格式錯時的重交（`maxRetries`）只有 `run()` 支援；
`createSandbox()` 拿到的 `sandbox.run()` 沒有 `output`（sandcastle 0.12.0 `index.d.ts` 的 `SandboxRunOptions`）。
代價是每多一次 run 就多一次 install＋Chromium（約 90～110 秒）與 vite 首次編譯。

## Considered Options

- **`createSandbox()` 一次，多次 `sandbox.run()`，host 用 `sandbox.exec()` 重跑測試**：container 不用重開，
  host 能確定性地重跑測試。沒選：結構化輸出與重交要自己從 stdout 抽 tag 重寫一份；
  `hooks.sandbox.onSandboxReady` 的 `timeoutMs` 會被忽略、也沒有 `signal`，`off --now` 在 install 期間停不下來。
  sandcastle 的 `sandbox.run()` 支援 `output` 之後再評估。
