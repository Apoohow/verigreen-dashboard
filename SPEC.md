# VeriGreen（漂綠檢測）MVP 工程規格

本文件定義 **VeriGreen PC 端三欄式漂綠檢測儀表板** 的 MVP 功能範圍、資料模型、API 契約、UI 元件與狀態流，作為前後端並行開發與驗收依據。

---

## 1. MVP 目標與非目標

### 1.1 MVP 目標
- **上傳 PDF**：使用者上傳企業 ESG/永續報告 PDF
- **解析與引用**：抽取文字、切塊（chunk），所有 evidence 與聊天回答 **必須附 citations（頁碼＋原文）**
- **三欄式儀表板**：
  - 左欄：公司清單、搜尋、產業篩選、上傳入口
  - 中欄：整體分數、拆解、關鍵指標對照、五維雷達
  - 右欄：Evidence Summary、AI Analyst Chatbot（RAG + citations）

### 1.2 MVP 非目標（先不做或 v1.1+）
- 掃描 PDF 的高品質 OCR（MVP 可 best-effort 或不支援）
- 表格/圖表的精準結構化抽取
- 五年縱向比對與全產業橫向對比（資料結構預留）
- TEJ/第三方資料自動對齊（資料模型預留）

---

## 2. 系統架構（MVP）

### 2.1 元件
- **Frontend**：React（Vite + TS），三欄式 Dashboard
- **Backend API**：FastAPI
- **Storage（MVP）**：
  - PDF：本機檔案（`./data/reports/`）
  - 解析文字/分析結果：SQLite（`./data/verigreen.db`）
  - 向量索引（MVP stub）：先以記憶體或簡化索引占位；之後可替換 pgvector/Qdrant

### 2.2 端到端流程
1. 上傳 PDF → 取得 `report_id`
2. Ingestion：逐頁抽取文字（保留頁碼）
3. Chunking：段落合併/切分成 chunks（保留 chunk→頁碼關聯）
4. Index：embedding + 向量庫（MVP 可先 stub）
5. Analyze：五維度掃描 + evidence 擷取 + 分數聚合（MVP 可先 heuristics / demo）
6. Serve：Dashboard 讀取 analysis、evidence；Chat 走 RAG 並附 citations

---

## 3. 資料模型（Relational DB + Vector Index）

> MVP 先用 SQLite；production 可換 Postgres。向量庫可改用 pgvector/Qdrant/Milvus。

### 3.1 `companies`
- `company_id` (uuid, pk)
- `name` (text)
- `ticker` (text, nullable)
- `industry` (text, nullable)
- `created_at` (datetime)

### 3.2 `reports`
- `report_id` (uuid, pk)
- `company_id` (uuid, fk)
- `year` (int, nullable)
- `source_pdf_path` (text) 或 `source_pdf_id`（物件儲存 key）
- `pages` (int, nullable)
- `status` (text)：`uploaded | ingested | indexed | analyzed | failed`
- `created_at` (datetime)

### 3.3 `report_pages`（建議保留，強化 citations）
- `report_id` (uuid)
- `page_number` (int)
- `text` (text)

### 3.4 `chunks`
- `chunk_id` (uuid, pk)
- `report_id` (uuid, fk)
- `company_id` (uuid)
- `year` (int, nullable)
- `industry` (text, nullable)
- `page_start` (int)
- `page_end` (int)
- `section` (text, nullable)
- `text` (text)
- `token_count` / `char_count` (int)

### 3.5 `analyses`
- `analysis_id` (uuid, pk)
- `report_id` (uuid, fk)
- `overall_score` (int 0..100)
- `risk_level` (text)：`low | moderate | high`
- `dimension_scores` (json)：五維度分數
- `breakdown` (json)：對應白板 ABC 衡量標準的拆解
- `generated_at` (datetime)
- `model_version` (text, nullable)

