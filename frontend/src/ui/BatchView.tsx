import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  fetchCompanies,
  fetchCompanyAnalysis,
  type CompanyListItem,
  type CompanyAnalysis,
} from './api'

const DIM_LABEL: Record<string, string> = {
  selective_disclosure: '選擇性揭露',
  readability:          '文本可讀性',
  greenwashing_language:'漂綠語言使用',
  target_gap:           '目標與現況落差',
}
const DIMS = Object.keys(DIM_LABEL)

const RISK_LABEL: Record<string, string> = { high: '高風險', moderate: '中風險', low: '低風險' }
const RISK_COLOR: Record<string, string> = {
  high: '#ef4444', moderate: '#f59e0b', low: '#22c55e',
}

function scoreColor(score: number | null | undefined): string {
  if (score == null) return '#6b7280'
  if (score >= 70) return '#ef4444'
  if (score > 30) return '#f59e0b'
  return '#22c55e'
}

function ScoreCell({ score }: { score?: number | null }) {
  const color = scoreColor(score)
  if (score == null) return <td style={tdStyle}>—</td>
  return (
    <td style={tdStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{
          width: `${Math.round(score)}%`, maxWidth: '100%',
          height: 6, background: color, borderRadius: 3, flexShrink: 0,
          minWidth: 4,
        }} />
        <span style={{ color, fontWeight: 700, fontSize: 13, minWidth: 28, textAlign: 'right' }}>
          {Math.round(score)}
        </span>
      </div>
    </td>
  )
}

const tdStyle: React.CSSProperties = {
  padding: '8px 12px', borderBottom: '1px solid #1e293b', whiteSpace: 'nowrap', verticalAlign: 'middle',
}
const thStyle: React.CSSProperties = {
  padding: '10px 12px', background: '#0f172a', color: '#94a3b8',
  fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1,
  borderBottom: '2px solid #1e293b',
}

