import csv
import os
import sqlite3

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
CSV = os.path.join(ROOT, "esg_sources_twse.csv")
DB = os.path.join(ROOT, "data", "verigreen.db")

names = {}
with open(CSV, encoding="utf-8") as f:
    for row in csv.DictReader(f):
        cid = row.get("company_id", "").strip()
        cname = row.get("company_name", "").strip()
        sector = row.get("sector", "").strip()
        if cid and cname:
            names[cid] = (cname, sector)

conn = sqlite3.connect(DB)
rows = conn.execute("SELECT company_id, name, ticker FROM companies").fetchall()
fixed = 0
for cid_uuid, name, ticker in rows:
    code = ticker or name
    if not code:
        continue
    code = str(code).strip()
    if code in names:
        proper_name, sector = names[code]
        if name != proper_name or not ticker:
            conn.execute(
                "UPDATE companies SET name=?, ticker=?, industry=COALESCE(NULLIF(industry,''), ?) WHERE company_id=?",
                (proper_name, code, sector, cid_uuid),
            )
            print("Fixed " + code + ": " + proper_name)
            fixed += 1
conn.commit()
conn.close()
print("Total fixed: " + str(fixed))
