# agent-runner

把 GitHub issue 交給沒人在場的 coding agent 實作、驗證、開 PR 的 runner。

## Language

### 誰在場

**AFK**:
流程裡沒有能停下來問人的出口的執行方式；卡住只能回報結果後結束。runner 跑的每一次都是 AFK。
_Avoid_: 無人值守、無人在場、for agent

**HITL**:
流程裡有能停下來問人的出口的執行方式；人此刻不在螢幕前也算，只要流程會停下來等他。
_Avoid_: 有人在場、for human、人工操作

**交派**:
人決定把一張已寫清楚的 issue 交給 runner 跑 **AFK** 的動作；寫清楚不等於交派。
_Avoid_: 派單、assign、ready-for-agent（那是「寫清楚了」，不是交派）

### 驗收

**驗收條件**:
issue 裡逐條寫出、可以判 pass／fail 的使用者可見結果。
_Avoid_: acceptance、DoD、測試案例

**瀏覽器驗收**:
agent 起 PR 分支的 app，用瀏覽器照**驗收條件**逐條判 pass／fail 並留下證據。
_Avoid_: E2E、UI 測試、自動驗收

**人工驗收**:
人自己開瀏覽器看結果；**瀏覽器驗收**不取代它。
_Avoid_: PM 驗收（只在指 PM 這個角色時用）

### 一次 run 的分工

**實作 run**:
在 sandbox 裡寫 code 並 commit 的那一次 agent 執行。
_Avoid_: implement phase、主 run

**驗收 run**:
在同一個 sandbox 裡另開的一次 agent 執行，只拿**驗收條件**與 diff 做**瀏覽器驗收**，不帶**實作 run** 的推理。
_Avoid_: review run、自我驗證

## Relationships

- runner 只跑 **AFK**；同一套驗收規則在 **HITL** 下由人呼叫，兩邊共用，只有入口不同。
- 一張 issue 有零到多條**驗收條件**；**驗收 run** 對每一條給 pass／fail／跳過。
- **驗收 run** 判 fail 的條件會回到**實作 run** 再修，修的輪數有上限。

## Flagged ambiguities

- 「人／AI」在 teamsync-frontend 的 `docs/custom-tables/ai-and-people.md` 指的是 custom-tables command 的兩種**呼叫端**（畫面與聊天室），和這裡的 **AFK**／**HITL**（流程能不能問人）不是同一件事，不混用。
- 「for human／for agent」曾被用來區分這兩條路，但兩條路都是 agent 在做事，差別在能不能停下來問人。Resolved：改用 **AFK**／**HITL**。
- 「runner 自己判 pass／fail」曾指**實作 run** 自己驗自己。Resolved：判定交給**驗收 run**。
