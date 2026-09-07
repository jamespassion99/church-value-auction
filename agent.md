# 給 AI / 開發協助者的專案說明

這份文件是給之後接手修改這個專案的 AI agent（或任何開發者）看的，
用來快速了解專案結構、技術決策與注意事項，避免重複踩雷或做出跟現況矛盾的改動。

## 專案是什麼

教會活動用的「價值大拍賣」即時多人網頁遊戲：固定價格、玩家自行決定買或不買（**不是喊價競標**）。
詳細玩法規則見 [`game_skills.md`](./game_skills.md)。
部署與操作說明（給非技術使用者看的）在 [`README.md`](./README.md)。
這次建置的過程與決策脈絡在 [`session.md`](./session.md)。

## 技術架構

- **後端**：Node.js + Express + Socket.io（`server.js`），單一程序、記憶體內狀態，沒有資料庫。
  - 所有遊戲狀態（項目資料、玩家籌碼與購買紀錄、目前開放中的項目）都存在 `server.js`
    頂層的變數裡（`allItems`、`players`、`currentItemId`）。**伺服器重啟會清空所有進度**，
    這是刻意的設計取捨（單場活動用，不需要長期持久化），如果之後要支援跨場次保存，
    需要另外加儲存機制。
- **前端**：純 vanilla HTML/CSS/JS，沒有任何建置流程（no bundler, no framework）。
  三個頁面共用 `public/style.css`：
  - `public/player.html` — 玩家頁面（`/`）
  - `public/admin.html` — 管理者控制台（`/admin`）
  - `public/display.html` — 投影頁面（`/display`）
- **即時通訊**：Socket.io，事件命名慣例是 `namespace:action`
  （例如 `admin:startItem`、`item:buy`、`state:update`）。
- **項目內容**：`data/items.json`（`{id, title, price}`），管理者也可以透過 `/admin`
  的編輯功能即時修改名稱和價格（見 `admin:updateItem` 事件），但項目正在開放中時不能改。
- **背景圖片**：`public/images/*.jpg` 是從主日簡報 `主日分享0906.pdf` 抽出來的原始頁面圖片
  （用 PyMuPDF 抽的，抽取腳本沒有留在專案裡），檔名對應 `data/items.json` 的 `id`
  （例如 `life-1.jpg` 對應項目 `life-1`），另外 `intro.jpg`（開場閒置畫面）跟
  `reveal.jpg`（結尾「無法競標」畫面）。**注意：這些圖片上印的價格是簡報原始的價格，
  跟 `items.json` 裡實際使用的價格不一致**（例如 iPhone 圖片上印的是「起標價8萬」，
  但遊戲實際價格是9萬）——因此 `display.html` 故意把背景圖用 `blur(14px)
  brightness(0.42)` 模糊處理，只當作氛圍背景，畫面上清楚顯示的價格永遠是即時從
  `state.item.price` 來的正確數字。**修改任何項目的價格時不需要、也不應該去改圖片**，
  圖片模糊到看不出印刷文字，這是刻意的設計。

## 核心邏輯：固定價格購買

`server.js` 沒有計時器、沒有喊價狀態機——每個項目就是 `{id, title, price}`，
`currentItemId` 是唯一「目前開放中」的項目。玩家的 `purchases` 是一個
`Map(itemId -> price)`，記錄他買過哪些項目（多個玩家可以買同一個項目，
不是誰買到就沒了）。

`item:buy` 事件驗證：項目必須是目前開放中的（`itemId === currentItemId`）、
玩家還沒買過這項、餘額夠付。不夠這三個條件都直接拒絕，不做任何排隊或搶購邏輯。

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
- 目前沒有自動化測試。改動核心邏輯（購買驗證、餘額計算）後，建議用一個簡單的
  `socket.io-client` 腳本模擬購買流程驗證行為（本機 `npm install --no-save socket.io-client`
  後寫一個一次性測試腳本，測完刪除），不要假設程式碼看起來對就沒問題。
- 11 項的內容跟價格已經是**案主確認過的正式版本**（來源：`主日分享0906.pdf`），
  不是佔位文字，改動前務必跟案主確認。
- 這個專案最早的版本是「喊價競標」（有倒數計時、最高出價者得標），後來案主拿出實際
  簡報內容後整個改成「固定價格、買或不買」——如果看到任何殘留的喊價相關措辭或邏輯，
  那是沒清乾淨，應該修掉。
