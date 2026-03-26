import { useEffect, useMemo, useRef, useState } from 'react'
import BatchView from './BatchView'
import {
  chat,
  deleteCompany,
  deleteReport,
  type ChatHistoryItem,
  fetchAnalysis,
  fetchCompanies,
  fetchCompanyReports,
  fetchEvidence,
  fetchMe,
  fetchPage,
  fetchReportStatus,
  fetchSourceFilters,
  fetchSources,
  fetchTejScores,
  logout,
  startGoogleLogin,
  importSource,
  crawlAndImport,
  updateCompanyUrl,
  uploadReport,
  type AnalysisResponse,
  type CompanyListItem,
  type CompanyReport,
  type EvidenceItem,
  type SourceItem,
  type TejScore,
  type AuthMe,
} from './api'
import styles from './app.module.css'

type ChatMsg = { role: 'user' | 'assistant'; content: string }
const TUTORIAL_HIDE_KEY = 'verigreen_tutorial_hide'
type TutorialTarget = 'upload' | 'upload_tabs' | 'company' | 'risk' | 'evidence' | 'chat'
type TutorialStep = {
  title: string
  text: string
  target: TutorialTarget
  mainStep: number
  subStepLabel?: string
}

const DIM_LABEL: Record<string, string> = {
  selective_disclosure:  '選擇性揭露',
  readability:           '文本可讀性',
  greenwashing_language: '漂綠語言使用',
  target_gap:            '目標與現況落差',
}

function riskChip(risk?: string | null) {
  if (!risk) return { label: '—', color: 'var(--muted)' }
  if (risk === 'high') return { label: 'High', color: 'var(--danger)' }
  if (risk === 'moderate') return { label: 'Moderate', color: 'var(--warn)' }
  if (risk === 'low') return { label: 'Low', color: 'var(--ok)' }
  return { label: risk, color: 'var(--muted)' }
}

/**
 * TEJ ERS（Event Radar Score）0～-100 官方風險區間：
 * - 分數＞-25：低度風險
 * - -25≧分數＞-50：中度風險
 * - -50≧分數≧-100：高度風險
 */
function ersRiskBand(score: number): 'low' | 'medium' | 'high' {
  if (score > -25) return 'low'
  if (score > -50) return 'medium'
  return 'high'
}

function ersTotalStyle(score: number | null | undefined): {
  band: 'low' | 'medium' | 'high'
  hint: string
  color: string
  borderColor: string
  bg: string
} {
  if (score == null || Number.isNaN(score)) {
    return {
      band: 'low',
      hint: '',
      color: '#64748b',
      borderColor: '#e2e8f0',
      bg: '#f8fafc',
    }
  }
  const band = ersRiskBand(score)
  if (band === 'low') {
    return {
      band,
      hint: '低度風險：建議無需特別留意',
      color: '#15803d',
      borderColor: '#86efac',
      bg: '#f0fdf4',
    }
  }
  if (band === 'medium') {
    return {
      band,
      hint: '中度風險：建議持續監控該投融資標的',
      color: '#c2410c',
      borderColor: '#fdba74',
      bg: '#fff7ed',
    }
  }
  return {
    band,
    hint: '高度風險：建議主動聯繫或警示並持續監控',
    color: '#b91c1c',
    borderColor: '#fca5a5',
    bg: '#fef2f2',
  }
}

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n))
}

function getCompanyCodeAndName(item: { ticker?: string | null; name?: string | null }) {
  const rawName = (item.name ?? '').trim()
  const rawTicker = (item.ticker ?? '').trim()
  const nameIsCode = !!rawName && /^\d{4,6}$/.test(rawName)

  const code = rawTicker || (nameIsCode ? rawName : '')
  const name = !nameIsCode && rawName ? rawName : '（無公司名稱）'
  return { code, name }
}

