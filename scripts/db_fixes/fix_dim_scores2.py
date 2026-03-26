import sqlite3, json, sys
sys.stdout.reconfigure(encoding='utf-8')

DB = r'C:\Users\hollm\OneDrive\桌面\AI專案\data\verigreen.db'

# 舊 key → 新 key（合併邏輯：若同一新 key 有多個舊 key，取最大值）
OLD_TO_NEW = {
    'readability':     'greenwashing_language',
    'tone_management': 'greenwashing_language',
    'unsubstantiated': 'third_party',
    # target_gap 舊版沒有對應 key，補充為 overall 的平均
}

conn = sqlite3.connect(DB)
rows = conn.execute('SELECT analysis_id, dimension_scores, overall_score FROM analyses').fetchall()

fixed = 0
for aid, ds_raw, overall in rows:
    if not ds_raw:
        continue
    try:
        ds = json.loads(ds_raw) if isinstance(ds_raw, str) else ds_raw
    except Exception:
        continue

    new_ds = {}
    # 先把現有 key 轉換
    for k, v in ds.items():
        nk = OLD_TO_NEW.get(k, k)
        new_ds[nk] = max(new_ds.get(nk, 0), int(v or 0))

    # target_gap 若還是 0 → 用 overall_score 當估計值（因為舊版沒有此維度）
    if not new_ds.get('target_gap'):
        new_ds['target_gap'] = int(overall or 0)

    # 確保 5 個標準 key 都在
    for dk in ['soft_vs_hard', 'selective_disclosure', 'target_gap', 'third_party', 'greenwashing_language']:
        if dk not in new_ds:
            new_ds[dk] = int(overall or 0)

    conn.execute('UPDATE analyses SET dimension_scores=? WHERE analysis_id=?',
                 (json.dumps(new_ds, ensure_ascii=False), aid))
    print(f'{aid[:8]}: {new_ds}')
    fixed += 1

conn.commit()
conn.close()
print(f'\nDone. Fixed {fixed} analyses.')
