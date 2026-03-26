import sqlite3, sys
sys.stdout.reconfigure(encoding='utf-8')
conn = sqlite3.connect(r'C:\Users\hollm\OneDrive\桌面\AI專案\data\verigreen.db')
dims = conn.execute('SELECT DISTINCT dimension FROM evidence_items LIMIT 50').fetchall()
print('DB 中的 dimension 值：')
for d in dims:
    print(' ', repr(d[0]))
conn.close()