function exportCsv(rows: CompanyAnalysis[]) {
  const header = ['公司', '代號', '年度', '總分', '風險等級', ...DIMS.map(d => DIM_LABEL[d])]
  const lines = rows.map(r => [
    r.name, r.ticker ?? '', r.year ?? '',
    r.overall_score ?? '',
    r.risk_level ? (RISK_LABEL[r.risk_level] ?? r.risk_level) : '',
    ...DIMS.map(d => r.dimension_scores?.[d] ?? ''),
  ])
  const csv = [header, ...lines].map(row =>
    row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
  ).join('\r\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `ESG批量分析_${new Date().toISOString().slice(0, 10)}.csv`
  a.click(); URL.revokeObjectURL(url)
}

interface Props {
  onClose: () => void
}

export default function BatchView({ onClose }: Props) {
  const [companies, setCompanies] = useState<CompanyListItem[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [results, setResults] = useState<Record<string, CompanyAnalysis>>({})
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [searchQ, setSearchQ] = useState('')
  const [filterIndustry, setFilterIndustry] = useState('')

  const reloadCompanies = useCallback(async () => {
    try {
      const r = await fetchCompanies()
      setCompanies(r.items)
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    void reloadCompanies()
    // 批量面板開啟期間定期同步，讓主面板刪除可即時反映
    const t = setInterval(() => { void reloadCompanies() }, 10000)
    return () => clearInterval(t)
  }, [reloadCompanies])

  // 公司若在主面板被刪除，這裡同步清掉選取與已載入結果
  useEffect(() => {
    const valid = new Set(companies.map(c => c.company_id))
    setSelected(prev => {
      const next = new Set([...prev].filter(id => valid.has(id)))
      return next
    })
    setResults(prev => {
      const next: Record<string, CompanyAnalysis> = {}
      Object.entries(prev).forEach(([id, row]) => {
        if (valid.has(id)) next[id] = row
      })
      return next
    })
  }, [companies])

  const displayCompanyName = useCallback((c: CompanyListItem) => {
    const name = (c.name ?? '').trim()
    const ticker = (c.ticker ?? '').trim()
    const nameIsCode = !!name && (/^\d{4,6}$/.test(name) || name === ticker)
    if (name && !nameIsCode) return name
    if (ticker) return `${ticker}（無公司名稱）`
    return '（無公司名稱）'
  }, [])

  // 從已載入公司清單取出不重複的產業
  const industries = useMemo(() => {
    const set = new Set(companies.map(c => c.industry).filter(Boolean) as string[])
    return [...set].sort()
  }, [companies])

  const toggle = useCallback(async (cid: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(cid)) { next.delete(cid); return next }
      next.add(cid); return next
    })
    if (!results[cid]) {
      setLoading(prev => new Set([...prev, cid]))
      try {
        const a = await fetchCompanyAnalysis(cid)
        setResults(prev => ({ ...prev, [cid]: a }))
      } finally {
        setLoading(prev => { const n = new Set(prev); n.delete(cid); return n })
      }
    }
  }, [results])

  const selectAll = useCallback(async () => {
    const visible = companies.filter(c =>
      (!searchQ || c.name.includes(searchQ) || (c.ticker ?? '').includes(searchQ)) &&
      (!filterIndustry || c.industry === filterIndustry)
    )
    setSelected(new Set(visible.map(c => c.company_id)))
    const toFetch = visible.filter(c => !results[c.company_id])
    await Promise.all(toFetch.map(async c => {
      setLoading(prev => new Set([...prev, c.company_id]))
      try {
        const a = await fetchCompanyAnalysis(c.company_id)
        setResults(prev => ({ ...prev, [c.company_id]: a }))
      } finally {
        setLoading(prev => { const n = new Set(prev); n.delete(c.company_id); return n })
      }
    }))
  }, [companies, results, searchQ])

  const clearAll = () => setSelected(new Set())

  const selectedRows = [...selected]
    .map(id => results[id])
    .filter(Boolean) as CompanyAnalysis[]

  const filtered = companies.filter(c =>
    (!searchQ || c.name.includes(searchQ) || (c.ticker ?? '').includes(searchQ)) &&
    (!filterIndustry || c.industry === filterIndustry)
  )

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: '#0f172a', display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '14px 20px', background: '#020617',
        borderBottom: '1px solid #1e293b', flexShrink: 0,
      }}>
        <button onClick={onClose} style={{
          background: 'none', border: '1px solid #334155', color: '#94a3b8',
          borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 14,
        }}>✕ 返回</button>
        <div style={{ color: '#f8fafc', fontWeight: 700, fontSize: 18 }}>
          批量比較分析
        </div>
        <div style={{ color: '#64748b', fontSize: 13 }}>
          已選 {selected.size} 家公司，{selectedRows.length} 筆有分析資料
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {selectedRows.length > 0 && (
            <button onClick={() => exportCsv(selectedRows)} style={{
              background: '#16a34a', color: '#fff', border: 'none',
              borderRadius: 8, padding: '7px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13,
            }}>
              ↓ 匯出 CSV
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Left: company picker */}
        <div style={{
          width: 240, flexShrink: 0, borderRight: '1px solid #1e293b',
          display: 'flex', flexDirection: 'column', background: '#020617',
        }}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid #1e293b' }}>
            <input
              placeholder="搜尋公司…"
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
              style={{
                width: '100%', background: '#1e293b', border: '1px solid #334155',
                color: '#f1f5f9', borderRadius: 6, padding: '6px 10px', fontSize: 13,
                boxSizing: 'border-box',
              }}
            />
            <select
              value={filterIndustry}
              onChange={e => setFilterIndustry(e.target.value)}
              style={{
                width: '100%', marginTop: 6,
                background: '#1e293b', border: '1px solid #334155',
                color: filterIndustry ? '#f1f5f9' : '#64748b',
                borderRadius: 6, padding: '6px 10px', fontSize: 12,
                boxSizing: 'border-box', cursor: 'pointer',
              }}
            >
              <option value="">全部產業</option>
              {industries.map(ind => (
                <option key={ind} value={ind}>{ind}</option>
              ))}
            </select>
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button onClick={selectAll} style={{
                flex: 1, background: '#1e40af', color: '#fff', border: 'none',
                borderRadius: 6, padding: '5px 0', cursor: 'pointer', fontSize: 12,
              }}>全選</button>
              <button onClick={clearAll} style={{
                flex: 1, background: '#334155', color: '#cbd5e1', border: 'none',
                borderRadius: 6, padding: '5px 0', cursor: 'pointer', fontSize: 12,
              }}>清除</button>
            </div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {filtered.map(c => {
              const isLoading = loading.has(c.company_id)
              const isSelected = selected.has(c.company_id)
              return (
                <div
                  key={c.company_id}
                  onClick={() => toggle(c.company_id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '9px 12px', cursor: 'pointer',
                    background: isSelected ? '#1e293b' : 'transparent',
                    borderBottom: '1px solid #0f172a',
                    transition: 'background 0.15s',
                  }}
                >
                  <div style={{
                    width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                    border: `2px solid ${isSelected ? '#3b82f6' : '#475569'}`,
                    background: isSelected ? '#3b82f6' : 'transparent',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {isSelected && <span style={{ color: '#fff', fontSize: 10, lineHeight: 1 }}>✓</span>}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{
                      color: '#f1f5f9', fontSize: 13, fontWeight: 500,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {displayCompanyName(c)}
                    </div>
                    <div style={{ color: '#64748b', fontSize: 11 }}>
                      {c.ticker ? `${c.ticker} · ` : ''}
                      {c.industry ?? ''}
                    </div>
                  </div>
                  {isLoading && (
                    <div style={{ marginLeft: 'auto', color: '#64748b', fontSize: 11 }}>載入…</div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Right: comparison table */}
        <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: 20 }}>
          {selectedRows.length === 0 ? (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', height: '100%', color: '#475569',
            }}>
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ marginBottom: 12, opacity: 0.5 }}>
                <rect x="3" y="12" width="4" height="9" rx="1.2" fill="#3b82f6"/>
                <rect x="10" y="7" width="4" height="14" rx="1.2" fill="#1aa39a"/>
                <rect x="17" y="3" width="4" height="18" rx="1.2" fill="#f59e0b"/>
                <line x1="2" y1="21.5" x2="22" y2="21.5" stroke="#475569" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              <div style={{ fontSize: 16, fontWeight: 600, color: '#64748b' }}>請從左側選擇要比較的公司</div>
              <div style={{ fontSize: 13, marginTop: 6 }}>可多選，支援匯出 CSV</div>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{
                borderCollapse: 'collapse', width: '100%',
                background: '#1e293b', borderRadius: 12, overflow: 'hidden',
                fontSize: 13, color: '#e2e8f0',
              }}>
                <thead>
                  <tr>
                    <th style={{ ...thStyle, minWidth: 150 }}>公司</th>
                    <th style={{ ...thStyle, minWidth: 50 }}>年度</th>
                    <th style={{ ...thStyle, minWidth: 100 }}>漂綠風險總分</th>
                    <th style={{ ...thStyle, minWidth: 80 }}>風險等級</th>
                    {DIMS.map(d => (
                      <th key={d} style={{ ...thStyle, minWidth: 120 }}>{DIM_LABEL[d]}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {selectedRows.map(r => (
                    <tr key={r.company_id} style={{ transition: 'background 0.1s' }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#273549')}
                      onMouseLeave={e => (e.currentTarget.style.background = '')}
                    >
                      <td style={{ ...tdStyle, fontWeight: 600, color: '#f8fafc' }}>
                        <div>{r.name}</div>
                        {r.ticker && <div style={{ color: '#64748b', fontSize: 11 }}>{r.ticker}</div>}
                      </td>
                      <td style={{ ...tdStyle, color: '#94a3b8' }}>{r.year ?? '—'}</td>
                      <ScoreCell score={r.overall_score} />
                      <td style={tdStyle}>
                        {r.risk_level ? (
                          <span style={{
                            background: RISK_COLOR[r.risk_level] + '22',
                            color: RISK_COLOR[r.risk_level],
                            border: `1px solid ${RISK_COLOR[r.risk_level]}55`,
                            borderRadius: 6, padding: '2px 8px', fontSize: 12, fontWeight: 600,
                          }}>
                            {RISK_LABEL[r.risk_level] ?? r.risk_level}
                          </span>
                        ) : '—'}
                      </td>
                      {DIMS.map(d => (
                        <ScoreCell key={d} score={r.dimension_scores?.[d]} />
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* 色碼說明 */}
              <div style={{ display: 'flex', gap: 16, marginTop: 14, color: '#64748b', fontSize: 12 }}>
                <span>分數說明：</span>
                {[['#22c55e', '1–30 低風險'], ['#f59e0b', '31–69 中風險'], ['#ef4444', '70–100 高風險']].map(([c, l]) => (
                  <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: c, display: 'inline-block' }} />
                    {l}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
