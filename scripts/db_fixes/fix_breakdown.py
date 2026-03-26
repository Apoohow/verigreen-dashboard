import sqlite3, json, sys
sys.stdout.reconfigure(encoding='utf-8')

DB = r'C:\Users\hollm\OneDrive\桌面\AI專案\data\verigreen.db'

# 舊標籤 → 新標籤對應
REASON_MAP = {
    '可讀性與混淆視聽': '漂綠語言使用',
    '文本可讀性與混淆視聽': '漂綠語言使用',
    '語氣操弄': '漂綠語言使用',
    '表達性操弄與異常語氣': '漂綠語言使用',
    '缺乏實證': '第三方查證不足',
    '缺乏實證與不可靠聲稱': '第三方查證不足',
    # 舊英文標籤也一起處理
    'Readability': '漂綠語言使用',
    'Tone Management': '漂綠語言使用',
    'Unsubstantiated Claims': '第三方查證不足',
    'readability': '漂綠語言使用',
    'tone_management': '漂綠語言使用',
    'unsubstantiated': '第三方查證不足',
}

# 標準 5 個 reason（對應 DIM_LABEL 的中文）
STANDARD = ['軟硬性揭露落差', '選擇性揭露', '目標與現況落差', '第三方查證不足', '漂綠語言使用']

conn = sqlite3.connect(DB)
rows = conn.execute('SELECT analysis_id, breakdown, dimension_scores FROM analyses').fetchall()

fixed = 0
for aid, bd_raw, ds_raw in rows:
    if not bd_raw:
        continue
    try:
        bd = json.loads(bd_raw) if isinstance(bd_raw, str) else bd_raw
        ds = json.loads(ds_raw) if isinstance(ds_raw, str) else (ds_raw or {})
    except Exception:
        continue

    # 合併重複 reason（加總 score_contribution）
    merged: dict[str, dict] = {}
    for item in bd:
        reason = REASON_MAP.get(item.get('reason', ''), item.get('reason', ''))
        if reason not in merged:
            merged[reason] = {'reason': reason, 'weight': 0.20, 'score_contribution': 0}
        merged[reason]['score_contribution'] += int(item.get('score_contribution', 0))

    # 確保 5 個標準 reason 都存在（缺的補 0）
    dim_key_map = {
        '軟硬性揭露落差': 'soft_vs_hard',
        '選擇性揭露':     'selective_disclosure',
        '目標與現況落差': 'target_gap',
        '第三方查證不足': 'third_party',
        '漂綠語言使用':   'greenwashing_language',
    }
    new_bd = []
    for reason in STANDARD:
        if reason in merged:
            new_bd.append(merged[reason])
        else:
            dk = dim_key_map[reason]
            sc = int(ds.get(dk, 0) * 0.20) if ds else 0
            new_bd.append({'reason': reason, 'weight': 0.20, 'score_contribution': sc})

    conn.execute('UPDATE analyses SET breakdown=? WHERE analysis_id=?',
                 (json.dumps(new_bd, ensure_ascii=False), aid))
    print(f'Fixed {aid[:8]}: {[i["reason"] for i in new_bd]}')
    fixed += 1

conn.commit()
conn.close()
print(f'\nDone. Fixed {fixed} analyses.')
