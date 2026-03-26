## VeriGreen（漂綠檢測）專案骨架

### 目錄
- `SPEC.md`：工程規格與驗收條件
- `backend/`：FastAPI（上傳 PDF、解析、示範分析、Evidence/Chat citations）
- `frontend/`：Vite + React + TS（三欄式儀表板 UI）

---

## 啟動方式（Windows / PowerShell）

### 1) 後端
在專案根目錄執行：

```bash
.\.venv\Scripts\python -m pip install -r backend\requirements.txt
.\.venv\Scripts\python -m uvicorn backend.app.main:app --reload --port 8000
```

後端會建立資料夾 `data/`（SQLite 與上傳的 PDF）。

### 2) 前端
另開一個終端，在專案根目錄執行：

```bash
cd frontend
npm install
npm run dev
```

前端預設 `http://localhost:5173`，後端預設 `http://localhost:8000`。

---

## MVP 目前狀態
- **可用**：上傳 PDF → 後端抽取文字（pypdf）→ 產生示範分數/拆解/evidence → 前端三欄 UI 顯示 → Chat 回答附 citations（示範）
- **待接**（下一步）：向量化（embeddings）/ 向量庫 / 真正的維度檢索與打分 / OCR（掃描 PDF）