function Radar({
  scores, activeDim, onSelect, isEmpty,
}: {
  scores: Record<string, number>
  activeDim: string | null
  onSelect: (dim: string) => void
  isEmpty: boolean
}) {
  const dims = Object.keys(DIM_LABEL)
  const cx = 148, cy = 118
  const outerR = 68
  const labelR = 95

  const angle = (i: number) => (-Math.PI / 2) + (i * 2 * Math.PI) / dims.length

  const ring = (r: number) =>
    dims.map((_, i) => {
      const a = angle(i)
      return `${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`
    }).join(' ')

  const pts = dims.map((k, i) => {
    const v = clamp01((scores[k] ?? 0) / 100)
    const a = angle(i)
    return `${(cx + Math.cos(a) * outerR * v).toFixed(1)},${(cy + Math.sin(a) * outerR * v).toFixed(1)}`
  })

  return (
    <svg width="100%" viewBox="-20 0 350 255" aria-label="radar" style={{ display: 'block', margin: '0 auto' }}>
      {/* 同心多邊形背景 */}
      {[1, 0.75, 0.5, 0.25].map((f, fi) => (
        <polygon key={fi} points={ring(outerR * f)} fill="none"
          stroke={['#dbe3ee','#e7edf6','#eef3fb','#f4f7fd'][fi]} strokeWidth="1" />
      ))}
      {/* 軸線 */}
      {dims.map((_, i) => {
        const a = angle(i)
        return <line key={i} x1={cx} y1={cy}
          x2={(cx + Math.cos(a) * outerR).toFixed(1)}
          y2={(cy + Math.sin(a) * outerR).toFixed(1)}
          stroke="#e7edf6" strokeWidth="1" />
      })}
      {/* 資料多邊形 */}
      <polygon points={pts.join(' ')} fill="rgba(245,158,11,0.22)" stroke="#f59e0b" strokeWidth="1.8" />
      {/* 頂點圓點 */}
      {dims.map((k, i) => {
        const v = clamp01((scores[k] ?? 0) / 100)
        const a = angle(i)
        return <circle key={k}
          cx={(cx + Math.cos(a) * outerR * v).toFixed(1)}
          cy={(cy + Math.sin(a) * outerR * v).toFixed(1)}
          r="2.5" fill="#f59e0b" />
      })}
      {/* 可點擊的維度標籤 + 分數 */}
      {dims.map((k, i) => {
        const a = angle(i)
        const lx = cx + Math.cos(a) * labelR
        const ly = cy + Math.sin(a) * labelR
        const score = scores[k] ?? 0
        const label = DIM_LABEL[k] ?? k
        const anchor = lx < cx - 8 ? 'end' : lx > cx + 8 ? 'start' : 'middle'
        const mid = Math.ceil(label.length / 2)
        const lines = label.length > 6 ? [label.slice(0, mid), label.slice(mid)] : [label]
        const lineH = 13
        const isActive = activeDim === k
        const labelColor = isActive ? '#1aa39a' : '#334155'
        const scoreColor = isActive ? '#1aa39a' : '#f59e0b'
        return (
          <g key={k}
            onClick={() => !isEmpty && onSelect(k)}
            style={{ cursor: isEmpty ? 'default' : 'pointer' }}
          >
            {/* 點擊熱區 */}
            <rect
              x={(lx - 34).toFixed(1)} y={(ly - 18).toFixed(1)}
              width="68" height={lines.length * lineH + 18}
              fill="transparent"
            />
            {lines.map((line, li) => (
              <text key={li}
                x={lx.toFixed(1)}
                y={(ly + li * lineH - (lines.length - 1) * lineH / 2).toFixed(1)}
                textAnchor={anchor} fontSize="11" fill={labelColor}
                fontWeight={isActive ? '700' : '400'}
                fontFamily="system-ui,sans-serif">
                {line}
              </text>
            ))}
            <text
              x={lx.toFixed(1)}
              y={(ly + lines.length * lineH - (lines.length - 1) * lineH / 2).toFixed(1)}
              textAnchor={anchor} fontSize="12" fontWeight="700" fill={scoreColor}
              fontFamily="system-ui,sans-serif">
              {score}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

// ── URL 編輯子元件（獨立 state，不受外層 re-render 影響）────────────────
function UrlEditor({
  companyId, initialUrl, styles, onSave, onCancel,
}: {
  companyId: string
  initialUrl: string
  styles: Record<string, string>
  onSave: (companyId: string, url: string) => Promise<void>
  onCancel: () => void
}) {
  const [val, setVal] = useState(initialUrl)
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      await onSave(companyId, val.trim())
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className={styles.urlEditBlock}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <input
        className={styles.input}
        placeholder="貼上自訂連結網址（如公司專屬 ESG 頁面）…"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onPaste={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') void handleSave()
          if (e.key === 'Escape') onCancel()
        }}
        autoFocus
      />
      <div className={styles.urlEditBtns}>
        <button
          className={styles.btnPrimary}
          onClick={() => void handleSave()}
          disabled={saving}
        >
          {saving ? '儲存中…' : '儲存'}
        </button>
        <button className={styles.btn} onClick={onCancel}>取消</button>
      </div>
    </div>
  )
}

export default function App() {
  const [currentPage, setCurrentPage] = useState<'home' | 'dashboard'>('home')
  const [authLoading, setAuthLoading] = useState(true)
  const [currentUser, setCurrentUser] = useState<AuthMe | null>(null)
  const [showSourcePicker, setShowSourcePicker] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [showBatch, setShowBatch] = useState(false)
  const [showTutorial, setShowTutorial] = useState(false)
  const [tutorialStep, setTutorialStep] = useState(0)
  const [hideTutorialNextTime, setHideTutorialNextTime] = useState(false)
  const [tourRect, setTourRect] = useState<DOMRect | null>(null)
  const [companies, setCompanies] = useState<CompanyListItem[]>([])
  const [allCompanies, setAllCompanies] = useState<CompanyListItem[]>([])
  const [query, setQuery] = useState('')
  const [filterIndustry, setFilterIndustry] = useState('')
  const [loadingCompanies, setLoadingCompanies] = useState(false)

  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null)
  const [companyReports, setCompanyReports] = useState<CompanyReport[]>([])
  const [loadingReports, setLoadingReports] = useState(false)
  const [editingUrlId, setEditingUrlId] = useState<string | null>(null)

  // TEJ ERS 分數
  const [tejScores, setTejScores] = useState<Record<string, TejScore>>({})
  const [tejFilename, setTejFilename] = useState<string>('')

  const [reportId, setReportId] = useState<string | null>(null)
  const [reportStatus, setReportStatus] = useState<string>('尚未上傳')
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null)
  const [evidence, setEvidence] = useState<EvidenceItem[]>([])
  const [activeDim, setActiveDim] = useState<string | null>(null)

  const [pageModal, setPageModal] = useState<{ page: number; text: string } | null>(null)

  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [elapsedSec, setElapsedSec] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const uploadTabsRef = useRef<HTMLDivElement | null>(null)
  const companyPanelRef = useRef<HTMLDivElement | null>(null)
  const uploadPanelRef = useRef<HTMLDivElement | null>(null)
  const riskPanelRef = useRef<HTMLDivElement | null>(null)
  const evidencePanelRef = useRef<HTMLDivElement | null>(null)
  const chatFabRef = useRef<HTMLButtonElement | null>(null)

  // ── 資料庫分頁 state ──────────────────────────────────────────────
  const [uploadTab, setUploadTab] = useState<'upload' | 'db' | 'agent'>('upload')
  const [dbQuery, setDbQuery] = useState('')
  const [dbSector, setDbSector] = useState('')
  const [dbYear, setDbYear] = useState('')
  const [dbLang, setDbLang] = useState('')
  const [dbResults, setDbResults] = useState<SourceItem[]>([])
  const [dbLoading, setDbLoading] = useState(false)
  const [dbSectors, setDbSectors] = useState<string[]>([])
  const [dbYears, setDbYears] = useState<string[]>([])
  const [importingId, setImportingId] = useState<string | null>(null)
  const [dbSelected, setDbSelected] = useState<SourceItem | null>(null)
  const [agentQuery, setAgentQuery] = useState('')
  const [agentYear, setAgentYear] = useState(String(new Date().getFullYear()))
  const [agentType, setAgentType] = useState<'esg' | 'csr' | 'both'>('both')
  const [agentLoading, setAgentLoading] = useState(false)

  useEffect(() => {
    fetchSourceFilters().then(d => { setDbSectors(d.sectors); setDbYears(d.years) }).catch(() => {})
  }, [])

  async function onDbSearch() {
    setDbLoading(true)
    try {
      const res = await fetchSources({ q: dbQuery, sector: dbSector, year: dbYear, lang: dbLang })
      setDbResults(res.items)
    } catch { /* ignore */ }
    finally { setDbLoading(false) }
  }

  async function onImport(item: SourceItem) {
    if (!item.is_local && !item.is_pdf) {
      alert('此筆資料非直接 PDF 連結（可能是網頁），請手動下載後上傳。')
      return
    }
    setImportingId(item.source_id)
    setDbSelected(null)
    setUploading(true)
    setElapsedSec(0)
    setUploadTab('upload')
    timerRef.current = setInterval(() => setElapsedSec((s) => s + 1), 1000)
    try {
      const res = await importSource(item)
      setReportId(res.report_id)
      setAnalysis(null)
      setEvidence([])
      await pollUntilAnalyzed(res.report_id)
      await reloadCompanies()
    } catch (e: unknown) {
      alert((e as Error).message)
    } finally {
      if (timerRef.current) clearInterval(timerRef.current)
      setUploading(false)
      setImportingId(null)
    }
  }

  async function onAgentDownloadImport() {
    const q = agentQuery.trim()
    if (!q) {
      alert('請輸入公司代號或名稱')
      return
    }
    setAgentLoading(true)
    setUploading(true)
    setElapsedSec(0)
    timerRef.current = setInterval(() => setElapsedSec((s) => s + 1), 1000)
    try {
      const y = Number(agentYear)
      const res = await crawlAndImport({
        query: q,
        year: Number.isFinite(y) && y > 1900 ? y : undefined,
        report_type: agentType,
      })
      setReportId(res.report_id)
      setAnalysis(null)
      setEvidence([])
      await pollUntilAnalyzed(res.report_id)
      await loadCompanies()
    } catch (e: unknown) {
      alert((e as Error).message)
    } finally {
      if (timerRef.current) clearInterval(timerRef.current)
      setUploading(false)
      setAgentLoading(false)
    }
  }

  const [chatOpen, setChatOpen] = useState(false)
  const [chatMsgs, setChatMsgs] = useState<ChatMsg[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatTyping, setChatTyping] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const chatEndRef = useRef<HTMLDivElement | null>(null)
  const chatInputRef = useRef<HTMLInputElement | null>(null)
  const chatPanelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMsgs])

  useEffect(() => {
    if (chatOpen) setTimeout(() => chatInputRef.current?.focus(), 50)
  }, [chatOpen])

  useEffect(() => {
    let alive = true
    void fetchMe()
      .then((u) => { if (alive) setCurrentUser(u) })
      .catch(() => { if (alive) setCurrentUser(null) })
      .finally(() => { if (alive) setAuthLoading(false) })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (currentPage !== 'dashboard' || showSourcePicker) return
    try {
      const hidden = localStorage.getItem(TUTORIAL_HIDE_KEY) === '1'
      if (!hidden) {
        setTutorialStep(0)
        setHideTutorialNextTime(false)
        setShowTutorial(true)
      }
    } catch {
      setTutorialStep(0)
      setHideTutorialNextTime(false)
      setShowTutorial(true)
    }
  }, [currentPage, showSourcePicker])

  async function loadCompanies() {
    setLoadingCompanies(true)
    try {
      const res = await fetchCompanies(query.trim() || undefined)
      setCompanies(res.items)
      if (!query.trim()) setAllCompanies(res.items)
      // 同步拉取 TEJ 分數（ticker 優先，若無則用 name 作為備用代碼）
      const codes = res.items.map(c => {
        const code = c.ticker || (/^\d{4,6}$/.test(c.name ?? '') ? c.name : null)
        return code ?? null
      }).filter(Boolean) as string[]
      if (codes.length) {
        try {
          const tej = await fetchTejScores(codes)
          setTejFilename(tej.filename)
          const map: Record<string, TejScore> = {}
          for (const s of tej.items) map[s.code] = s
          setTejScores(map)
        } catch { /* TEJ 分數非必要，忽略錯誤 */ }
      }
    } finally {
      setLoadingCompanies(false)
    }
  }

  async function reloadCompanies() {
    const res = await fetchCompanies(query.trim() || undefined)
    setCompanies(res.items)
    if (!query.trim()) setAllCompanies(res.items)
  }

  async function selectCompany(companyId: string) {
    if (selectedCompanyId === companyId) {
      setSelectedCompanyId(null)
      setCompanyReports([])
      return
    }
    setSelectedCompanyId(companyId)
    setLoadingReports(true)
    try {
      const res = await fetchCompanyReports(companyId)
      setCompanyReports(res.items)
    } finally {
      setLoadingReports(false)
    }
  }

  async function loadReport(id: string) {
    setReportId(id)
    setReportStatus('載入中…')
    setAnalysis(null)
    setEvidence([])
    setActiveDim(null)
    for (let j = 0; j < 5; j++) {
      try {
        const a = await fetchAnalysis(id)
        setAnalysis(a)
        const ev = await fetchEvidence(id)
        setEvidence(ev.items)
        setReportStatus('analyzed')
        return
      } catch {
        await new Promise((r) => setTimeout(r, 800))
      }
    }
    setReportStatus('analysis not ready')
  }

  useEffect(() => {
    if (currentPage !== 'dashboard' || !currentUser) return
    void loadCompanies()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, currentUser])

  useEffect(() => {
    if (authLoading) return
    if (!currentUser && currentPage === 'dashboard') {
      setCurrentPage('home')
    }
  }, [authLoading, currentUser, currentPage])

  async function pollUntilAnalyzed(id: string) {
    setReportStatus('處理中…')
    setAnalysis(null)
    setEvidence([])
    setActiveDim(null)

    // 最長輪詢約 2 分鐘，避免大型 PDF 尚未處理完就停止
    for (let i = 0; i < 120; i++) {
      const st = await fetchReportStatus(id)
      setReportStatus(st.status)
      if (st.status === 'analyzed') break
      await new Promise((r) => setTimeout(r, 1000))
    }
    // 盡量多試幾次取分析結果，避免剛好還在寫入 DB
    for (let j = 0; j < 5; j++) {
      try {
        const a = await fetchAnalysis(id)
        setAnalysis(a)
        const ev = await fetchEvidence(id)
        setEvidence(ev.items)
        return
      } catch {
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
  }

  const overall = analysis?.overall_score ?? null
  const risk = analysis?.risk_level ?? null
  const riskInfo = riskChip(risk)

  const viewOverall = overall
  const viewRiskInfo = riskInfo

  // 骨架資料：未上傳時用來撐版面，讓每個面板都有完整 UI 結構
  const SKELETON_ANALYSIS: AnalysisResponse = {
    overall_score: 0,
    risk_level: 'low',
    breakdown: [
      { reason: '選擇性揭露',       weight: 0.25, score_contribution: 0 },
      { reason: '文本可讀性',       weight: 0.25, score_contribution: 0 },
      { reason: '漂綠語言使用',     weight: 0.25, score_contribution: 0 },
      { reason: '目標與現況落差',   weight: 0.25, score_contribution: 0 },
    ],
    key_metrics: [
      { metric: '2030 減碳目標', target: '—', actual: '上傳 ESG PDF 後自動抽取', gap: '—', status: '—' },
      { metric: '再生能源占比', target: '—', actual: '上傳 ESG PDF 後自動抽取', gap: '—', status: '—' },
      { metric: '用水效率',    target: '—', actual: '上傳 ESG PDF 後自動抽取', gap: '—', status: '—' },
    ],
    dimension_scores: {
      selective_disclosure:  0,
      readability:           0,
      greenwashing_language: 0,
      target_gap:            0,
    },
  }
  const displayAnalysis = analysis ?? SKELETON_ANALYSIS
  const isEmpty = !analysis
  const overallSummary = useMemo(() => {
    if (isEmpty) return '尚未分析，請先上傳 ESG 報告。'
    const ranked = [...(displayAnalysis.breakdown ?? [])].sort((a, b) => b.score_contribution - a.score_contribution)
    const topTwo = ranked.slice(0, 2).map((x) => x.reason).join('、')
    return topTwo ? `本次總體摘要：主要風險集中於${topTwo}。` : '本次總體摘要：暫無可用分析。'
  }, [displayAnalysis, isEmpty])

  // 產業選單（從全量公司清單動態產生）
  const industries = useMemo(() => {
    const set = new Set(allCompanies.map(c => c.industry).filter(Boolean) as string[])
    return [...set].sort()
  }, [allCompanies])

  // 依產業過濾後的公司清單
  const filteredCompanies = useMemo(() =>
    filterIndustry ? companies.filter(c => c.industry === filterIndustry) : companies
  , [companies, filterIndustry])

  // 目前選中公司的 TEJ 分數
  const selectedTejScore = useMemo(() => {
    if (!selectedCompanyId) return null
    const co = companies.find(c => c.company_id === selectedCompanyId)
    if (!co) return null
    const code = co.ticker || (/^\d{4,6}$/.test(co.name ?? '') ? co.name : null)
    if (!code) return null
    return tejScores[code.padStart(4, '0')] ?? null
  }, [selectedCompanyId, companies, tejScores])

  const selectedCompanyMeta = useMemo(() => {
    if (!selectedCompanyId) return null
    const c = companies.find((x) => x.company_id === selectedCompanyId)
    if (!c) return null
    const ticker = c.ticker?.trim()
    const name = (c.name || '').trim()
    const nameIsCode = name && (/^\d{4,6}$/.test(name) || name === ticker)
    const showName = name && !nameIsCode
    if (ticker && showName) return `${ticker} · ${name}`
    if (showName) return name
    if (ticker) return ticker
    return name || null
  }, [selectedCompanyId, companies])

  async function onUpload() {
    if (!selectedFile) return
    setUploading(true)
    setElapsedSec(0)
    timerRef.current = setInterval(() => setElapsedSec((s) => s + 1), 1000)
    try {
      const file = selectedFile
      const name = file.name.replace(/\.[^.]+$/, '')
      const parts = name.split('_')
      let companyName = (parts[0] || '').trim()
      let year: number | undefined
      if (parts.length >= 2) {
        const maybeYear = Number(parts[1])
        if (Number.isFinite(maybeYear)) year = maybeYear
      }
      if (!companyName) companyName = 'Unknown Company'

      const fd = new FormData()
      fd.append('file', file)
      fd.append('company_name', companyName)
      if (year !== undefined) fd.append('year', String(year))

      const res = await uploadReport(fd)
      setReportId(res.report_id)
      setSelectedFile(null)
      await pollUntilAnalyzed(res.report_id)
      await loadCompanies()
    } finally {
      if (timerRef.current) clearInterval(timerRef.current)
      setUploading(false)
    }
  }

  async function onDeleteCompany(companyId: string, companyName: string, e: React.MouseEvent) {
    e.stopPropagation()
    if (!confirm(`確定要刪除「${companyName}」及其所有報告？此操作無法復原。`)) return
    await deleteCompany(companyId)
    if (selectedCompanyId === companyId) {
      setSelectedCompanyId(null)
      setCompanyReports([])
    }
    // 若目前載入的報告屬於這家公司，清空
    setReportId((prev) => {
      if (prev) {
        setAnalysis(null)
        setEvidence([])
        setReportStatus('尚未上傳')
      }
      return null
    })
    await loadCompanies()
  }

  async function saveCompanyUrl(companyId: string, url: string) {
    try {
      await updateCompanyUrl(companyId, url)
      setEditingUrlId(null)
      await loadCompanies()
    } catch (e: unknown) {
      alert('儲存失敗：' + (e as Error).message)
    }
  }

  async function onDeleteReport(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    if (!confirm('確定要刪除這份報告？此操作無法復原。')) return
    await deleteReport(id)
    if (reportId === id) {
      setReportId(null)
      setAnalysis(null)
      setEvidence([])
      setReportStatus('尚未上傳')
    }
    if (selectedCompanyId) {
      const res = await fetchCompanyReports(selectedCompanyId)
      setCompanyReports(res.items)
    }
    await loadCompanies()
  }

  async function openPage(page: number) {
    if (!reportId) return
    const p = await fetchPage(reportId, page)
    setPageModal({ page: p.page_number, text: p.text })
  }

  async function sendChat(msg?: string) {
    const text = (msg ?? chatInput).trim()
    if (!text || chatTyping) return
    setChatInput('')

    // 先把使用者訊息加入，並記下傳出前的歷史（不含這條）
    let historySnapshot: ChatHistoryItem[] = []
    setChatMsgs((prev) => {
      historySnapshot = prev.map((m) => ({ role: m.role, content: m.content }))
      return [...prev, { role: 'user', content: text }]
    })

    if (!reportId) {
      setChatMsgs((m) => [
        ...m,
        { role: 'assistant', content: '目前尚未上傳報告。請先上傳 ESG PDF，我才能根據內容附上引用頁碼。' },
      ])
      return
    }

    setChatTyping(true)
    try {
      const res = await chat(reportId, text, sessionId, historySnapshot)
      setSessionId(res.session_id)
      const cites = res.citations?.filter((c) => c.page_number > 0) ?? []
      const citeLine = cites.length > 0
        ? `\n\n引用頁碼：${cites.map((c) => `p.${c.page_number}`).join('、')}`
        : ''
      setChatMsgs((m) => [...m, { role: 'assistant', content: res.answer + citeLine }])
    } catch {
      setChatMsgs((m) => [...m, { role: 'assistant', content: '⚠ 無法取得回覆，請稍後再試。' }])
    } finally {
      setChatTyping(false)
    }
  }

  async function onSelectDim(dim: string) {
    const next = activeDim === dim ? null : dim
    setActiveDim(next)
    if (!reportId) return
    const ev = await fetchEvidence(reportId, next ?? undefined)
    setEvidence(ev.items)
  }

  function chooseSource(tab: 'upload' | 'db') {
    setUploadTab(tab)
    setShowSourcePicker(false)
    setMenuOpen(false)
    if (tab === 'upload') {
      // 讓「PDF 上傳」按鈕真的直接進入檔案選擇流程
      setTimeout(() => fileInputRef.current?.click(), 80)
    } else {
      void onDbSearch()
    }
  }

  function goTo(page: 'home' | 'dashboard') {
    if (page === 'dashboard' && !currentUser) {
      startGoogleLogin()
      return
    }
    setCurrentPage(page)
    setMenuOpen(false)
  }

  function onLogout() {
    void logout()
      .catch(() => {})
      .finally(() => {
        setCurrentUser(null)
        setCurrentPage('home')
      })
  }

  function openTutorial() {
    setShowSourcePicker(false)
    setTutorialStep(0)
    setHideTutorialNextTime(false)
    setShowTutorial(true)
    setMenuOpen(false)
  }

  function closeTutorial() {
    if (hideTutorialNextTime) {
      try {
        localStorage.setItem(TUTORIAL_HIDE_KEY, '1')
      } catch { /* ignore */ }
    }
    setShowTutorial(false)
  }

  function getTargetEl(target: TutorialTarget): HTMLElement | null {
    if (target === 'upload') return uploadPanelRef.current
    if (target === 'upload_tabs') return uploadTabsRef.current
    if (target === 'company') return companyPanelRef.current
    if (target === 'risk') return riskPanelRef.current
    if (target === 'evidence') return evidencePanelRef.current
    return chatPanelRef.current || chatFabRef.current
  }

  function isTourTarget(target: TutorialTarget): boolean {
    if (!showTutorial || currentPage !== 'dashboard') return false
    return tutorialSteps[tutorialStep]?.target === target
  }

  const sideMenu = (activePage: 'home' | 'dashboard') => (
    <>
      {menuOpen && <div className={styles.menuBackdrop} onClick={() => setMenuOpen(false)} />}
      <aside className={`${styles.sideMenu} ${menuOpen ? styles.sideMenuOpen : ''}`}>
        <div className={styles.sideMenuHead}>頁面</div>
        <button
          className={`${styles.sideMenuBtn} ${activePage === 'home' ? styles.sideMenuBtnActive : ''}`}
          onClick={() => goTo('home')}
        >
          首頁 Home
        </button>
        <button
          className={`${styles.sideMenuBtn} ${activePage === 'dashboard' ? styles.sideMenuBtnActive : ''}`}
          onClick={() => goTo('dashboard')}
        >
          儀表板 Dashboard
        </button>
        {activePage === 'dashboard' && (
          <button
            className={styles.sideMenuBtn}
            onClick={() => { setShowBatch(true); setMenuOpen(false) }}
          >
            批量比較分析
          </button>
        )}
        {activePage === 'dashboard' && (
          <button className={styles.sideMenuBtn} onClick={openTutorial}>
            使用教學
          </button>
        )}
      </aside>
    </>
  )

  const tutorialSteps: TutorialStep[] = [
    {
      title: 'Step 1：選擇資料來源',
      text: '先在這裡切換「上傳 PDF / 資料庫選擇 / 自動抓報告」，決定本次分析資料來源。',
      target: 'upload_tabs',
      mainStep: 1,
    },
    {
      title: 'Step 2.1：上傳 PDF',
      text: '點選「上傳 PDF」可手動選擇本機檔案，適合你已經有報告檔案的情境。',
      target: 'upload_tabs',
      mainStep: 2,
      subStepLabel: '2.1',
    },
    {
      title: 'Step 2.2：資料庫選擇',
      text: '點選「資料庫選擇」可從內建資料來源快速匯入，省去手動找檔時間。',
      target: 'upload_tabs',
      mainStep: 2,
      subStepLabel: '2.2',
    },
    {
      title: 'Step 2.3：自動抓報告',
      text: '點選「自動抓報告」後輸入公司名稱或代號，系統會自動下載並分析。',
      target: 'upload_tabs',
      mainStep: 2,
      subStepLabel: '2.3',
    },
    {
      title: 'Step 3：選公司與報告',
      text: '在左側公司清單選取公司與年份，系統會載入該報告的最新分析結果。',
      target: 'company',
      mainStep: 3,
    },
    {
      title: 'Step 4：看總分與風險',
      text: '中間圓環會顯示漂綠風險總分與等級，先快速掌握整體風險高低。',
      target: 'risk',
      mainStep: 4,
    },
    {
      title: 'Step 5：檢視漂綠證據',
      text: '右側會列出證據段落與頁碼，可直接點擊頁碼查看原文脈絡。',
      target: 'evidence',
      mainStep: 5,
    },
    {
      title: 'Step 6：使用 AI 問答',
      text: '請點右下角圓形機器人按鈕開啟 AI Chatbot，再追問特定指標、頁碼或風險解讀。',
      target: 'chat',
      mainStep: 6,
    },
  ]

  useEffect(() => {
    if (!showTutorial || currentPage !== 'dashboard') {
      setTourRect(null)
      return
    }
    const updateRect = () => {
      const el = getTargetEl(tutorialSteps[tutorialStep].target)
      setTourRect(el ? el.getBoundingClientRect() : null)
    }
    const id = window.requestAnimationFrame(updateRect)
    window.addEventListener('resize', updateRect)
    return () => {
      window.cancelAnimationFrame(id)
      window.removeEventListener('resize', updateRect)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTutorial, tutorialStep, currentPage])

  useEffect(() => {
    if (!showTutorial || currentPage !== 'dashboard') return
    // Step 2.x 自動切換三個資料來源按鈕
    if (tutorialStep === 1) setUploadTab('upload')
    if (tutorialStep === 2) setUploadTab('db')
    if (tutorialStep === 3) setUploadTab('agent')
    // Step 6 自動打開對話框，讓使用者知道要操作哪裡
    if (tutorialSteps[tutorialStep]?.target === 'chat') setChatOpen(true)
  }, [showTutorial, tutorialStep, currentPage])

  const tutorialCardStyle = useMemo(() => {
    if (!tourRect || typeof window === 'undefined') {
      return { top: '16px', left: '16px' }
    }
    const vw = window.innerWidth
    const vh = window.innerHeight
    const pad = 16
    const gap = 14
    const cardW = Math.min(380, Math.max(280, vw - pad * 2))
    const cardH = 250 // 近似高度，用於避讓判斷
    const clampX = (x: number) => Math.max(pad, Math.min(vw - cardW - pad, x))
    const clampY = (y: number) => Math.max(pad, Math.min(vh - cardH - pad, y))
    const stepDef = tutorialSteps[tutorialStep]

    // Step 2.x：貼近三個資料來源按鈕，且盡量不遮住操作區
    if (stepDef?.target === 'upload_tabs' && stepDef?.subStepLabel) {
      const canRight = tourRect.right + gap + cardW <= vw - pad
      if (canRight) {
        return {
          top: `${clampY(tourRect.top - 8)}px`,
          left: `${clampX(tourRect.right + gap)}px`,
        }
      }
      return {
        top: `${clampY(tourRect.bottom + 8)}px`,
        left: `${clampX(tourRect.left + tourRect.width / 2 - cardW / 2)}px`,
      }
    }
    if (stepDef?.target === 'chat') {
      // 第六步：chat 視窗保持原位，教學卡固定放在 chat 左側
      return {
        top: `${clampY(tourRect.top + tourRect.height / 2 - cardH / 2)}px`,
        left: `${clampX(tourRect.left - cardW - 14)}px`,
      }
    }

    const candidates = [
      { left: clampX(tourRect.left + tourRect.width / 2 - cardW / 2), top: clampY(tourRect.bottom + gap) }, // 下
      { left: clampX(tourRect.left + tourRect.width / 2 - cardW / 2), top: clampY(tourRect.top - cardH - gap) }, // 上
      { left: clampX(tourRect.right + gap), top: clampY(tourRect.top + tourRect.height / 2 - cardH / 2) }, // 右
      { left: clampX(tourRect.left - cardW - gap), top: clampY(tourRect.top + tourRect.height / 2 - cardH / 2) }, // 左
    ]

    const target = {
      left: tourRect.left - 6,
      top: tourRect.top - 6,
      right: tourRect.right + 6,
      bottom: tourRect.bottom + 6,
    }
    const overlapArea = (c: { left: number; top: number }) => {
      const right = c.left + cardW
      const bottom = c.top + cardH
      const ow = Math.max(0, Math.min(right, target.right) - Math.max(c.left, target.left))
      const oh = Math.max(0, Math.min(bottom, target.bottom) - Math.max(c.top, target.top))
      return ow * oh
    }
    const distanceToTarget = (c: { left: number; top: number }) => {
      const cx = c.left + cardW / 2
      const cy = c.top + cardH / 2
      const tx = tourRect.left + tourRect.width / 2
      const ty = tourRect.top + tourRect.height / 2
      return Math.hypot(cx - tx, cy - ty)
    }

    const best = [...candidates].sort((a, b) => {
      const oa = overlapArea(a)
      const ob = overlapArea(b)
      if (oa !== ob) return oa - ob
      return distanceToTarget(a) - distanceToTarget(b)
    })[0]

    return { top: `${best.top}px`, left: `${best.left}px` }
  }, [tourRect, tutorialStep])

  const quickQuestions = [
    '他們的綠能承諾可以驗證嗎？',
    '這份報告有隱瞞負面消息嗎？',
    '有沒有提供基準年與量化指標？',
  ]

  if (authLoading) {
    return (
      <div className={styles.shell} style={{ display: 'grid', placeItems: 'center', color: '#475569' }}>
        正在檢查登入狀態…
      </div>
    )
  }

  if (currentPage === 'home') {
    return (
      <div className={styles.coverShell}>
        {sideMenu('home')}
        <div className={styles.coverTopNav}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              className={styles.coverHamburgerBtn}
              onClick={() => setMenuOpen((v) => !v)}
              title="開啟頁面選單"
            >
              ☰
            </button>
            <div className={styles.coverBrand}>VeriGreen</div>
          </div>
          <div className={styles.coverNavLinks}>
            <span>About</span>
            <span>Features</span>
            {currentUser ? (
              <>
                <button className={styles.coverNavBtn} onClick={() => goTo('dashboard')}>
                  Dashboard
                </button>
                <span className={styles.userInline}>
                  {currentUser.picture ? (
                    <img src={currentUser.picture} alt="avatar" className={styles.userAvatar} />
                  ) : (
                    <span className={styles.userAvatarFallback}>{(currentUser.name || currentUser.email || 'U').slice(0, 1).toUpperCase()}</span>
                  )}
                  <span>{currentUser.name || currentUser.email}</span>
                </span>
                <button className={styles.coverNavBtn} onClick={onLogout}>
                  Sign out
                </button>
              </>
            ) : (
              <button className={styles.coverNavBtn} onClick={startGoogleLogin}>
                Sign in with Google
              </button>
            )}
          </div>
        </div>
        <div
          className={styles.coverHero}
          style={{
            backgroundImage:
              "linear-gradient(180deg, rgba(2,6,23,0.35) 0%, rgba(2,6,23,0.58) 100%), url('/cover.jpg')",
          }}
        >
          <div className={styles.coverHeadline}>VeriGreen ESG 漂綠偵測平台</div>
          <div className={styles.coverSubline}>以 AI 量化風險，快速找出可疑揭露與證據頁碼</div>
          <button className={styles.coverEnterBtn} onClick={() => goTo('dashboard')}>
            {currentUser ? '進入儀表板' : 'Google 登入後進入'}
          </button>
        </div>
      </div>
    )
  }


  return (
    <div className={styles.shell}>
      {sideMenu('dashboard')}
      {showSourcePicker && (
        <div className={styles.sourcePickerBackdrop} onClick={() => setShowSourcePicker(false)}>
          <div className={styles.sourcePickerCard} onClick={(e) => e.stopPropagation()}>
            <div className={styles.sourcePickerTitle}>歡迎使用 VeriGreen ESG 漂綠偵測器</div>
            <div className={styles.sourcePickerSub}>請先選擇資料來源開始分析</div>
            <div className={styles.sourcePickerGrid}>
              <button className={styles.sourceOption} onClick={() => chooseSource('upload')}>
                <div className={styles.sourceOptionTitle}>PDF 上傳</div>
                <div className={styles.sourceOptionText}>拖放或選擇本機 ESG 報告開始分析。</div>
                <span className={styles.sourceOptionCta}>選擇上傳</span>
              </button>
              <button className={styles.sourceOption} onClick={() => chooseSource('db')}>
                <div className={styles.sourceOptionTitle}>資料庫匯入</div>
                <div className={styles.sourceOptionText}>從資料庫快速匯入報告內容。</div>
                <span className={styles.sourceOptionCta}>選擇資料庫</span>
              </button>
            </div>
            <div className={styles.sourcePickerHint}>（之後可隨時在左側分頁切換）</div>
          </div>
        </div>
      )}
      {showBatch && <BatchView onClose={() => setShowBatch(false)} />}
      <header className={styles.header}>
        <div className={styles.brand}>
          <button
            className={styles.hamburgerBtn}
            onClick={() => setMenuOpen((v) => !v)}
            title="開啟頁面選單"
          >
            ☰
          </button>
          <div className={styles.logo}>V</div>
          <div>
            <div className={styles.title}>VeriGreen: ESG Greenwashing Detector</div>
            <div className={styles.subtitle}>PC Dashboard</div>
          </div>
        </div>
        <div className={styles.headerRight}>
          <button className={styles.headerTextBtn} onClick={() => setCurrentPage('home')} title="Back to home">
            Home
          </button>
          {currentUser ? (
            <>
              <span className={styles.userInline}>
                {currentUser.picture ? (
                  <img src={currentUser.picture} alt="avatar" className={styles.userAvatar} />
                ) : (
                  <span className={styles.userAvatarFallback}>{(currentUser.name || currentUser.email || 'U').slice(0, 1).toUpperCase()}</span>
                )}
                <span className={styles.headerMetaText}>{currentUser.name || currentUser.email}</span>
              </span>
              <button
                className={styles.headerTextBtn}
                onClick={onLogout}
                title="Sign out"
              >
                Sign out
              </button>
            </>
          ) : (
            <button className={styles.headerTextBtn} onClick={startGoogleLogin} title="Sign in with Google">
              Sign in
            </button>
          )}
          <button className={styles.headerTextBtn} onClick={() => setShowBatch(true)} title="Open batch comparison">
            Batch Compare
          </button>
          <span className={styles.headerMetaText}>API: localhost:8000</span>
          {tejFilename && (
            <span className={styles.headerMetaText}
              title={`TEJ 資料來源：${tejFilename}`}
            >
              TEJ: {tejFilename.replace('DataExport.xlsx', '').replace('DataExport', '')}
            </span>
          )}
          <span className={styles.headerMetaText}>Status: {reportStatus}</span>
        </div>
      </header>

      <div className={styles.grid}>
        <aside className={styles.left}>
          <div ref={companyPanelRef} className={`${styles.panel} ${styles.companyPanel} card ${isTourTarget('company') ? styles.tourFocus : ''}`}>
            <div className={styles.panelTitle}>公司選擇</div>
            <div className={styles.searchRow}>
              <input
                className={styles.input}
                placeholder="公司名稱或代號…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void loadCompanies()
                }}
              />
              <button className={styles.btn} onClick={() => void loadCompanies()} disabled={loadingCompanies}>
                🔍
              </button>
            </div>
            <div style={{ marginTop: 8 }}>
              <select
                className={styles.input}
                value={filterIndustry}
                onChange={e => setFilterIndustry(e.target.value)}
                aria-label="industry"
              >
                <option value="">全部產業</option>
                {industries.map(ind => (
                  <option key={ind} value={ind}>{ind}</option>
                ))}
              </select>
            </div>
            <div className={styles.list}>
              {filteredCompanies.length === 0 && !loadingCompanies && (
                <div className={styles.muted} style={{ textAlign: 'center', padding: '16px 0' }}>
                  {filterIndustry ? `「${filterIndustry}」無已分析公司` : '尚無公司資料，請先上傳 ESG PDF'}
                </div>
              )}
              {filteredCompanies.map((c) => {
                const r = riskChip(c.latest_risk_level)
                const isSelected = selectedCompanyId === c.company_id
                return (
                  <div key={c.company_id}>
                    <div
                      className={styles.companyCard}
                      style={{ cursor: 'pointer', background: isSelected ? '#eef6f6' : undefined, borderColor: isSelected ? 'rgba(26,163,154,0.45)' : undefined }}
                      onClick={() => void selectCompany(c.company_id)}
                    >
                      {/* 第一行：公司名稱 + 風險標籤 + 刪除 */}
                      <div className={styles.companyTop}>
                        <div className={styles.companyName}>
                          {(() => {
                            const info = getCompanyCodeAndName(c)
                            return (
                              <>
                                <span style={{ color: '#94a3b8', fontWeight: 400, fontSize: 10, marginRight: 4 }}>
                                  {info.code || '----'}
                                </span>
                                {info.name}
                              </>
                            )
                          })()}
                        </div>
                        <div className={styles.companyActions}>
                          <span className={styles.riskBadge} style={{ borderColor: r.color, color: r.color }}>
                            {r.label}
                          </span>
                          <button
                            className={styles.btnDangerSm}
                            onClick={(e) => void onDeleteCompany(c.company_id, c.name || c.ticker || '此公司', e)}
                            title="刪除此公司及所有報告"
                          >
                            ✕
                          </button>
                        </div>
                      </div>

                      {/* 第二行：年份 + 分數 chips */}
                      <div className={styles.companyMeta}>
                        <span className="chip">{c.latest_report_year ?? '—'}</span>
                        <span className="chip">漂綠分析：{typeof c.latest_overall_score === 'number' ? c.latest_overall_score : '—'}</span>
                        {(() => {
                          const code = c.ticker || (/^\d{4,6}$/.test(c.name ?? '') ? c.name : null)
                          const t = code ? tejScores[code.padStart(4, '0')] : undefined
                          if (!t || t.ers_total == null) return null
                          const score = t.ers_total
                          const ersSt = ersTotalStyle(score)
                          return (
                            <span
                              className="chip"
                              title={`${ersSt.hint}｜${t.date}｜E:${t.ers_e?.toFixed(2)} S:${t.ers_s?.toFixed(2)} G:${t.ers_g?.toFixed(2)}`}
                              style={{ color: ersSt.color, borderColor: ersSt.borderColor, background: ersSt.bg, fontWeight: 700 }}
                            >
                              TEJ ERS：{score.toFixed(1)}
                            </span>
                          )
                        })()}
                      </div>

                      {/* 第三行：儀表板連結 */}
                      <div className={styles.companyLinks} onClick={(e) => e.stopPropagation()}>
                        {/* TWSE 預設連結永遠顯示 */}
                        <a
                          className={styles.dashboardLink}
                          href="https://esg.twse.com.tw/ESG/front/tw/#/main/esg-data/individual-company"
                          target="_blank"
                          rel="noreferrer"
                        >
                          查看 ESG 儀表板 ↗
                        </a>
                        {/* 自訂連結（若有設定則顯示為按鈕） */}
                        {c.dashboard_url && (
                          <a
                            className={styles.dashboardLink}
                            href={c.dashboard_url}
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: '#1aa39a', borderColor: 'rgba(26,163,154,0.45)' }}
                          >
                            自訂連結 ↗
                          </a>
                        )}
                        <button
                          className={styles.urlEditBtn}
                          onClick={() => { setEditingUrlId(c.company_id) }}
                        >
                          {c.dashboard_url ? '✏' : '+ 連結'}
                        </button>
                      </div>

                      {/* URL 編輯區塊（獨立子元件） */}
                      {editingUrlId === c.company_id && (
                        <UrlEditor
                          companyId={c.company_id}
                          initialUrl={c.dashboard_url ?? ''}
                          styles={styles}
                          onSave={saveCompanyUrl}
                          onCancel={() => setEditingUrlId(null)}
                        />
                      )}
                    </div>
                    {isSelected && (
                      <div className={styles.reportHistory}>
                        {loadingReports ? (
                          <div className={styles.muted} style={{ padding: '6px 10px' }}>載入中…</div>
                        ) : companyReports.length === 0 ? (
                          <div className={styles.muted} style={{ padding: '6px 10px' }}>無歷史報告</div>
                        ) : (
                          companyReports.map((rep) => {
                            const rr = riskChip(rep.risk_level)
                            const isActive = reportId === rep.report_id
                            return (
                              <div
                                key={rep.report_id}
                                className={styles.reportRow}
                                style={{ background: isActive ? '#d1faf6' : undefined }}
                                onClick={(e) => { e.stopPropagation(); void loadReport(rep.report_id) }}
                              >
                                <span>{rep.year ?? '—'} 年</span>
                                <span style={{ color: rr.color }}>{rr.label}</span>
                                <span>分數：{rep.overall_score ?? '—'}</span>
                                <button
                                  className={styles.btnDangerSm}
                                  onClick={(e) => void onDeleteReport(rep.report_id, e)}
                                  title="刪除此報告"
                                >
                                  刪除
                                </button>
                              </div>
                            )
                          })
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          <div ref={uploadPanelRef} className={`${styles.panel} ${styles.uploadPanel} card ${isTourTarget('upload') ? styles.tourFocus : ''}`}>
            <div
              ref={uploadTabsRef}
              className={`${styles.uploadTabs} ${isTourTarget('upload_tabs') ? `${styles.tourFocus} ${styles.tourFocusTabs}` : ''}`}
            >
              <button
                className={uploadTab === 'upload' ? styles.uploadTabActive : styles.uploadTabBtn}
                onClick={() => setUploadTab('upload')}
              >
                上傳 PDF
              </button>
              <button
                className={uploadTab === 'db' ? styles.uploadTabActive : styles.uploadTabBtn}
                onClick={() => { setUploadTab('db'); void onDbSearch() }}
              >
                資料庫選擇
              </button>
              <button
                className={uploadTab === 'agent' ? styles.uploadTabActive : styles.uploadTabBtn}
                onClick={() => setUploadTab('agent')}
              >
                自動抓報告
              </button>
            </div>

            {/* ── 資料庫分頁 ── */}
            {uploadTab === 'db' && (
              <div className={styles.dbPanel}>
                <div className={styles.dbFilters}>
                  <input
                    className={styles.dbInput}
                    placeholder="公司名稱或代號…"
                    value={dbQuery}
                    onChange={e => setDbQuery(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && void onDbSearch()}
                  />
                  <select className={styles.dbSelect} value={dbSector} onChange={e => {
                    setDbSector(e.target.value); setDbSelected(null)
                    void fetchSources({ q: dbQuery, sector: e.target.value, year: dbYear, lang: dbLang })
                      .then(r => setDbResults(r.items)).catch(() => {})
                  }}>
                    <option value="">全部行業</option>
                    {dbSectors.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <select className={styles.dbSelect} value={dbYear} onChange={e => {
                    setDbYear(e.target.value); setDbSelected(null)
                    void fetchSources({ q: dbQuery, sector: dbSector, year: e.target.value, lang: dbLang })
                      .then(r => setDbResults(r.items)).catch(() => {})
                  }}>
                    <option value="">全部年份</option>
                    {dbYears.map(y => <option key={y} value={y}>{y}</option>)}
                  </select>
                  <select className={styles.dbSelect} value={dbLang} onChange={e => {
                    setDbLang(e.target.value); setDbSelected(null)
                    void fetchSources({ q: dbQuery, sector: dbSector, year: dbYear, lang: e.target.value })
                      .then(r => setDbResults(r.items)).catch(() => {})
                  }}>
                    <option value="">中英文</option>
                    <option value="zh">中文</option>
                    <option value="en">英文</option>
                  </select>
                  <button className={styles.btnPrimary} onClick={() => void onDbSearch()}>搜尋</button>
                </div>
                <div className={styles.dbResults}>
                  {dbLoading && <div className={styles.muted} style={{ padding: '12px 0' }}>搜尋中…</div>}
                  {!dbLoading && dbResults.length === 0 && (
                    <div className={styles.muted} style={{ padding: '12px 0' }}>輸入關鍵字後按搜尋</div>
                  )}
                  {dbResults.filter(item => item.is_local || item.is_pdf).map(item => {
                    const isSelected = dbSelected?.source_id === item.source_id
                    return (
                      <div
                        key={item.source_id}
                        className={`${styles.dbRow} ${item.is_local ? styles.dbRowLocal : ''} ${isSelected ? styles.dbRowSelected : ''}`}
                        onClick={() => setDbSelected(isSelected ? null : item)}
                        title="點選後按下方確認匯入"
                      >
                        <div className={styles.dbRowCheck}>
                          {isSelected ? '✓' : ''}
                        </div>
                        <div className={styles.dbRowInfo}>
                          <div className={styles.dbRowName}>
                            <span style={{ color: '#94a3b8', fontWeight: 400, marginRight: 5, fontSize: 11 }}>
                              {item.company_id || '----'}
                            </span>
                            {(item.company_name ?? '').trim() || '（無公司名稱）'}
                          </div>
                          <div className={styles.dbRowMeta}>
                            <span>{item.year}</span>
                            <span>{item.sector}</span>
                            <span className={item.lang === 'zh' ? styles.dbLangZh : styles.dbLangEn}>
                              {item.lang === 'zh' ? '中文' : 'EN'}
                            </span>
                            {item.is_local && <span className={styles.dbLocal}>📁 本機</span>}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
                {/* 確認匯入按鈕 */}
                {dbSelected && (
                  <button
                    className={styles.btnPrimary}
                    style={{ width: '100%', marginTop: 8, padding: '10px 0', fontSize: 14, fontWeight: 700 }}
                    disabled={importingId !== null}
                    onClick={() => void onImport(dbSelected)}
                  >
                    {importingId ? '匯入中…' : `確認匯入：${dbSelected.company_name} ${dbSelected.year}`}
                  </button>
                )}
              </div>
            )}

            {/* ── 自動抓取分頁 ── */}
            {uploadTab === 'agent' && (
              <div className={styles.dbPanel}>
                <div className={styles.muted} style={{ marginBottom: 6 }}>
                  輸入公司名稱或代號，系統會自動抓取公開 ESG/CSR 報告並沿用既有分析流程。
                </div>
                <div className={styles.dbFilters}>
                  <input
                    className={styles.dbInput}
                    placeholder="例如：台積電 或 2330"
                    value={agentQuery}
                    onChange={(e) => setAgentQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void onAgentDownloadImport()}
                  />
                  <input
                    className={styles.dbInput}
                    style={{ maxWidth: 110 }}
                    placeholder="年度"
                    value={agentYear}
                    onChange={(e) => setAgentYear(e.target.value.replace(/[^\d]/g, '').slice(0, 4))}
                  />
                  <select
                    className={styles.dbSelect}
                    value={agentType}
                    onChange={(e) => setAgentType(e.target.value as 'esg' | 'csr' | 'both')}
                  >
                    <option value="both">ESG + CSR</option>
                    <option value="esg">ESG</option>
                    <option value="csr">CSR</option>
                  </select>
                </div>
                <button
                  className={styles.btnPrimary}
                  style={{ width: '100%', marginTop: 10, padding: '10px 0', fontSize: 14, fontWeight: 700 }}
                  onClick={() => void onAgentDownloadImport()}
                  disabled={agentLoading}
                >
                  {agentLoading ? '抓取與分析中…' : '開始自動下載並分析'}
                </button>
                {agentLoading && (
                  <div className={styles.uploadProgress} style={{ marginTop: 10 }}>
                    <div className={styles.uploadSpinner} />
                    <div className={styles.uploadProgressText}>
                      <div className={styles.uploadHeadline}>Agent 執行中…</div>
                      <div className={styles.muted}>已花費 {elapsedSec} 秒（下載 + 分析）</div>
                      <div className={styles.muted}>目前狀態：{reportStatus}</div>
                    </div>
                    <div className={styles.uploadProgressBar}>
                      <div
                        className={styles.uploadProgressFill}
                        style={{ width: `${Math.min(99, (elapsedSec / 180) * 100)}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── 上傳分頁 ── */}
            {uploadTab === 'upload' && <>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) setSelectedFile(f)
                e.currentTarget.value = ''
              }}
              style={{ display: 'none' }}
            />

            {/* 上傳進行中 */}
            {uploading ? (
              <div className={styles.uploadProgress}>
                <div className={styles.uploadSpinner} />
                <div className={styles.uploadProgressText}>
                  <div className={styles.uploadHeadline}>分析中…</div>
                  <div className={styles.muted}>已花費 {elapsedSec} 秒（預估 30–120 秒）</div>
                </div>
                <div className={styles.uploadProgressBar}>
                  <div
                    className={styles.uploadProgressFill}
                    style={{ width: `${Math.min(99, (elapsedSec / 90) * 100)}%` }}
                  />
                </div>
              </div>
            ) : (
              <div className={styles.uploadCard}>
                <div className={styles.uploadIcon}>📄</div>
                <div className={styles.uploadCardText}>
                  {selectedFile ? (
                    <>
                      <div className={styles.uploadHeadline} title={selectedFile.name}>
                        {selectedFile.name.length > 22 ? selectedFile.name.slice(0, 22) + '…' : selectedFile.name}
                      </div>
                      <div className={styles.muted}>確認後按「上傳」開始分析</div>
                    </>
                  ) : (
                    <>
                      <div className={styles.uploadHeadline}>選擇 PDF 檔案</div>
                      <div className={styles.muted}>選好後再按「上傳」送出</div>
                    </>
                  )}
                </div>
                <div className={styles.uploadBtns}>
                  <button
                    className={styles.btn}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    選擇
                  </button>
                  <button
                    className={styles.btnPrimary}
                    onClick={() => void onUpload()}
                    disabled={!selectedFile}
                  >
                    上傳
                  </button>
                </div>
              </div>
            )}

            {/* 狀態列 */}
            <div className={styles.uploadStatusRow}>
              <span className={styles.muted}>狀態：{reportStatus}</span>
              {reportId && !uploading && (
                <button
                  className={styles.btnDanger}
                  onClick={(e) => void onDeleteReport(reportId, e)}
                  title="刪除目前這份報告"
                >
                  刪除報告
                </button>
              )}
            </div>
            </>}
          </div>
        </aside>

        <main className={styles.main}>
          <div ref={riskPanelRef} className={`${styles.panel} card ${styles.mainTopPanel} ${isTourTarget('risk') ? styles.tourFocus : ''}`}>
            <div className={styles.riskPanelInner}>
            <div className={styles.panelTitleRow}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className={styles.riskMainTitle}>漂綠風險分析</div>
                {selectedCompanyMeta && (
                  <div className={styles.riskCompanySub} title={selectedCompanyMeta}>{selectedCompanyMeta}</div>
                )}
              </div>
              <span
                className={styles.riskScoreBadge}
                style={{ borderColor: isEmpty ? 'var(--muted)' : viewRiskInfo.color, color: isEmpty ? 'var(--muted)' : viewRiskInfo.color }}
              >
                {isEmpty ? '尚未載入報告' : `總分 ${viewOverall} · ${viewRiskInfo.label}`}
              </span>
            </div>

            <div className={styles.mainTopScroll}>
            <div className={styles.scoreRow}>
              <div className={styles.donutCard}>
              <div className={styles.donutWrap}>
                <div
                  aria-label="donut"
                  style={{
                    width: 200,
                    height: 200,
                    borderRadius: '999px',
                    background: isEmpty
                      ? '#e2e8f0'
                      : 'conic-gradient(var(--ok) 0 120deg, var(--warn) 120deg 240deg, var(--danger) 240deg 360deg)',
                    position: 'relative',
                    boxShadow: 'inset 0 0 0 12px #ffffff, 0 14px 28px rgba(15,23,42,0.09)',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      inset: 20,
                      borderRadius: '999px',
                      background: 'white',
                      border: '1px solid var(--border)',
                      display: 'grid',
                      placeItems: 'center',
                    }}
                  />
                </div>
                <div className={styles.scoreText}>
                  <div className={styles.scoreNum} style={{ color: isEmpty ? 'var(--muted)' : undefined }}>
                    {isEmpty ? '—' : viewOverall}
                  </div>
                  <div className={styles.muted}>漂綠風險總分</div>
                </div>
              </div>
              <div className={styles.summaryBox}>
                <div className={styles.summaryTitle}>本次總體摘要</div>
                <div className={styles.summaryText}>{overallSummary}</div>
              </div>
              </div>

              <div className={styles.radarCol}>
                <div className={styles.radarSectionTitle}>多維度評級（Radar）</div>
                <div className={styles.radarPanelInner} style={{ opacity: isEmpty ? 0.45 : 1, flex: 1, minHeight: 0 }}>
                  <Radar
                    scores={displayAnalysis.dimension_scores}
                    activeDim={activeDim}
                    onSelect={(dim) => void onSelectDim(dim)}
                    isEmpty={isEmpty}
                  />
                </div>
                {!isEmpty && (
                  <div className={styles.radarHint}>
                    點擊圖上標籤篩選漂綠證據
                  </div>
                )}
              </div>
            </div>

            <div className={`${styles.tejRow} ${styles.riskRightCol}`}>
                {selectedTejScore && (() => {
                  const totalSt = ersTotalStyle(selectedTejScore.ers_total)
                  return (
                  <div>
                    <div className={styles.tejHeader}>
                      <span className={styles.tejLabel}>TEJ · ERS</span>
                      <span className={styles.tejDate}>{selectedTejScore.date}</span>
                    </div>
                    <div className={styles.tejHintPill}>{totalSt.hint}</div>
                    <div className={styles.tejStatGrid}>
                      <div
                        className={styles.tejStat}
                        style={{ background: totalSt.bg, borderColor: totalSt.borderColor }}
                      >
                        <div className={styles.tejStatLabel}>ERS 總分</div>
                        <div className={styles.tejStatValue} style={{ color: totalSt.color }}>
                          {selectedTejScore.ers_total?.toFixed(1) ?? '—'}
                        </div>
                      </div>
                      <div className={styles.tejStat}>
                        <div className={styles.tejStatLabel}>行業最高</div>
                        <div className={styles.tejStatValue} style={{ color: '#475569' }}>
                          {selectedTejScore.industry_max_ers?.toFixed(1) ?? '—'}
                        </div>
                      </div>
                      {selectedTejScore.chg_1y != null && (
                        <div className={styles.tejStat}>
                          <div className={styles.tejStatLabel}>同月年變動</div>
                          <div
                            className={styles.tejStatValue}
                            style={{
                              color: (selectedTejScore.chg_1y ?? 0) > 0 ? '#15803d' : (selectedTejScore.chg_1y ?? 0) < 0 ? '#c2410c' : '#64748b',
                            }}
                          >
                            {(selectedTejScore.chg_1y ?? 0) >= 0 ? '+' : ''}{selectedTejScore.chg_1y?.toFixed(2)}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  )
                })()}
                {!selectedTejScore && (
                  <div className={styles.tejEmpty}>
                    選取左側公司後，若 TEJ 有資料將顯示 ERS 評分。
                  </div>
                )}
            </div>
            </div>
            </div>
          </div>
        </main>

        <aside className={styles.right}>
          <div ref={evidencePanelRef} className={`${styles.panel} card ${styles.evidencePanel} ${isTourTarget('evidence') ? styles.tourFocus : ''}`}>
              <div className={styles.panelTitle}>漂綠證據摘要</div>
            <div className={styles.evidenceList}>
              {evidence.length === 0 && (
                <div className={styles.emptyEvidence}>
                  <div className={styles.emptyIcon}>🔍</div>
                  <div className={styles.emptyTitle}>
                    {reportId ? '分析尚未完成' : '尚無 Evidence'}
                  </div>
                  <div className={styles.muted}>
                    {reportId
                      ? '請稍候，AI 正在掃描報告中的可疑段落…'
                      : '上傳 ESG PDF 後，AI 會自動偵測漂綠語句並列出引用段落與頁碼。'}
                  </div>
                  {!reportId && (
                    <div className={styles.emptyHints}>
                      {Object.values(DIM_LABEL).map((t) => (
                        <span key={t} className="chip" style={{ opacity: 0.5 }}>{t}</span>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {evidence.map((e) => (
                <div key={e.evidence_id} className={styles.evidenceCard}>
                  <div className={styles.evidenceTop}>
                    <span className="chip">{DIM_LABEL[e.dimension] ?? e.dimension}</span>
                    <span className="chip">Risk {e.severity || '—'}</span>
                  </div>
                  <div className={styles.evidenceClaim}>{e.claim}</div>
                  <div className={styles.citations}>
                    {e.citations.map((c, idx) => (
                      <button
                        key={idx}
                        className={styles.citationBtn}
                        onClick={() => (c.page_number > 0 ? void openPage(c.page_number) : undefined)}
                        title={c.page_number > 0 ? '點擊查看頁面文字' : '尚無頁碼（未上傳）'}
                        disabled={c.page_number <= 0}
                        style={c.page_number <= 0 ? { opacity: 0.75, cursor: 'not-allowed' } : undefined}
                      >
                        <span className={styles.citePage}>{c.page_number > 0 ? `Page ${c.page_number}` : 'Page —'}</span>
                        <span className={styles.citeQuote}>{c.quote}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

        </aside>
      </div>

      {pageModal && (
        <div className={styles.modalBackdrop} onClick={() => setPageModal(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHead}>
              <div>PDF Page Preview（p.{pageModal.page}）</div>
              <button className={styles.btn} onClick={() => setPageModal(null)}>關閉</button>
            </div>
            <pre className={styles.modalBody}>{pageModal.text || '（此頁無可抽取文字，可能是掃描圖像）'}</pre>
          </div>
        </div>
      )}

      {showTutorial && currentPage === 'dashboard' && (
        <>
          <div className={styles.tourOverlay} />
          <div className={styles.tutorialCard} style={tutorialCardStyle} onClick={(e) => e.stopPropagation()}>
            <div className={styles.tutorialTop}>
              <div className={styles.tutorialKicker}>使用教學</div>
              <button className={styles.btn} onClick={closeTutorial}>關閉</button>
            </div>
            <div className={styles.tutorialProgressText}>
              Step {tutorialSteps[tutorialStep].mainStep} / 6
              {tutorialSteps[tutorialStep].subStepLabel ? `（${tutorialSteps[tutorialStep].subStepLabel}）` : ''}
            </div>
            <div className={styles.tutorialProgressBar}>
              <div
                className={styles.tutorialProgressFill}
                style={{ width: `${(tutorialSteps[tutorialStep].mainStep / 6) * 100}%` }}
              />
            </div>
            <div className={styles.tutorialTitle}>{tutorialSteps[tutorialStep].title}</div>
            <div className={styles.tutorialBody}>{tutorialSteps[tutorialStep].text}</div>
            {tutorialStep === tutorialSteps.length - 1 && (
              <label className={styles.tutorialCheck}>
                <input
                  type="checkbox"
                  checked={hideTutorialNextTime}
                  onChange={(e) => setHideTutorialNextTime(e.target.checked)}
                />
                下次不要再顯示
              </label>
            )}
            <div className={styles.tutorialActions}>
              <button
                className={styles.btn}
                disabled={tutorialStep === 0}
                onClick={() => setTutorialStep((s) => Math.max(0, s - 1))}
              >
                上一步
              </button>
              {tutorialStep < tutorialSteps.length - 1 ? (
                <button className={styles.btnPrimary} onClick={() => setTutorialStep((s) => s + 1)}>
                  下一步
                </button>
              ) : (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className={styles.btn} onClick={() => setTutorialStep(0)}>
                    重新教學
                  </button>
                  <button className={styles.btnPrimary} onClick={closeTutorial}>
                    完成
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── 懸浮 AI Chatbot ── */}
      {chatOpen && (
        <div ref={chatPanelRef} className={`${styles.chatFloatWrap} ${isTourTarget('chat') ? styles.tourFocusFloating : ''}`}>
          <div className={styles.chatFloatHeader}>
            <div className={styles.chatFloatTitle}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="4" y="7" width="16" height="11" rx="3" fill="#1aa39a"/>
                <line x1="12" y1="4" x2="12" y2="7" stroke="#1aa39a" strokeWidth="1.8" strokeLinecap="round"/>
                <circle cx="12" cy="3.5" r="1.2" fill="#1aa39a"/>
                <circle cx="9" cy="12" r="1.5" fill="white"/>
                <circle cx="15" cy="12" r="1.5" fill="white"/>
                <path d="M9.5 15 Q12 16.5 14.5 15" stroke="white" strokeWidth="1.4" strokeLinecap="round" fill="none"/>
                <rect x="2" y="10" width="2" height="4" rx="1" fill="#1aa39a"/>
                <rect x="20" y="10" width="2" height="4" rx="1" fill="#1aa39a"/>
              </svg>
              <span>AI Analyst Chatbot</span>
              {chatTyping && <span className={styles.muted} style={{ fontSize: 12 }}>正在輸入…</span>}
            </div>
            <button className={styles.chatFloatClose} onClick={() => setChatOpen(false)}>✕</button>
          </div>

          <div className={styles.chatFloatQuick}>
            {quickQuestions.map((q) => (
              <button key={q} className={styles.quickBtn} onClick={() => void sendChat(q)} disabled={chatTyping}>
                {q}
              </button>
            ))}
          </div>

          <div className={styles.chatFloatBody}>
            {chatMsgs.length === 0 ? (
              <div className={styles.muted} style={{ padding: '16px', lineHeight: 1.6 }}>
                針對目前載入的 ESG 報告，你可以問我任何問題，我會引用相關頁碼回答。
                {!reportId && <><br /><br />⚠ 請先在左側上傳或選擇一份 ESG PDF。</>}
              </div>
            ) : (
              chatMsgs.map((m, idx) => (
                <div key={idx} className={m.role === 'user' ? styles.msgUser : styles.msgAi}>
                  {m.content.trimStart()}
                </div>
              ))
            )}
            {chatTyping && (
              <div className={styles.msgAi}>
                <span className={styles.typingDot} />
                <span className={styles.typingDot} />
                <span className={styles.typingDot} />
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <div className={styles.chatFloatInput}>
            <input
              ref={chatInputRef}
              className={styles.input}
              value={chatInput}
              placeholder="輸入問題…"
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void sendChat() }}
              disabled={chatTyping}
            />
            <button className={styles.btnPrimary} onClick={() => void sendChat()} disabled={chatTyping}>
              {chatTyping ? '…' : '送出'}
            </button>
          </div>
        </div>
      )}

      {/* FAB 按鈕 */}
      <button
        ref={chatFabRef}
        className={styles.chatFab}
        style={isTourTarget('chat') ? { zIndex: 1260 } : undefined}
        onClick={() => setChatOpen((o) => !o)}
        title="AI Analyst Chatbot"
      >
        {chatOpen ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        ) : (
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            {/* 圓頭 */}
            <rect x="4" y="7" width="16" height="11" rx="3" fill="white" fillOpacity="0.95"/>
            {/* 天線 */}
            <line x1="12" y1="4" x2="12" y2="7" stroke="white" strokeWidth="1.8" strokeLinecap="round"/>
            <circle cx="12" cy="3.5" r="1.2" fill="white"/>
            {/* 眼睛 */}
            <circle cx="9" cy="12" r="1.5" fill="#1aa39a"/>
            <circle cx="15" cy="12" r="1.5" fill="#1aa39a"/>
            {/* 嘴巴 */}
            <path d="M9.5 15 Q12 16.5 14.5 15" stroke="#1aa39a" strokeWidth="1.4" strokeLinecap="round" fill="none"/>
            {/* 耳朵 */}
            <rect x="2" y="10" width="2" height="4" rx="1" fill="white" fillOpacity="0.8"/>
            <rect x="20" y="10" width="2" height="4" rx="1" fill="white" fillOpacity="0.8"/>
          </svg>
        )}
        {chatMsgs.length > 0 && !chatOpen && (
          <span className={styles.chatFabBadge}>{chatMsgs.filter((m) => m.role === 'assistant').length}</span>
        )}
      </button>
    </div>
  )
}

