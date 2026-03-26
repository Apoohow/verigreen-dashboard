# DB Fix Scripts

這個資料夾收納一次性或維運用的資料修復腳本（SQLite）。

## 保留腳本

- `fix_names_auto.py`: 依 `esg_sources_twse.csv` 修正公司名稱、ticker、industry。
- `fix_breakdown.py`: 修正 `analyses.breakdown` reason 標籤與結構。
- `fix_dim_scores2.py`: 修正 `analyses.dimension_scores` 舊 key 到新 key。
- `fix_dimensions.py`: 修正 `evidence_items.dimension` 標準化。
- `fix_duplicates.py`: 通用重複公司檢查與清理。
- `fix_duplicates2.py`: 特定公司重複資料的手動修復。

## 已刪除冗餘

- `fix_company_names.py`（由 `fix_names_auto.py` 覆蓋）
- `fix_industry.py`（由 `fix_names_auto.py` 覆蓋）
- `fix_dim_scores.py`（由 `fix_dim_scores2.py` 覆蓋）