### 3.6 `evidence_items`
- `evidence_id` (uuid, pk)
- `analysis_id` (uuid, fk)
- `dimension` (text)：五維度之一
- `claim` (text)：可疑點摘要
- `severity` (float)：0..1 或 1..5
- `citations` (json array)：
  - `chunk_id` (uuid)
  - `page_number` (int)
  - `quote` (text, 200–500 字)
  - `confidence` (float, optional)

### 3.7 `chat_sessions` / `chat_messages`
> MVP 可先不落 DB，或只保留 session（可回放）。回答必附 citations。

---

## 4. API 契約（REST + JSON）

所有回應建議帶 `request_id`（便於追蹤），錯誤以 `{error: {code, message}}` 回傳。

### 4.1 公司清單（左欄）
`GET /api/companies?query=&industry=&risk_level=&limit=&offset=`

Response：
- `items[]`：`company_id, name, ticker, industry, latest_report_year, latest_overall_score, latest_risk_level`
- `total`

### 4.2 上傳報告（左欄按鈕）
`POST /api/reports/upload`（multipart/form-data）
- `file`：PDF
- `company_name`（可選）
- `ticker`（可選）
- `industry`（可選）
- `year`（可選）

Response：
- `report_id`
- `status`：`uploaded`

### 4.3 報告狀態
`GET /api/reports/{report_id}`

Response：
- `report_id, company_id, year, pages, status`
- `progress`（可選）：`ingest/index/analyze` 百分比

### 4.4 分析結果（中欄）
`GET /api/reports/{report_id}/analysis`

Response：
- `overall_score, risk_level`
- `breakdown[]`：`reason, weight, score_contribution`
- `key_metrics[]`：`metric, target, actual, gap, status`
- `dimension_scores`：`{dimension: score}`

### 4.5 Evidence Summary（右欄上半）
`GET /api/reports/{report_id}/evidence?dimension=`

Response：
- `items[]`：`evidence_id, dimension, claim, severity, citations[]`
- `citations[]`：`chunk_id, page_number, quote`

### 4.6 取頁面文字（點頁碼）
`GET /api/reports/{report_id}/pages/{page_number}`

Response：
- `page_number`
- `text`
- `highlights[]`（可選）：`quote` 或定位資訊

### 4.7 Chatbot（右欄下半）
`POST /api/reports/{report_id}/chat`

Body：
- `session_id`（可選）
- `message`

Response：
- `session_id`
- `answer`
- `citations[]`：`chunk_id, page_number, quote`
- `suggested_questions[]`（可選）

---

## 5. UI 拆解（元件、狀態流、互動）

### 5.1 Layout
- `DashboardLayout`
  - `HeaderBar`
  - `LeftPanel`（公司/上傳）
  - `MainPanel`（分數/雷達/指標）
  - `RightPanel`（evidence/chat）

### 5.2 左欄
- `CompanySearchBar`、`IndustryFilter`、`CompanyList`、`CompanyCard`、`UploadReportButton`
- 狀態：`empty | loading | error | ready`

### 5.3 中欄
- `OverallScoreDonut`、`ScoreBreakdownList`、`KeyMetricsTable`、`RadarChart`
- 狀態：`loading | partial | ready | error`
- 互動：點選某維度 → 右欄 evidence 自動 filter

### 5.4 右欄
- `EvidenceSummary`、`EvidenceCard`、`CitationList`、`PagePreviewModal`
- `AnalystChat`、`QuickQuestions`、`MessageComposer`
- 互動：點 citation 頁碼 → 取頁面文字並高亮 quote

---

## 6. MVP 驗收條件（Definition of Done）
- 上傳 PDF 後可在左欄看到公司/報告與處理狀態
- 分析完成後：
  - 中欄能顯示：總分、拆解、雷達、至少 3 條 key metrics（可先 demo）
  - 右欄 Evidence 至少列出 3 條可疑段落，**每條都有頁碼與原文**
- Chat 對報告提問可回覆，且 **每次回答都附 citations**

