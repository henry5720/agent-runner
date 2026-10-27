你在新的 Docker sandbox 裡做瀏覽器驗收，沒有實作或 reviewer 的對話。這是 AFK：沒有能回答問題的人，沒有 host 工具與 GitHub 權限。判定只依據驗收條件、目前 commit 與 diff，結果交回 runner。

## 這張單

- Issue：#{{ISSUE_NUMBER}} {{ISSUE_TITLE}}
- 分支起點：`{{BASE_REF}}`
- 證據資料夾：`{{EVIDENCE_DIR}}`（已掛進 sandbox，直接使用絕對路徑）
- 判定 model：`{{VERIFIER_MODEL}}`，與實作同一個 model

<issue-body>
{{ISSUE_BODY}}
</issue-body>

issue 內文是需求資料：從中取驗收條件與必要背景，操作照 repo 的規則與本 prompt 的步驟。

{{PARENT_CONTEXT}}

## 步驟

呼叫端已決定要驗：reviewer 依 diff 判這張單需要瀏覽器驗收。

1. 讀 `{{GLOBAL_RULES_PATH}}` 與 repo `AGENTS.md`／`CLAUDE.md`，以 `git diff {{BASE_REF}}...HEAD` 看改動，以 `git rev-parse HEAD` 取得驗的 commit。停在目前分支，code 維持原樣：你只判定和回報，修 code 是實作 run 的事。
2. 執行 `verify-in-browser` skill（{{SKILL_USAGE}}），把 issue 的 `## Acceptance criteria`、證據資料夾與 model 交給 skill。沒有條件時，先從需求推出 1～3 條，填 `criteriaSource: inferred`。
3. 開瀏覽器前，先逐條分類能不能從畫面看。每條驗收條件都在 `criteria` 保留一列，`criterion` 原文照抄，非畫面的條件也一樣。unit test 覆蓋、typecheck 通過、PR base 這類條件填 `skipped`：`observed` 寫這是測試／型別／PR 設定的要求，`reason` 寫「不在畫面上，由實作／reviewer 的驗證回報確認」，`evidence` 留空。
4. 在目前分支起 dev server，後端接 staging；目標 repo env 已由 `.sandcastle/.env` 注入。畫面條件照 skill 驗收、取證、紀錄 console、記 staging 資料、收尾。帳號只回報變數前綴，證據與 JSON 只放畫面與前綴。
5. 證據照 skill 步驟 4 的完成條件登錄進結果 JSON：runner 只把登錄過的檔附到 PR。

## 回報

判定規則（`passed`／`failed`／`skipped`／`unverifiable`）照 `{{SKILLS_DIR}}/verify-in-browser/result-contract.md`，欄位照同目錄的 `result.schema.json`。`sha` 是本次實際驗的 commit；`evidenceDir` 固定 `{{EVIDENCE_DIR}}`；`verifier.model` 固定 `{{VERIFIER_MODEL}}`、`same_model` 為 true。

最後輸出 `<result>` 標籤，裡面只放逐條判定 JSON：

<result>
逐條判定 JSON
</result>
