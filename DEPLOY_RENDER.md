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
- `GEMINI_API_KEY=<Google AI Studio API Key>`（**必填**，分析與 Chatbot 皆用 `gemini-2.5-flash`；未設定時 LLM 相關功能會失敗）
- `ESG_CSR_INSECURE_SSL`：`render.yaml` 已預設為 `true`。**原因**：證交所 `esggenplus.twse.com.tw` 等站點在 Render（Linux / OpenSSL 3）上常觸發 `CERTIFICATE_VERIFY_FAILED`／`Missing Subject Key Identifier`；程式會依此變數對 TWSE／MOPS 下載改用 `verify=False`（僅影響該下載連線，有 MITM 權衡）。若你手動關閉後自動抓取又失敗，請改回 `true`。

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
