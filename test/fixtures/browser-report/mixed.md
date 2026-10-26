## 瀏覽器驗收

證據：/tmp/verify-demo（runner 主機本機，不在 git）

| 條件 | 結果 | 帳號 | 看到什麼／原因 | 證據 |
|---|---|---|---|---|
| 儲存後出現 toast | passed | E2E_ADMIN | 點儲存後顯示「儲存成功」 | after-toast.png |
| 取消後關閉對話框 | failed | E2E_ADMIN | 按取消後對話框仍開著／對話框未關閉 | after-cancel.png |
| viewer 不能刪除 | skipped | E2E_VIEWER | 無 viewer 帳號可登入／缺少 E2E_VIEWER_EMAIL、E2E_VIEWER_PASSWORD | — |

console error：
- Error: save failed
- TypeError: cannot read x
另有 1 則判定與本次 diff 無關

判定 model：claude-sonnet-4-6（與實作同一個 model）

在 staging 建了 2 筆資料，清單在 /tmp/verify-demo/state.json

issue 沒有 ## Acceptance criteria，以下條件由 agent 從內文推出
