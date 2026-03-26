"""
比對 esg_sources_twse.csv 與 data/raw_pdfs/，統計有拿到／沒拿到的公司與報告筆數。
"""
from __future__ import annotations

import csv
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data" / "raw_pdfs"
CSV_PATH = ROOT / "esg_sources_twse.csv"


def file_base(stem: str) -> str:
    """與 download_esg_pdfs.safe_filename 對齊：檔名為 {company_id}_{year}_{lang}.pdf/.html"""
    return stem


def main() -> None:
    if not CSV_PATH.exists():
        print(f"找不到 CSV：{CSV_PATH}")
        return
    if not DATA_DIR.exists():
        print(f"找不到目錄：{DATA_DIR}")
        return

    # 現有檔案：stem -> 副檔名 (pdf/html)
    existing: dict[str, str] = {}
    for f in DATA_DIR.iterdir():
        if f.is_file():
            stem = f.stem
            ext = f.suffix.lower()
            if ext in (".pdf", ".html"):
                existing[stem] = ext

    # CSV 每筆預期檔名 stem = company_id_year_lang（與 safe_filename 一致）
    rows: list[dict] = []
    with CSV_PATH.open("r", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            rows.append(row)

    def stem_for(row: dict) -> str:
        cid = (row.get("company_id") or "").strip()
        year = (row.get("year") or "").strip() or "unknown"
        lang = (row.get("lang") or "").strip() or "unk"
        base = f"{cid}_{year}_{lang}".strip("_")
        return "".join(c for c in base if c.isalnum() or c in ("-", "_"))

    got_pdf = 0
    got_any = 0
    missing: list[dict] = []
    company_has_any: set[str] = set()
    company_missing: set[str] = set()

    for row in rows:
        stem = stem_for(row)
        cid = (row.get("company_id") or "").strip()
        ext = existing.get(stem)
        if ext == ".pdf":
            got_pdf += 1
            got_any += 1
            company_has_any.add(cid)
        elif ext == ".html":
            got_any += 1
            company_has_any.add(cid)
        else:
            missing.append({**row, "expected_stem": stem})
            company_missing.add(cid)

    # 沒拿到的是「在 CSV 有列但完全沒檔案」的公司
    company_missing = company_missing - company_has_any

    total_rows = len(rows)
    total_companies = len({r.get("company_id", "").strip() for r in rows if r.get("company_id")})
    companies_with_any = len(company_has_any)
    companies_with_pdf_only = len({cid for cid in company_has_any if any(
        existing.get(stem_for(r)) == ".pdf" for r in rows if (r.get("company_id") or "").strip() == cid
    )})

    print("=== 報告筆數（每筆 = 一公司一年度一語系）===")
    print(f"  CSV 總筆數：     {total_rows}")
    print(f"  已取得（任一）： {got_any}  （其中 PDF：{got_pdf}）")
    print(f"  未取得：         {len(missing)}")
    print()
    print("=== 公司家數（依 company_id）===")
    print(f"  CSV 內公司數：   {total_companies}")
    print(f"  至少有一份報告： {companies_with_any} 家")
    print(f"  完全沒有報告：   {len(company_missing)} 家")
    print()
    missing_list_path = ROOT / "data" / "missing_companies.txt"
    missing_list_path.parent.mkdir(parents=True, exist_ok=True)
    id_to_name = {r["company_id"]: r.get("company_name", "") for r in rows if r.get("company_id")}
    with missing_list_path.open("w", encoding="utf-8") as out:
        out.write(f"# 完全沒有報告的公司（共 {len(company_missing)} 家）\n")
        out.write("# company_id\t公司名稱\n")
        for cid in sorted(company_missing, key=lambda x: (len(x), x)):
            out.write(f"{cid}\t{id_to_name.get(cid, '')}\n")
    print(f"未取得公司清單已寫入：{missing_list_path}")

    if company_missing:
        print("--- 沒有報告的公司（company_id, 公司名稱）前 30 筆 ---")
        for cid in sorted(company_missing, key=lambda x: (len(x), x))[:30]:
            print(f"  {cid}  {id_to_name.get(cid, '')}")
    if missing and len(missing) <= 80:
        print()
        print("--- 未取得的報告筆數明細（前 80 筆：company_id, year, lang）---")
        for r in missing[:80]:
            print(f"  {r.get('company_id')}  {r.get('year')}  {r.get('lang')}  {r.get('company_name', '')[:20]}")
    elif missing:
        print()
        print(f"（未取得共 {len(missing)} 筆，僅列出缺報告的公司如上）")


if __name__ == "__main__":
    main()
