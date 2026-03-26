import sqlite3, sys
sys.stdout.reconfigure(encoding='utf-8')

DB = r'C:\Users\hollm\OneDrive\桌面\AI專案\data\verigreen.db'
conn = sqlite3.connect(DB)

# 1. 手動修正環球水泥 ticker
conn.execute(
    "UPDATE companies SET ticker='1104' WHERE name='環球水泥股份有限公司'"
)
print("Fixed 環球水泥 ticker -> 1104")

# 2. 合併嘉新水泥兩筆
#    ba2064cb: 2 reports (keep this as main)
#    e5d198df: 1 report (move its reports to ba2064cb, then delete)
KEEP = 'ba2064cb-2e14-432b-8736-4b2e3e364899'
DROP = 'e5d198df-6196-4c6e-b18a-8fa34ac48440'

# 把 DROP 的 reports 改指向 KEEP
moved = conn.execute(
    "UPDATE reports SET company_id=? WHERE company_id=?", (KEEP, DROP)
).rowcount
print(f"Moved {moved} report(s) from {DROP[:8]} to {KEEP[:8]}")

# 刪除多餘公司
conn.execute("DELETE FROM companies WHERE company_id=?", (DROP,))
print(f"Deleted duplicate company {DROP[:8]}...")

conn.commit()

# 3. 顯示最終清單
rows = conn.execute("SELECT name, ticker FROM companies ORDER BY ticker").fetchall()
print("\n最終公司清單：")
for name, ticker in rows:
    print(f"  {ticker or '----'}  {name}")

conn.close()
print("\nDone.")
