# Render 部署說明

## 1) 先推上 GitHub
- 把目前專案推到 GitHub。

## 2) Render 建立 Blueprint
- Render -> New -> Blueprint
- 選擇你的 repo
- 指定 `render.yaml`

這會建立兩個服務：
- `verigreen-backend`（FastAPI）
- `verigreen-frontend`（Vite static）

## 3) 設定環境變數

### Backend
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI=https://<your-backend>.onrender.com/api/auth/google/callback`
- `FRONTEND_BASE_URL=https://<your-frontend>.onrender.com`
- `SESSION_SECRET=<strong-random-string>`
- `SESSION_COOKIE_SECURE=true`

### Frontend
- `VITE_API_BASE=https://<your-backend>.onrender.com`

## 4) Google OAuth Console 設定

Authorized JavaScript origins:
- `https://<your-frontend>.onrender.com`

Authorized redirect URIs:
- `https://<your-backend>.onrender.com/api/auth/google/callback`

## 5) 驗證
- 開前端網址 -> 點 Google 登入
- 成功後可進 Dashboard
- 未登入直接打 API（如 `/api/companies`）應回 401
- 登出後再打受保護 API 應回 401
