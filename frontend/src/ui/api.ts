export const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8000'

async function apiFetch(input: string | URL, init?: RequestInit) {
  return fetch(input, { credentials: 'include', ...(init ?? {}) })
}

export type AuthMe = {
  user_id: string
  email: string
  name?: string | null
  picture?: string | null
}

export function startGoogleLogin() {
  window.location.href = API_BASE + '/api/auth/google/start'
}

export async function fetchMe(): Promise<AuthMe | null> {
  const r = await apiFetch(API_BASE + '/api/auth/me')
  if (r.status === 401) return null
  if (!r.ok) throw new Error('取得登入狀態失敗')
  return r.json()
}

export async function logout(): Promise<void> {
  const r = await apiFetch(API_BASE + '/api/auth/logout', { method: 'POST' })
  if (!r.ok) throw new Error('登出失敗')
}

export type CompanyListItem = {
  company_id: string
  name: string
  ticker?: string | null
  industry?: string | null
  dashboard_url?: string | null
  latest_report_year?: number | null
  latest_overall_score?: number | null
  latest_risk_level?: string | null
}

export type CompaniesResponse = {
  items: CompanyListItem[]
  total: number
}

export type AnalysisResponse = {
  overall_score: number
  risk_level: 'low' | 'moderate' | 'high'
  breakdown: { reason: string; weight: number; score_contribution: number }[]
  key_metrics: { metric: string; target: string; actual: string; gap: string; status: string }[]
  dimension_scores: Record<string, number>
}

export type EvidenceItem = {
  evidence_id: string
  dimension: string
  claim: string
  severity: number
  citations: { chunk_id: string; page_number: number; quote: string; confidence?: number | null }[]
}

export type CompanyReport = {
  report_id: string
  year?: number | null
  status: string
  pages?: number | null
  created_at?: string | null
  overall_score?: number | null
  risk_level?: string | null
}

export async function fetchCompanyReports(companyId: string): Promise<{ items: CompanyReport[] }> {
  const r = await apiFetch(API_BASE + `/api/companies/${companyId}/reports`)
  if (!r.ok) throw new Error('載入報告歷史失敗')
  return r.json()
}

export async function fetchCompanies(query?: string): Promise<CompaniesResponse> {
  const u = new URL(API_BASE + '/api/companies')
  if (query) u.searchParams.set('query', query)
  const r = await apiFetch(u)
  if (!r.ok) throw new Error('載入公司清單失敗')
  return r.json()
}

export async function uploadReport(formData: FormData): Promise<{ report_id: string; status: string }> {
  const r = await apiFetch(API_BASE + '/api/reports/upload', { method: 'POST', body: formData })
  if (!r.ok) {
    const err = await r.json().catch(() => ({})) as { detail?: string | { msg?: string }[] }
    let msg = `上傳失敗（HTTP ${r.status}）`
    if (typeof err.detail === 'string') msg = err.detail
    else if (Array.isArray(err.detail)) {
      const parts = err.detail.map((d: { msg?: string }) => d?.msg ?? '').filter(Boolean)
      if (parts.length) msg = parts.join('；')
    }
    throw new Error(msg)
  }
  return r.json()
}

export async function fetchReportStatus(reportId: string) {
  const r = await apiFetch(API_BASE + `/api/reports/${reportId}`)
  if (!r.ok) throw new Error('取得報告狀態失敗')
  return r.json() as Promise<{ report_id: string; status: string; pages?: number | null }>
}

export async function fetchAnalysis(reportId: string): Promise<AnalysisResponse> {
  const r = await apiFetch(API_BASE + `/api/reports/${reportId}/analysis`)
  if (!r.ok) throw new Error('分析尚未完成')
  return r.json()
}

export async function fetchEvidence(reportId: string, dimension?: string): Promise<{ items: EvidenceItem[] }> {
  const u = new URL(API_BASE + `/api/reports/${reportId}/evidence`)
  if (dimension) u.searchParams.set('dimension', dimension)
  const r = await apiFetch(u)
  if (!r.ok) throw new Error('取得證據失敗')
  return r.json()
}

export async function fetchPage(reportId: string, page: number): Promise<{ page_number: number; text: string }> {
  const r = await apiFetch(API_BASE + `/api/reports/${reportId}/pages/${page}`)
  if (!r.ok) throw new Error('取得頁面失敗')
  return r.json()
}

export async function deleteReport(reportId: string): Promise<void> {
  const r = await apiFetch(API_BASE + `/api/reports/${reportId}`, { method: 'DELETE' })
  if (!r.ok) throw new Error('刪除失敗')
}

