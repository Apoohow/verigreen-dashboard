import sqlite3, sys
sys.stdout.reconfigure(encoding='utf-8')

DB = r'C:\Users\hollm\OneDrive\桌面\AI專案\data\verigreen.db'
conn = sqlite3.connect(DB)

# 1. 修正 ticker 被錯誤設成 UUID 的公司
#    (這些公司的 ticker 長度 > 10 表示是 UUID)
bad_ticker = conn.execute(
    "SELECT company_id, name, ticker FROM companies WHERE length(ticker) > 10"
).fetchall()
print("Ticker 需修正：")
for cid, name, ticker in bad_ticker:
    # 從舊的 name 欄（修前存的是代碼）取不到，改從 company_id 對應的 CSV 名稱推斷
    # 這邊只有兩筆：嘉新(1103), 環球(1104)，手動對應
    print(f"  {cid[:8]}... name={name!r} ticker={ticker[:12]}...")

# 直接查出正確的 ticker：找同名但 ticker 正確的另一筆
rows = conn.execute("SELECT company_id, name, ticker FROM companies").fetchall()
name_to_ticker = {name: ticker for _, name, ticker in rows if ticker and len(ticker) <= 6}
print("\nname_to_ticker:", name_to_ticker)

fixed_ticker = 0
for cid, name, ticker in bad_ticker:
    correct_ticker = name_to_ticker.get(name)
    if correct_ticker:
        conn.execute("UPDATE companies SET ticker=? WHERE company_id=?", (correct_ticker, cid))
        print(f"Fixed ticker: {name!r} -> {correct_ticker}")
        fixed_ticker += 1

conn.commit()

# 2. 找重複公司（同名稱）
rows = conn.execute("SELECT company_id, name, ticker FROM companies ORDER BY name").fetchall()
from collections import defaultdict
by_name = defaultdict(list)
for cid, name, ticker in rows:
    by_name[name].append((cid, ticker))

print("\n重複公司：")
for name, entries in by_name.items():
    if len(entries) > 1:
        print(f"  {name!r}: {entries}")

# 3. 刪除重複中無報告的那筆
deleted = 0
for name, entries in by_name.items():
    if len(entries) <= 1:
        continue
    # 查各 company_id 有幾筆 report
    counts = []
    for cid, ticker in entries:
        cnt = conn.execute("SELECT COUNT(*) FROM reports WHERE company_id=?", (cid,)).fetchone()[0]
        counts.append((cnt, cid, ticker))
    counts.sort(reverse=True)  # 有最多 report 的排第一
    print(f"\n{name!r} 報告數: {[(cnt, cid[:8]) for cnt, cid, _ in counts]}")
    # 刪除沒有報告的那些（保留有最多報告的）
    keep_cid = counts[0][1]
    for cnt, cid, ticker in counts[1:]:
        if cnt == 0:
            conn.execute("DELETE FROM companies WHERE company_id=?", (cid,))
            print(f"  Deleted duplicate: {cid[:8]}... (0 reports)")
            deleted += 1
        else:
            print(f"  Kept (has reports): {cid[:8]}...")

conn.commit()
conn.close()
print(f"\nDone. Fixed {fixed_ticker} tickers, deleted {deleted} duplicates.")
