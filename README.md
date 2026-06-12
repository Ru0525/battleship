# 海戰棋 Battleship WebSocket

5×5 海戰棋雙人連線遊戲。

## 規則
- 艦隊：3格×1、2格×2、1格×1
- 艦艇間需相隔一格
- 命中 → 繼續砲擊
- 爆破（擊沉）→ 周圍8格自動清除 + 繼續砲擊
- 未中 → 換人

## 本機執行

```bash
npm install
npm start
# 開啟 http://localhost:3000
```

## 部署到 Railway（免費）

1. 前往 https://railway.app 註冊
2. New Project → Deploy from GitHub repo（上傳此資料夾）
3. 自動偵測 Node.js，點 Deploy
4. Settings → Networking → Generate Domain，取得公開網址
5. 兩人用同一網址即可連線對戰

## 部署到 Render（免費）

1. 前往 https://render.com 註冊
2. New → Web Service → 連結 GitHub repo
3. Build Command: `npm install`
4. Start Command: `node server.js`
5. 免費方案 750hr/月，閒置會休眠（首次連線需等約30秒喚醒）

## 房間機制
- 點「快速加入」自動配對或建立房間，畫面顯示6碼房間碼
- 可輸入房間碼讓指定的人加入
- 每個房間最多2人