export async function deleteCompany(companyId: string): Promise<void> {
  const r = await apiFetch(API_BASE + `/api/companies/${companyId}`, { method: 'DELETE' })
  if (!r.ok) throw new Error('刪除公司失敗')
}

export async function updateCompanyUrl(companyId: string, dashboardUrl: string): Promise<void> {
  const r = await apiFetch(API_BASE + `/api/companies/${companyId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dashboard_url: dashboardUrl }),
  })
  if (!r.ok) throw new Error('更新連結失敗')
}

// ── 報告書資料庫 ──────────────────────────────────────────────────────
export type SourceItem = {
  source_id: string
  company_id: string
  company_name: string
  sector: string
  year: string
  lang: string
  url: string
  is_pdf: boolean
  is_local: boolean
  local_path?: string | null
}

export async function fetchSources(params: {
  q?: string; sector?: string; year?: string; lang?: string
}): Promise<{ items: SourceItem[]; total: number }> {
  const u = new URL(API_BASE + '/api/sources')
  if (params.q)      u.searchParams.set('q',      params.q)
  if (params.sector) u.searchParams.set('sector', params.sector)
  if (params.year)   u.searchParams.set('year',   params.year)
  if (params.lang)   u.searchParams.set('lang',   params.lang)
  const r = await apiFetch(u)
  if (!r.ok) throw new Error('搜尋資料庫失敗')
  return r.json()
}

export async function fetchSourceFilters(): Promise<{ sectors: string[]; years: string[] }> {
  const r = await apiFetch(API_BASE + '/api/sources/sectors')
  if (!r.ok) throw new Error('取得篩選選項失敗')
  return r.json()
}

export async function importSource(item: SourceItem): Promise<{ report_id: string; status: string }> {
  const r = await apiFetch(API_BASE + '/api/sources/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(item),
  })
  if (!r.ok) {
    const err = await r.json().catch(() => ({}))
    throw new Error((err as { detail?: string }).detail ?? '匯入失敗')
  }
  return r.json()
}

export async function crawlAndImport(body: {
  query: string
  year?: number | null
  report_type?: 'esg' | 'csr' | 'both'
}): Promise<{
  report_id: string
  status: string
  company_code: string
  company_name: string
  selected_file: string
  downloaded_count: number
}> {
  const r = await apiFetch(API_BASE + '/api/agent/download-import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const err = await r.json().catch(() => ({}))
    throw new Error((err as { detail?: string }).detail ?? '自動抓取失敗')
  }
  return r.json()
}

// ── 批量分析 ──────────────────────────────────────────────────────────
export type CompanyAnalysis = {
  company_id: string
  name: string
  ticker?: string | null
  industry?: string | null
  has_analysis: boolean
  year?: number | null
  overall_score?: number | null
  risk_level?: string | null
  dimension_scores?: Record<string, number>
  breakdown?: { reason: string; weight: number; score_contribution: number }[]
}

export async function fetchCompanyAnalysis(companyId: string): Promise<CompanyAnalysis> {
  const r = await apiFetch(API_BASE + `/api/companies/${companyId}/analysis`)
  if (!r.ok) throw new Error('取得分析失敗')
  return r.json()
}

export type ChatHistoryItem = { role: 'user' | 'assistant'; content: string }

export async function chat(
  reportId: string,
  message: string,
  session_id?: string | null,
  history?: ChatHistoryItem[],
) {
  const r = await apiFetch(API_BASE + `/api/reports/${reportId}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, session_id, history: history ?? [] }),
  })
  if (!r.ok) throw new Error('聊天失敗')
  return r.json() as Promise<{
    session_id: string
    answer: string
    citations: { chunk_id: string; page_number: number; quote: string }[]
    suggested_questions?: string[] | null
  }>
}

// ── TEJ ERS 分數 ─────────────────────────────────────────────────────────────
export type TejScore = {
  code: string
  name: string
  date: string
  e_ratio: number | null
  s_ratio: number | null
  g_ratio: number | null
  ers_e: number | null
  ers_s: number | null
  ers_g: number | null
  ers_total: number | null
  industry_max_ers: number | null
  chg_1y: number | null
}

export async function fetchTejScores(codes: string[]): Promise<{ filename: string; items: TejScore[] }> {
  const q = codes.length ? `?codes=${codes.join(',')}` : ''
  const r = await apiFetch(API_BASE + `/api/tej/scores${q}`)
  if (!r.ok) throw new Error('無法載入 TEJ 分數')
  return r.json()
}

