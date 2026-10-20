# Tab Amp

Firefox 擴充套件：獨立調整每個分頁的音量（0% – 300%，上限可調到 2000%），並可記住各網域的音量。介面使用 [Basecoat](https://basecoatui.com)（shadcn/ui 風格）。

## 功能

- **分頁獨立音量**：每個分頁各自調整，在同一分頁瀏覽相同網域（含重新整理）時保留；切換到其他網域時重設。
- **套用至此網域**：開啟後，之後開啟該網域的網頁都會以記住的音量開始；開關開啟期間調整音量會同步更新規則。分頁中手動調整的音量優先於網域規則。
- **最大音量**：預設 300%，可在彈出視窗選 200 / 300 / 500 / 1000%，或在設定頁自訂 100% – 2000%。調低上限時，已存的規則與正在播放的分頁會一併降到新上限。
- 工具列徽章顯示目前分頁的音量；iframe（例如嵌入的 YouTube）跟隨所在分頁的音量。
- 設定頁可管理所有網域規則（修改、移除、全部移除）。
- 介面支援繁體中文與英文，並跟隨系統深色模式。

## 安裝（開發用）

需要 Firefox 140 以上。

```bash
npm install
npm run build      # 產生 extension/styles/ui.css（已預先建置，只改 JS 時可略過）
npm start          # 用 web-ext 開一個載入擴充套件的 Firefox
```

或手動載入：開啟 `about:debugging#/runtime/this-firefox` →「載入臨時附加元件」→ 選 `extension/manifest.json`。

## 指令

| 指令 | 說明 |
| --- | --- |
| `npm run build` | 用 Tailwind CSS 4 + Basecoat 建置 `extension/styles/ui.css` |
| `npm run watch` | 修改 HTML/JS 時自動重新建置 CSS |
| `npm start` | `web-ext run`，啟動載入此擴充套件的 Firefox |
| `npm run lint` | `web-ext lint` |
| `npm run package` | 建置並打包成 `dist/tab_amp-<版本>.zip` |

## 專案結構

```
src/ui.css                Tailwind 入口（引入 basecoat-css）
extension/
  manifest.json           Manifest V3
  background.js           決定每個分頁的音量（分頁設定 → 網域規則 → 100%），推送給 content script
  content.js              每個 frame 中把媒體接到 Web Audio GainNode
  popup/                  工具列彈出視窗
  options/                設定頁（最大音量、網域規則）
  shared/common.js        共用常數、storage 存取、i18n
  shared/theme.js         跟隨系統深色模式
  _locales/{en,zh_TW}/    介面文字
```

資料存放：`storage.local` 存設定與網域規則（`settings`、`rule:<網域>`），`storage.session` 存各分頁的音量（`tab:<id>`，關閉瀏覽器即清除）。網域以主機名稱比對，並去除開頭的 `www.`。

## 運作方式與限制

- 超過 100% 需要 Web Audio：content script 用 `createMediaElementSource` 把 `<video>`/`<audio>` 接到一個 GainNode。也會攔截 `play()`，因此 `new Audio()` 這類不在 DOM 裡的媒體同樣有效。
- **跨來源媒體**：來自其他網域、且沒有 CORS 標頭的媒體，接進 Web Audio 後會變成無聲，所以這類媒體改用 `element.volume`，只能調低、不能放大（彈出視窗會提示）。網頁本身已經接到自己 AudioContext 的媒體也一樣。YouTube、Twitch 等使用 MSE（`blob:`）的網站不受此限制。
- **自動播放政策**：使用者還沒和頁面互動前，Firefox 不允許 AudioContext 啟動。這時擴充套件會等到第一次點擊或按鍵才開始放大，而不是讓聲音消失；彈出視窗會提示「請先點擊頁面一次」。
- Firefox 內建頁面（`about:`）與 addons.mozilla.org 上無法執行，彈出視窗會顯示說明。
- 放大倍數很高時容易破音，這是放大本身造成的。
