import sqlite3, sys
sys.stdout.reconfigure(encoding='utf-8')

DB = r'C:\Users\hollm\OneDrive\桌面\AI專案\data\verigreen.db'
conn = sqlite3.connect(DB)

# 找出沒有任何 analyzed 報告的公司
rows = conn.execute('''
    SELECT c.company_id, c.name, c.ticker,
           COUNT(r.report_id) AS total_reports,
           SUM(CASE WHEN r.status = "analyzed" THEN 1 ELSE 0 END) AS analyzed_reports
    FROM companies c
    LEFT JOIN reports r ON r.company_id = c.company_id
    GROUP BY c.company_id
''').fetchall()

print('公司狀況：')
for cid, name, ticker, total, analyzed in rows:
    flag = '✓' if analyzed else '✗'
    print(f'  {flag} {ticker or "----"}  {name}  (報告:{total}, 已分析:{analyzed or 0})')

no_analysis = [(cid, name, ticker) for cid, name, ticker, total, analyzed in rows if not analyzed]
print(f'\n無分析資料的公司：{len(no_analysis)} 筆')

for cid, name, ticker in no_analysis:
    # 刪除相關 reports（及其 chunks/evidence/pages）
    rids = [r[0] for r in conn.execute('SELECT report_id FROM reports WHERE company_id=?', (cid,)).fetchall()]
    for rid in rids:
        conn.execute('DELETE FROM evidence_items WHERE report_id=?', (rid,))
        conn.execute('DELETE FROM chunks WHERE report_id=?', (rid,))
        conn.execute('DELETE FROM report_pages WHERE report_id=?', (rid,))
        conn.execute('DELETE FROM analyses WHERE report_id=?', (rid,))
        conn.execute('DELETE FROM reports WHERE report_id=?', (rid,))
    conn.execute('DELETE FROM companies WHERE company_id=?', (cid,))
    print(f'  Deleted: {ticker} {name!r}')

conn.commit()
conn.close()
print('\nDone.')
