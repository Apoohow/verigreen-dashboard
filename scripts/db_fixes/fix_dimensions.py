import sqlite3, sys
sys.stdout.reconfigure(encoding='utf-8')

DB = r'C:\Users\hollm\OneDrive\桌面\AI專案\data\verigreen.db'

NORMALIZE = {
    "soft_vs_hard": "soft_vs_hard",
    "selective_disclosure": "selective_disclosure",
    "target_gap": "target_gap",
    "third_party": "third_party",
    "greenwashing_language": "greenwashing_language",
    "readability": "greenwashing_language",
    "tone_management": "greenwashing_language",
    "unsubstantiated": "third_party",
    "vague_definitions": "greenwashing_language",
    "lack_of_proof": "third_party",
    "hidden_tradeoffs": "soft_vs_hard",
    "selective_reporting": "selective_disclosure",
    "irrelevant_claims": "greenwashing_language",
    "Soft vs. Hard Disclosure": "soft_vs_hard",
    "Selective Disclosure": "selective_disclosure",
    "Tone Management": "greenwashing_language",
    "Readability": "greenwashing_language",
    "Unsubstantiated Claims": "third_party",
}

def norm(raw: str) -> str:
    s = raw.strip()
    if s in NORMALIZE:
        return NORMALIZE[s]
    # 逗號分隔的複合值 → 取第一個可對應的
    for part in s.split(','):
        p = part.strip()
        if p in NORMALIZE:
            return NORMALIZE[p]
    return s  # 無法對應則保留

conn = sqlite3.connect(DB)
rows = conn.execute('SELECT evidence_id, dimension FROM evidence_items').fetchall()

fixed = 0
for eid, dim in rows:
    new_dim = norm(dim or '')
    if new_dim != dim:
        conn.execute('UPDATE evidence_items SET dimension=? WHERE evidence_id=?', (new_dim, eid))
        print(f'  {dim!r} -> {new_dim!r}')
        fixed += 1

conn.commit()
conn.close()
print(f'\nDone. Fixed {fixed} evidence items.')
