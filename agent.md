# 給 AI / 開發協助者的專案說明

這份文件是給之後接手修改這個專案的 AI agent（或任何開發者）看的，
用來快速了解專案結構、技術決策與注意事項，避免重複踩雷或做出跟現況矛盾的改動。

## 專案是什麼

教會活動用的「價值觀競標遊戲」，即時多人網頁遊戲。詳細玩法規則見 [`game_skills.md`](./game_skills.md)。
部署與操作說明（給非技術使用者看的）在 [`README.md`](./README.md)。
這次建置的過程與決策脈絡在 [`session.md`](./session.md)。

## 技術架構

- **後端**：Node.js + Express + Socket.io（`server.js`），單一程序、記憶體內狀態，沒有資料庫。
  - 所有遊戲狀態（題目狀態、玩家籌碼、目前競標進度）都存在 `server.js` 頂層的變數裡
    （`allItems`、`players`、`auction`）。**伺服器重啟會清空所有進度**，這是刻意的設計取捨
    （單場活動用，不需要長期持久化），如果之後要支援跨場次保存，需要另外加儲存機制。
- **前端**：純 vanilla HTML/CSS/JS，沒有任何建置流程（no bundler, no framework）。
  三個頁面共用 `public/style.css`：
  - `public/player.html` — 玩家頁面（`/`）
  - `public/admin.html` — 管理者控制台（`/admin`）
  - `public/display.html` — 投影頁面（`/display`）
- **即時通訊**：Socket.io，事件命名慣例是 `namespace:action`
  （例如 `admin:startItem`、`bid:submit`、`state:update`）。
- **題目內容**：`data/items.json`，管理者也可以透過 `/admin` 的編輯功能即時修改
  （見 `admin:updateItem` 事件），但只限「尚未開標」的題目。

## 核心邏輯：喊價計時的狀態機

在 `server.js` 裡，`auction` 物件是唯一的競標狀態來源，`callStage` 走 0→1→2→3：

```
0 = 剛喊價/競標中
1 = 第一次（喊價後 3 秒）
2 = 第二次（第一次後再 7 秒）
3 = 第三次成交（第二次後再 15 秒，此時扣款、標記售出）
```

`scheduleStage()` / `advanceStage()` 這兩個函式負責計時器；**任何新的有效喊價都會呼叫
`clearAuctionTimer()` 並重新從 stage 0 開始**，這是遊戲規則明確要求的行為，不要「優化」掉。

延遲常數在檔案最上面：`DELAY_FIRST=3000`、`DELAY_SECOND=7000`、`DELAY_THIRD=15000`（毫秒）。

## 部署現況

- GitHub repo：`github.com/jamespassion99/church-value-auction`（user 帳號 `jamespassion99`）
- 雲端部署：Render.com 免費方案，透過 `render.yaml`（Blueprint）自動建置，
  **push 到 `master` 分支會自動觸發 Render 重新部署**（約 2-5 分鐘）。
- 環境變數 `ADMIN_PASSWORD` 設定在 Render 後台，不寫在程式碼或任何文件裡。
- **使用者（案主）不熟悉 git/GitHub**，過去的修改都是由 AI agent（透過已授權的 `gh` CLI）
  直接執行 `git add/commit/push`，使用者只需要提供「要改成什麼」，不需要自己碰 git 指令。
  之後如果繼續協助這個專案，預設也是用這個模式：改檔案 → commit → push，讓 Render 自動部署。

## 修改時的注意事項

- 這是免費方案的雲端服務，**閒置會睡眠**，改動後第一次訪問可能要等 30-60 秒喚醒，
  不是程式壞掉。
- 前端三個頁面是各自獨立的 HTML 檔，共用 `style.css`，**沒有共用的 JS 檔**（各自內嵌
  `<script>`）。如果要抽共用邏輯，要注意這是刻意保持簡單、無建置流程的取捨，抽公用檔案前
  先想清楚是否值得增加複雜度。
- 目前沒有自動化測試。改動核心邏輯（喊價驗證、計時器）後，建議用一個簡單的
  `socket.io-client` 腳本模擬喊價流程驗證行為（本機 `npm install --no-save socket.io-client`
  後寫一個一次性測試腳本，測完刪除），不要假設程式碼看起來對就沒問題——這個專案的計時邏輯
  容易寫錯（差一秒、忘記 clearTimeout 等）。
- 21 題的題目文字目前是**佔位範例文字**，不是最終定案內容（案主之後可能會請 AI agent 或
  透過 `/admin` 的編輯功能自行修改）。
