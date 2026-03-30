from __future__ import annotations

import csv
import glob
import os
import re
import secrets
import sys
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode

import httpx
import orjson
from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import ORJSONResponse, RedirectResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from .analyze import score_report
from .db import DATA_DIR, SessionLocal, init_db
from .ingest import chunk_pages, extract_pages
from .llm_analysis import run_chat_on_chunks, run_greenwashing_detector_from_chunks
from .models import Analysis, AuthSession, Chunk, Company, EvidenceItem, OAuthState, Report, ReportPage, User

# ── 環境設定（支援從專案根目錄 .env 載入）─────────────────────────────────
def _load_env_file() -> None:
    env_path = DATA_DIR.parent / ".env"
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


_load_env_file()

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "").strip()
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "").strip()
GOOGLE_REDIRECT_URI = os.getenv("GOOGLE_REDIRECT_URI", "http://localhost:8000/api/auth/google/callback").strip()
FRONTEND_BASE_URL = os.getenv("FRONTEND_BASE_URL", "http://localhost:5173").strip()
SESSION_SECRET = os.getenv("SESSION_SECRET", "").strip()
if not SESSION_SECRET:
    SESSION_SECRET = secrets.token_urlsafe(48)
SESSION_COOKIE_SECURE = os.getenv("SESSION_COOKIE_SECURE", "false").strip().lower() in {"1", "true", "yes", "on"}
SESSION_COOKIE_NAME = "vg_session"
OAUTH_STATE_COOKIE_NAME = "vg_oauth_state"
SESSION_TTL_DAYS = 7
# 前後端不同網域時 fetch 屬 cross-site；OAuth state 與 session 皆須 SameSite=None + Secure（HTTPS）
SESSION_COOKIE_SAMESITE: str = "none" if SESSION_COOKIE_SECURE else "lax"

# ── 維度正規化（模組層級，各處共用）────────────────────────────────────
_DIM_NORMALIZE: dict[str, str] = {
    "selective_disclosure": "selective_disclosure",
    "readability": "readability",
    "target_gap": "target_gap",
    "greenwashing_language": "greenwashing_language",
    # 舊英文 key（向新四維度對齊）
    "soft_vs_hard": "selective_disclosure",
    "third_party": "target_gap",
    "tone_management": "greenwashing_language",
    "unsubstantiated": "target_gap",
    "vague_definitions": "greenwashing_language",
    "lack_of_proof": "target_gap",
    "hidden_tradeoffs": "selective_disclosure",
    "selective_reporting": "selective_disclosure",
    "irrelevant_claims": "greenwashing_language",
    # LLM 英文全名
    "Selective Disclosure": "selective_disclosure",
    "Readability": "readability",
    "Tone Management": "greenwashing_language",
    "Unsubstantiated Claims": "target_gap",
    "Target Gap": "target_gap",
    "Third Party": "target_gap",
    # 中文標籤
    "軟硬性揭露落差": "selective_disclosure",
    "軟性揭露與硬性揭露落差": "selective_disclosure",
    "軟性與硬性揭露落差": "selective_disclosure",
    "選擇性揭露": "selective_disclosure",
    "選擇性揭露與櫻桃挑選": "selective_disclosure",
    "目標與現況落差": "target_gap",
    "第三方查證不足": "target_gap",
    "漂綠語言使用": "greenwashing_language",
    "可讀性與混淆視聽": "readability",
    "文本可讀性與混淆視聽": "readability",
    "文本可讀性": "readability",
    "語氣操弄": "greenwashing_language",
    "表達性操弄與異常語氣": "greenwashing_language",
    "缺乏實證": "target_gap",
    "缺乏實證與不可靠聲稱": "target_gap",
}

def _norm_dim(raw: str) -> str:
    s = (raw or "").strip()
    if s in _DIM_NORMALIZE:
        return _DIM_NORMALIZE[s]
    for part in s.split(","):
        p = part.strip()
        if p in _DIM_NORMALIZE:
            return _DIM_NORMALIZE[p]
    return s or "greenwashing_language"


def _normalize_dimension_scores(scores: dict | None) -> dict[str, int]:
    """把舊版/混合 key 的維度分數，整理為目前四維度格式。"""
    normalized: dict[str, int] = {
        "selective_disclosure": 0,
        "readability": 0,
        "greenwashing_language": 0,
        "target_gap": 0,
    }
    if not isinstance(scores, dict):
        return normalized

    for raw_key, raw_val in scores.items():
        k = _norm_dim(str(raw_key))
        if k not in normalized:
            continue
        try:
            v = int(float(raw_val))
        except Exception:
            continue
        # 同一維度若被多個舊 key 合併，保留較高風險值
        normalized[k] = max(normalized[k], max(0, min(100, v)))
    return normalized
from .schemas import (
    AnalysisResponse,
    ChatHistoryItem,  # noqa: F401 — used via ChatRequest.history
    ChatRequest,
    ChatResponse,
    CompaniesResponse,
    EvidenceResponse,
    PageResponse,
    ReportStatusResponse,
    UploadReportResponse,
)


REPORTS_DIR = DATA_DIR / "reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)

# ── 報告書資料庫（從 CSV 載入）──────────────────────────────────────
_CSV_PATH  = DATA_DIR.parent / "esg_sources_twse.csv"
RAW_PDFS_DIR = DATA_DIR / "raw_pdfs"

def _local_pdf_path(company_id: str, year: str, lang: str) -> Path | None:
    """回傳 raw_pdfs 目錄中對應的本地 PDF 路徑（若存在）。"""
    p = RAW_PDFS_DIR / f"{company_id}_{year}_{lang}.pdf"
    return p if p.exists() else None

def _load_sources() -> list[dict]:
    if not _CSV_PATH.exists():
        return []
    rows = []
    with open(_CSV_PATH, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            rows.append(row)
    return rows

_SOURCES: list[dict] = _load_sources()
_SOURCE_NAME_BY_CODE: dict[str, str] = {}
_SOURCE_CODE_BY_NAME: dict[str, str] = {}
for _r in _SOURCES:
    _cid = str(_r.get("company_id", "")).strip()
    _cname = str(_r.get("company_name", "")).strip()
    if _cid and _cname and _cid not in _SOURCE_NAME_BY_CODE:
        _SOURCE_NAME_BY_CODE[_cid] = _cname
    if _cid and _cname and _cname not in _SOURCE_CODE_BY_NAME:
        _SOURCE_CODE_BY_NAME[_cname] = _cid


def _norm_stock_code(raw: str | None) -> str:
    s = (raw or "").strip()
    if not s:
        return ""
    digits = "".join(ch for ch in s if ch.isdigit())
    if 1 <= len(digits) <= 6:
        return digits.zfill(4)
    return s


def _resolve_company_name(raw_name: str | None, raw_ticker: str | None) -> str:
    """
    以 CSV（esg_sources_twse.csv）優先補齊公司名稱：
    - 若 DB 名稱缺失或只是一串代碼，改用 ticker 對應的 CSV 名稱
    - 最後回退到原始名稱或代碼
    """
    name = (raw_name or "").strip()
    ticker = (raw_ticker or "").strip()
    name_is_code = bool(name) and bool(re.fullmatch(r"\d{4,6}", name))

    # 先用 ticker 比對，再用 name（若 name 本身是代碼）比對
    for candidate in (_norm_stock_code(ticker), _norm_stock_code(name if name_is_code else "")):
        if not candidate:
            continue
        mapped = _SOURCE_NAME_BY_CODE.get(candidate)
        if mapped:
            return mapped

    if name:
        return name
    return ticker or "Unknown Company"


def _resolve_company_ticker(raw_name: str | None, raw_ticker: str | None) -> str | None:
    """
    優先保留既有 ticker，若缺失則嘗試由公司名稱回推 CSV 代碼。
    """
    ticker = _norm_stock_code(raw_ticker)
    if ticker:
        return ticker
    name = (raw_name or "").strip()
    if not name:
        return None
    return _SOURCE_CODE_BY_NAME.get(name)


def _risk_level_from_score(score: int | float | None) -> str:
    """
    統一風險分級：
    - 1~29: low
    - 30~69: moderate
    - 70~100: high
    """
    try:
        s = float(score or 0)
    except Exception:
        s = 0.0
    if s >= 70:
        return "high"
    if s >= 30:
        return "moderate"
    return "low"


app = FastAPI(title="VeriGreen API", default_response_class=ORJSONResponse)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_BASE_URL, "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup() -> None:
    init_db()


def _db() -> Session:
    return SessionLocal()


def _json(data):
    return orjson.loads(orjson.dumps(data))


def _now_utc() -> datetime:
    return datetime.utcnow()


def _require_oauth_env() -> None:
    missing = [
        k for k, v in [
            ("GOOGLE_CLIENT_ID", GOOGLE_CLIENT_ID),
            ("GOOGLE_CLIENT_SECRET", GOOGLE_CLIENT_SECRET),
            ("GOOGLE_REDIRECT_URI", GOOGLE_REDIRECT_URI),
            ("FRONTEND_BASE_URL", FRONTEND_BASE_URL),
            ("SESSION_SECRET", SESSION_SECRET),
        ] if not v
    ]
    if missing:
        raise HTTPException(status_code=500, detail=f"OAuth 設定缺失：{', '.join(missing)}")


def _serialize_user(u: User) -> dict:
    return {
        "user_id": u.user_id,
        "email": u.email,
        "name": u.name,
        "picture": u.picture,
    }


def _get_current_user_from_request(request: Request, db: Session) -> User | None:
    token = (request.cookies.get(SESSION_COOKIE_NAME) or "").strip()
    if not token:
        return None
    sess = (
        db.query(AuthSession)
        .filter(
            AuthSession.session_token == token,
            AuthSession.revoked_at.is_(None),
            AuthSession.expires_at > _now_utc(),
        )
        .first()
    )
    if not sess:
        return None
    return db.query(User).filter(User.user_id == sess.user_id).first()


def require_auth(request: Request) -> User:
    session_token = ""
    db = _db()
    try:
        u = _get_current_user_from_request(request, db)
        if not u:
            raise HTTPException(status_code=401, detail="Not authenticated")
        return u
    finally:
        db.close()


@app.middleware("http")
async def _auth_guard(request: Request, call_next):
    path = request.url.path
    if request.method == "OPTIONS":
        return await call_next(request)
    if not path.startswith("/api/"):
        return await call_next(request)
    if path.startswith("/api/auth/"):
        return await call_next(request)

    protected_prefixes = (
        "/api/companies",
        "/api/reports",
        "/api/sources",
        "/api/tej",
        "/api/agent",
    )
    if any(path.startswith(p) for p in protected_prefixes):
        db = _db()
        try:
            if _get_current_user_from_request(request, db) is None:
                return ORJSONResponse({"detail": "Not authenticated"}, status_code=401)
        finally:
            db.close()
    return await call_next(request)


@app.get("/api/auth/google/start")
def auth_google_start():
    _require_oauth_env()
    state = secrets.token_urlsafe(24)
    now = datetime.utcnow()
    db = _db()
    try:
        db.query(OAuthState).filter(OAuthState.expires_at < now).delete()
        db.add(OAuthState(state=state, expires_at=now + timedelta(minutes=10)))
        db.commit()
    finally:
        db.close()
    params = {
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": "openid email profile",
        "access_type": "online",
        "prompt": "select_account",
        "state": state,
    }
    url = f"https://accounts.google.com/o/oauth2/v2/auth?{urlencode(params)}"
    return RedirectResponse(url=url, status_code=302)


@app.get("/api/auth/google/callback")
async def auth_google_callback(request: Request, code: str | None = None, state: str | None = None):
    _require_oauth_env()
    if not code or not state:
        raise HTTPException(status_code=400, detail="Missing oauth callback params")

    db_chk = _db()
    try:
        now = datetime.utcnow()
        row = (
            db_chk.query(OAuthState)
            .filter(OAuthState.state == state, OAuthState.expires_at > now)
            .first()
        )
        if not row:
            raise HTTPException(status_code=400, detail="Invalid oauth state")
        db_chk.delete(row)
        db_chk.commit()
    finally:
        db_chk.close()

    async with httpx.AsyncClient(timeout=20) as client:
        token_resp = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "code": code,
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "redirect_uri": GOOGLE_REDIRECT_URI,
                "grant_type": "authorization_code",
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        if token_resp.status_code != 200:
            raise HTTPException(status_code=400, detail="Failed to exchange Google token")
        token_json = token_resp.json()
        access_token = token_json.get("access_token")
        if not access_token:
            raise HTTPException(status_code=400, detail="Google access token missing")

        userinfo_resp = await client.get(
            "https://www.googleapis.com/oauth2/v3/userinfo",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if userinfo_resp.status_code != 200:
            raise HTTPException(status_code=400, detail="Failed to fetch Google userinfo")
        u = userinfo_resp.json()

    google_sub = str(u.get("sub") or "").strip()
    email = str(u.get("email") or "").strip().lower()
    if not google_sub or not email:
        raise HTTPException(status_code=400, detail="Invalid Google userinfo")

    db = _db()
    try:
        user = db.query(User).filter(User.google_sub == google_sub).first()
        if not user:
            user = db.query(User).filter(func.lower(User.email) == email).first()
        if user:
            user.google_sub = google_sub
            user.email = email
            user.name = (u.get("name") or "").strip() or user.name
            user.picture = (u.get("picture") or "").strip() or user.picture
            user.last_login_at = datetime.utcnow()
            db.add(user)
            db.commit()
            db.refresh(user)
        else:
            user = User(
                google_sub=google_sub,
                email=email,
                name=(u.get("name") or "").strip() or email,
                picture=(u.get("picture") or "").strip() or None,
                last_login_at=datetime.utcnow(),
            )
            db.add(user)
            db.commit()
            db.refresh(user)

        sess = AuthSession(
            user_id=user.user_id,
            session_token=secrets.token_urlsafe(48),
            expires_at=datetime.utcnow() + timedelta(days=SESSION_TTL_DAYS),
        )
        db.add(sess)
        db.commit()
        session_token = sess.session_token
    finally:
        db.close()

    redirect_url = FRONTEND_BASE_URL.rstrip("/") + "/?oauth=1"
    resp = RedirectResponse(url=redirect_url, status_code=302)
    resp.delete_cookie(
        OAUTH_STATE_COOKIE_NAME,
        path="/",
        secure=SESSION_COOKIE_SECURE,
        samesite=SESSION_COOKIE_SAMESITE,
    )
    resp.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=session_token,
        max_age=SESSION_TTL_DAYS * 24 * 3600,
        httponly=True,
        samesite=SESSION_COOKIE_SAMESITE,
        secure=SESSION_COOKIE_SECURE,
        path="/",
    )
    return resp


@app.get("/api/auth/me")
def auth_me(request: Request):
    db = _db()
    try:
        user = _get_current_user_from_request(request, db)
        if not user:
            raise HTTPException(status_code=401, detail="Not authenticated")
        return _serialize_user(user)
    finally:
        db.close()


@app.post("/api/auth/logout")
def auth_logout(request: Request, response: Response):
    token = (request.cookies.get(SESSION_COOKIE_NAME) or "").strip()
    if token:
        db = _db()
        try:
            sess = db.query(AuthSession).filter(AuthSession.session_token == token, AuthSession.revoked_at.is_(None)).first()
            if sess:
                sess.revoked_at = datetime.utcnow()
                db.add(sess)
                db.commit()
        finally:
            db.close()
    response = ORJSONResponse({"status": "logged_out"})
    response.delete_cookie(
        SESSION_COOKIE_NAME,
        path="/",
        secure=SESSION_COOKIE_SECURE,
        samesite=SESSION_COOKIE_SAMESITE,
    )
    return response


def _get_or_create_company(db: Session, *, name: str, ticker: str | None, industry: str | None) -> Company:
    q = db.query(Company).filter(func.lower(Company.name) == name.lower())
    if ticker:
        q = q.union(db.query(Company).filter(func.lower(Company.ticker) == ticker.lower()))
    company = q.first()
    if company:
        if industry and not company.industry:
            company.industry = industry
            db.add(company)
            db.commit()
        return company

    company = Company(name=name, ticker=ticker, industry=industry)
    db.add(company)
    db.commit()
    db.refresh(company)
    return company


def _merge_llm_with_heuristic(heuristic: dict, llm: dict) -> dict:
    """
    將 Gemini 回傳結果與原本 heuristic 分數合併成一份 dict，
    結構維持 score_report 的輸出格式，方便前端直接沿用。
    """
    scored = dict(heuristic)

    # overall score & risk level（Gemini 直接回傳 0–100）
    try:
        overall = int(float(llm.get("overall_risk_score") or 0))
    except (ValueError, TypeError):
        overall = int(heuristic.get("overall_score") or 0)

    scored["overall_score"] = max(0, min(100, overall))
    # 風險等級一律依分數區間判定，避免 LLM 文字標籤與門檻不一致
    scored["risk_level"] = _risk_level_from_score(scored["overall_score"])

    # dimension scores：直接使用 LLM scoring 的 key，與 pdf_test.py 標準一致
    dim_scores = dict(heuristic.get("dimension_scores") or {})
    scoring = llm.get("scoring") or {}
    if scoring:
        def s(key: str) -> int:
            v = scoring.get(key)
            try:
                return max(0, min(100, int(float(v))))
            except Exception:
                return dim_scores.get(key, scored["overall_score"])

        # LLM scoring key 可能是舊 key，normalize 後再存
        for raw_key in list(scoring.keys()):
            norm_key = _norm_dim(raw_key)
            dim_scores[norm_key] = s(raw_key)
        # 確保 4 個標準 key 都存在
        for dk in ["selective_disclosure", "readability", "greenwashing_language", "target_gap"]:
            if dk not in dim_scores:
                dim_scores[dk] = scored.get("overall_score", 0)

    scored["dimension_scores"] = _normalize_dimension_scores(dim_scores)

    # breakdown：根據真實 dim_scores 動態生成，標題與 pdf_test.py 評估標準完全一致
    DIM_INFO = [
        ("selective_disclosure",  "選擇性揭露",       0.25),
        ("readability",           "文本可讀性",       0.25),
        ("greenwashing_language", "漂綠語言使用",     0.25),
        ("target_gap",            "目標與現況落差",   0.25),
    ]
    scored["breakdown"] = [
        {
            "reason": reason,
            "weight": weight,
            "score_contribution": int(scored["dimension_scores"].get(dim_key, 0) * weight),
        }
        for dim_key, reason, weight in DIM_INFO
    ]


    # evidence：將 LLM 的 evidence_summary 轉成 EvidenceItem 結構
    ev_from_llm = []
    for item in llm.get("evidence_summary") or []:
        quote = item.get("quote") or ""
        page = int(item.get("page") or 0)
        dim = _norm_dim(str(item.get("dimension") or "target_gap"))
        analysis_txt = item.get("analysis") or ""
        # 粗略將嚴重度與 overall score 綁在一起
        severity = scored["overall_score"]
        ev_from_llm.append(
            {
                "dimension": dim,
                "claim": analysis_txt or "LLM 判定為具潛在漂綠風險的段落。",
                "severity": severity,
                "citations": [
                    {
                        "chunk_id": "llm",
                        "page_number": page,
                        "quote": quote[:450].strip(),
                        "confidence": None,
                    }
                ],
            }
        )

    # 如果 LLM 有 evidence，就優先使用；否則保留原本 heuristic 的 evidence
    if ev_from_llm:
        scored["evidence"] = ev_from_llm

    # 目前 key_metrics 仍使用 analyze.score_report 產生的，以後可再改為 LLM 抽取
    return scored


def _run_ingest_and_analyze(report_id: str) -> None:
    db = _db()
    try:
        report = db.query(Report).filter(Report.report_id == report_id).first()
        if not report:
            return

        report.status = "ingested"
        db.add(report)
        db.commit()

        pdf_path = Path(report.source_pdf_path)
        total_pages, pages = extract_pages(pdf_path)
        report.pages = total_pages

        # store per-page text
        db.query(ReportPage).filter(ReportPage.report_id == report_id).delete()
        for p in pages:
            db.add(ReportPage(report_id=report_id, page_number=p.page_number, text=p.text))

        # chunking
        raw_chunks = chunk_pages(pages)
        db.query(Chunk).filter(Chunk.report_id == report_id).delete()
        chunks: list[Chunk] = []
        for rc in raw_chunks:
            ch = Chunk(
                report_id=report_id,
                company_id=report.company_id,
                year=report.year,
                industry=report.company.industry,
                page_start=rc["page_start"],
                page_end=rc["page_end"],
                section=None,
                text=rc["text"],
                char_count=rc["char_count"],
            )
            db.add(ch)
            chunks.append(ch)

        report.status = "indexed"
        db.add(report)
        db.commit()

        # analysis (MVP heuristics)
        scored = score_report(
            [
                {"chunk_id": c.chunk_id, "page_start": c.page_start, "page_end": c.page_end, "text": c.text}
                for c in chunks
            ]
        )

        # 嘗試改用 Gemini 進行風險評分與 evidence 生成；若失敗則退回 heuristic
        try:
            llm_result = run_greenwashing_detector_from_chunks(chunks)
            scored = _merge_llm_with_heuristic(scored, llm_result)
            model_version = "gemini-2.5-flash"
        except Exception:
            model_version = "mvp-heuristic-v1"

        # upsert analysis
        existing = db.query(Analysis).filter(Analysis.report_id == report_id).first()
        if existing:
            db.query(EvidenceItem).filter(EvidenceItem.analysis_id == existing.analysis_id).delete()
            db.delete(existing)
            db.commit()

        analysis = Analysis(
            report_id=report_id,
            overall_score=scored["overall_score"],
            risk_level=scored["risk_level"],
            dimension_scores=_json(scored["dimension_scores"]),
            breakdown=_json(scored["breakdown"]),
            key_metrics=_json(scored["key_metrics"]),
            model_version=model_version,
        )
        db.add(analysis)
        db.commit()
        db.refresh(analysis)

        for e in scored["evidence"]:
            ev = EvidenceItem(
                analysis_id=analysis.analysis_id,
                dimension=e["dimension"],
                claim=e["claim"],
                severity=int(e["severity"]),
                citations=_json(e["citations"]),
            )
            db.add(ev)

        report.status = "analyzed"
        db.add(report)
        db.commit()
    finally:
        db.close()


@app.patch("/api/companies/{company_id}")
def update_company(company_id: str, body: dict):
    db = _db()
    try:
        company = db.query(Company).filter(Company.company_id == company_id).first()
        if not company:
            raise HTTPException(status_code=404, detail="company not found")
        if "dashboard_url" in body:
            url = (body["dashboard_url"] or "").strip() or None
            company.dashboard_url = url
        if "industry" in body:
            company.industry = (body["industry"] or "").strip() or None
        db.add(company)
        db.commit()
        return {"status": "updated"}
    finally:
        db.close()


@app.delete("/api/companies/{company_id}")
def delete_company(company_id: str):
    db = _db()
    try:
        company = db.query(Company).filter(Company.company_id == company_id).first()
        if not company:
            raise HTTPException(status_code=404, detail="company not found")
        reports = db.query(Report).filter(Report.company_id == company_id).all()
        pdf_paths = []
        for report in reports:
            analysis = db.query(Analysis).filter(Analysis.report_id == report.report_id).first()
            if analysis:
                db.query(EvidenceItem).filter(EvidenceItem.analysis_id == analysis.analysis_id).delete()
                db.delete(analysis)
            db.query(Chunk).filter(Chunk.report_id == report.report_id).delete()
            db.query(ReportPage).filter(ReportPage.report_id == report.report_id).delete()
            pdf_paths.append(Path(report.source_pdf_path))
            db.delete(report)
        db.delete(company)
        db.commit()
        for p in pdf_paths:
            p.unlink(missing_ok=True)
        return {"status": "deleted", "company_id": company_id}
    finally:
        db.close()


@app.get("/api/companies/{company_id}/reports")
def list_company_reports(company_id: str):
    db = _db()
    try:
        reports = (
            db.query(Report)
            .filter(Report.company_id == company_id)
            .order_by(Report.created_at.desc())
            .all()
        )

        STATUS_RANK = {"analyzed": 0, "indexed": 1, "ingested": 2, "uploaded": 3, "downloading": 4}

        # 同年只保留最佳一筆（analyzed 優先，其次最新建立）
        best_by_year: dict = {}
        for r in reports:
            yr = r.year
            prev = best_by_year.get(yr)
            if prev is None:
                best_by_year[yr] = r
            else:
                r_rank   = STATUS_RANK.get(r.status, 9)
                pre_rank = STATUS_RANK.get(prev.status, 9)
                if r_rank < pre_rank:
                    best_by_year[yr] = r

        items = []
        for r in sorted(best_by_year.values(), key=lambda x: (x.year or 0), reverse=True):
            analysis = db.query(Analysis).filter(Analysis.report_id == r.report_id).first()
            score = analysis.overall_score if analysis else None
            items.append({
                "report_id": r.report_id,
                "year": r.year,
                "status": r.status,
                "pages": r.pages,
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "overall_score": score,
                "risk_level": _risk_level_from_score(score) if score is not None else None,
            })
        return {"items": items}
    finally:
        db.close()


@app.get("/api/companies", response_model=CompaniesResponse)
def list_companies(query: str | None = None, industry: str | None = None, risk_level: str | None = None, limit: int = 50, offset: int = 0):
    db = _db()
    try:
        q = db.query(Company)
        if query:
            like = f"%{query.lower()}%"
            q = q.filter(func.lower(Company.name).like(like) | func.lower(Company.ticker).like(like))
        if industry:
            q = q.filter(Company.industry == industry)
        companies = q.order_by(Company.created_at.desc()).offset(offset).limit(limit).all()

        items = []
        for c in companies:
            # 優先選有分析結果的最新報告；若都沒有則退回最新報告
            latest_analysis = (
                db.query(Analysis)
                .join(Report, Report.report_id == Analysis.report_id)
                .filter(Report.company_id == c.company_id)
                .order_by(Report.year.desc().nullslast(), Report.created_at.desc())
                .first()
            )
            if latest_analysis:
                latest = db.query(Report).filter(Report.report_id == latest_analysis.report_id).first()
            else:
                latest = (
                    db.query(Report)
                    .filter(Report.company_id == c.company_id)
                    .order_by(Report.year.desc().nullslast(), Report.created_at.desc())
                    .first()
                )
            latest_score = latest_analysis.overall_score if latest_analysis else None
            latest_risk = _risk_level_from_score(latest_score) if latest_score is not None else (latest.status if latest else None)
            if risk_level and latest_analysis and latest_risk != risk_level:
                continue
            resolved_name = _resolve_company_name(c.name, c.ticker)
            resolved_ticker = _resolve_company_ticker(resolved_name, c.ticker)

            items.append(
                {
                    "company_id": c.company_id,
                    "name": resolved_name,
                    "ticker": resolved_ticker,
                    "industry": c.industry,
                    "dashboard_url": c.dashboard_url,
                    "latest_report_year": latest.year if latest else None,
                    "latest_overall_score": latest_score,
                    "latest_risk_level": latest_risk,
                }
            )

        total = q.count()
        return {"items": items, "total": total}
    finally:
        db.close()


@app.get("/api/companies/{company_id}/analysis")
def get_company_latest_analysis(company_id: str):
    """回傳指定公司的最新分析結果（含維度分數），供批量比較使用。"""
    db = _db()
    try:
        company = db.query(Company).filter(Company.company_id == company_id).first()
        if not company:
            raise HTTPException(status_code=404, detail="Company not found")
        analysis = (
            db.query(Analysis)
            .join(Report, Report.report_id == Analysis.report_id)
            .filter(Report.company_id == company_id)
            .order_by(Report.year.desc().nullslast(), Report.created_at.desc())
            .first()
        )
        if not analysis:
            return {"company_id": company_id, "name": company.name, "ticker": company.ticker,
                    "industry": company.industry, "has_analysis": False}
        report = db.query(Report).filter(Report.report_id == analysis.report_id).first()
        return {
            "company_id": company_id,
            "name": company.name,
            "ticker": company.ticker,
            "industry": company.industry,
            "has_analysis": True,
            "year": report.year if report else None,
            "overall_score": analysis.overall_score,
            "risk_level": _risk_level_from_score(analysis.overall_score),
            "dimension_scores": _normalize_dimension_scores(analysis.dimension_scores or {}),
            "breakdown": analysis.breakdown or [],
        }
    finally:
        db.close()


@app.post("/api/reports/upload", response_model=UploadReportResponse)
async def upload_report(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    company_name: str | None = Form(None),
    ticker: str | None = Form(None),
    industry: str | None = Form(None),
    year: int | None = Form(None),
):
    if file.content_type not in ("application/pdf", "application/x-pdf"):
        raise HTTPException(status_code=400, detail="只支援 PDF")

    report_id = str(uuid.uuid4())
    pdf_path = REPORTS_DIR / f"{report_id}.pdf"

    content = await file.read()
    pdf_path.write_bytes(content)

    # 若前端未提供公司名稱，從檔名自動推一個合理預設
    inferred_name: str
    if company_name and company_name.strip():
        inferred_name = company_name.strip()
    else:
        stem = Path(file.filename or "").stem
        parts = stem.split("_")
        inferred_name = (parts[0] or "").strip() or "Unknown Company"

    db = _db()
    try:
        company = _get_or_create_company(db, name=inferred_name, ticker=ticker, industry=industry)
        report = Report(
            report_id=report_id,
            company_id=company.company_id,
            year=year,
            source_pdf_path=str(pdf_path),
            status="uploaded",
        )
        db.add(report)
        db.commit()
    finally:
        db.close()

    background_tasks.add_task(_run_ingest_and_analyze, report_id)
    return {"report_id": report_id, "status": "uploaded"}


@app.delete("/api/reports/{report_id}")
def delete_report(report_id: str):
    db = _db()
    try:
        report = db.query(Report).filter(Report.report_id == report_id).first()
        if not report:
            raise HTTPException(status_code=404, detail="report not found")
        analysis = db.query(Analysis).filter(Analysis.report_id == report_id).first()
        if analysis:
            db.query(EvidenceItem).filter(EvidenceItem.analysis_id == analysis.analysis_id).delete()
            db.delete(analysis)
        db.query(Chunk).filter(Chunk.report_id == report_id).delete()
        db.query(ReportPage).filter(ReportPage.report_id == report_id).delete()
        pdf_path = Path(report.source_pdf_path)
        db.delete(report)
        db.commit()
        if pdf_path.exists():
            pdf_path.unlink(missing_ok=True)
        return {"status": "deleted", "report_id": report_id}
    finally:
        db.close()


@app.get("/api/reports/{report_id}", response_model=ReportStatusResponse)
def report_status(report_id: str):
    db = _db()
    try:
        report = db.query(Report).filter(Report.report_id == report_id).first()
        if not report:
            raise HTTPException(status_code=404, detail="report not found")
        payload = {
            "report_id": report.report_id,
            "company_id": report.company_id,
            "year": report.year,
            "pages": report.pages,
            "status": report.status,
            "progress": None,
        }
        return payload
    finally:
        db.close()


@app.get("/api/reports/{report_id}/analysis", response_model=AnalysisResponse)
def get_analysis(report_id: str):
    db = _db()
    try:
        analysis = db.query(Analysis).filter(Analysis.report_id == report_id).first()
        if not analysis:
            raise HTTPException(status_code=404, detail="analysis not ready")
        return {
            "overall_score": analysis.overall_score,
            "risk_level": _risk_level_from_score(analysis.overall_score),
            "breakdown": analysis.breakdown,
            "key_metrics": analysis.key_metrics,
            "dimension_scores": _normalize_dimension_scores(analysis.dimension_scores),
        }
    finally:
        db.close()


@app.get("/api/reports/{report_id}/evidence", response_model=EvidenceResponse)
def get_evidence(report_id: str, dimension: str | None = None):
    db = _db()
    try:
        analysis = db.query(Analysis).filter(Analysis.report_id == report_id).first()
        if not analysis:
            raise HTTPException(status_code=404, detail="analysis not ready")
        q = db.query(EvidenceItem).filter(EvidenceItem.analysis_id == analysis.analysis_id)
        if dimension:
            norm = _norm_dim(dimension)
            q = q.filter(EvidenceItem.dimension == norm)
        items = []
        for e in q.order_by(EvidenceItem.severity.desc()).all():
            items.append(
                {
                    "evidence_id": e.evidence_id,
                    "dimension": e.dimension,
                    "claim": e.claim,
                    "severity": int(e.severity),
                    "citations": e.citations,
                }
            )
        return {"items": items}
    finally:
        db.close()


@app.get("/api/reports/{report_id}/pages/{page_number}", response_model=PageResponse)
def get_page(report_id: str, page_number: int):
    db = _db()
    try:
        page = (
            db.query(ReportPage)
            .filter(ReportPage.report_id == report_id, ReportPage.page_number == page_number)
            .first()
        )
        if not page:
            raise HTTPException(status_code=404, detail="page not found")
        return {"page_number": page.page_number, "text": page.text, "highlights": None}
    finally:
        db.close()


@app.post("/api/reports/{report_id}/chat", response_model=ChatResponse)
def chat(report_id: str, req: ChatRequest):
    """
    MVP：回傳可展示的回答 + citations。
    後續替換：向量檢索 top-k chunks → 以 citations 驅動生成。
    """
    db = _db()
    try:
        chunks = db.query(Chunk).filter(Chunk.report_id == report_id).order_by(Chunk.page_start.asc()).limit(8).all()
        if not chunks:
            raise HTTPException(status_code=404, detail="report not ready")

        # 建立 page -> chunk 的對應表，方便之後依引用頁碼查 quote
        page_chunk_map: dict[int, Chunk] = {}
        for c in chunks:
            for p in range(int(c.page_start), int(c.page_end) + 1):
                if p not in page_chunk_map:
                    page_chunk_map[p] = c

        citations = []
        history_dicts = [{"role": h.role, "content": h.content} for h in req.history]
        try:
            result = run_chat_on_chunks(req.message, chunks, history=history_dicts)
            llm_answer = result["answer"]
            cited_pages = result["cited_pages"]
            answer = f"（LLM 回覆）{llm_answer}"

            # 依 Gemini 回傳的頁碼建立 citations
            seen: set[int] = set()
            for pg in cited_pages:
                if pg in seen:
                    continue
                seen.add(pg)
                chunk = page_chunk_map.get(pg)
                citations.append({
                    "chunk_id": chunk.chunk_id if chunk else "llm",
                    "page_number": pg,
                    "quote": (chunk.text[:300].strip() if chunk else ""),
                    "confidence": 0.8,
                })

        except Exception:
            answer = (
                "（Fallback 回覆）目前無法呼叫進階 AI 分析服務，但我已為你整理出幾段與問題可能相關的報告內容。"
                "建議你從右側 evidence 的引用頁碼進一步閱讀原文，特別留意目標是否具體、是否有基準年與可驗證數據。"
            )
            # fallback：取第一個 chunk 作為參考
            if chunks:
                c0 = chunks[0]
                citations = [{"chunk_id": c0.chunk_id, "page_number": int(c0.page_start), "quote": c0.text[:200].strip(), "confidence": 0.3}]

        return {
            "session_id": req.session_id or str(uuid.uuid4()),
            "answer": answer,
            "citations": citations,
            "suggested_questions": [
                "他們的綠能承諾可以驗證嗎？",
                "這份報告有隱瞞負面消息嗎？",
                "有沒有提供基準年與量化指標？",
            ],
        }
    finally:
        db.close()


@app.post("/api/reports/{report_id}/llm-analysis")
def llm_analysis(report_id: str):
    """
    使用 Gemini 針對指定報告的 chunks 做一次進階漂綠分析。
    這個結果獨立於 MVP heuristic 分數，不寫入資料庫，直接回傳 JSON。
    """
    db = _db()
    try:
        report = db.query(Report).filter(Report.report_id == report_id).first()
        if not report:
            raise HTTPException(status_code=404, detail="report not found")

        chunks = (
            db.query(Chunk)
            .filter(Chunk.report_id == report_id)
            .order_by(Chunk.page_start.asc())
            .all()
        )
        if not chunks:
            raise HTTPException(status_code=400, detail="report not indexed yet")

        result = run_greenwashing_detector_from_chunks(chunks)
        return result
    finally:
        db.close()


# ── 報告書資料庫端點 ──────────────────────────────────────────────────

@app.get("/api/sources")
def search_sources(q: str = "", sector: str = "", year: str = "", lang: str = ""):
    """搜尋 CSV 報告書資料庫，回傳符合條件的結果（最多 80 筆）。"""
    results = []
    q_low = q.strip().lower().replace("臺", "台")

    def _matches(row: dict) -> bool:
        if not q_low:
            return True
        cid  = row.get("company_id", "")
        name = row.get("company_name", "").lower().replace("臺", "台")
        # 代碼或全名直接包含
        if q_low in cid or q_low in name:
            return True
        # 短名稱：每個字都出現在公司名（如「台泥」→「台灣水泥」）
        if len(q_low) <= 5 and all(c in name for c in q_low):
            return True
        return False

    for row in _SOURCES:
        if not _matches(row):
            continue
        if sector and sector != row.get("sector", ""):
            continue
        if year and year != row.get("year", ""):
            continue
        if lang and lang != row.get("lang", ""):
            continue
        cid  = row.get("company_id", "")
        yr   = row.get("year", "")
        lg   = row.get("lang", "")
        local = _local_pdf_path(cid, yr, lg)
        results.append({
            "source_id":    row.get("twse_download_id", ""),
            "company_id":   cid,
            "company_name": row.get("company_name", ""),
            "sector":       row.get("sector", ""),
            "year":         yr,
            "lang":         lg,
            "url":          row.get("url", ""),
            "is_pdf":       row.get("url", "").lower().endswith(".pdf"),
            "is_local":     local is not None,
            "local_path":   str(local) if local else None,
        })
        if len(results) >= 80:
            break
    return {"items": results, "total": len(results)}


@app.get("/api/sources/sectors")
def list_sectors():
    """回傳所有行業別（供前端 filter 用）。"""
    sectors = sorted({r.get("sector", "") for r in _SOURCES if r.get("sector")})
    years   = sorted({r.get("year",   "") for r in _SOURCES if r.get("year")},   reverse=True)
    return {"sectors": sectors, "years": years}


@app.post("/api/sources/import")
async def import_source(body: dict, background_tasks: BackgroundTasks):
    """
    從資料庫匯入 PDF 並排入分析。
    優先使用本地 raw_pdfs 檔案；若無則嘗試從 URL 下載（需直接 PDF 連結）。
    body: { source_id, company_id, company_name, sector, year, lang, url, local_path?, is_local? }
    """
    url          = (body.get("url") or "").strip()
    company_name = (body.get("company_name") or "").strip()
    company_id   = (body.get("company_id") or "").strip()
    sector       = (body.get("sector") or "").strip() or None
    year_raw     = str(body.get("year") or "").strip()
    year         = int(year_raw) if year_raw.isdigit() else None
    lang         = (body.get("lang") or "").strip()

    if not company_name:
        raise HTTPException(status_code=400, detail="company_name 為必填")

    # 優先使用本地檔案
    local_path = _local_pdf_path(company_id, year_raw, lang)
    if not local_path and not url.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="此 URL 非直接 PDF 連結，且本地無對應檔案，請手動下載後上傳")

    db = _db()
    try:
        company = _get_or_create_company(
            db, name=company_name,
            ticker=company_id or None,
            industry=sector,
        )
        report_id = str(uuid.uuid4())
        safe_name = re.sub(r"[^\w\-]", "_", f"{company_name}_{year_raw}")

        if local_path:
            # 直接用本地路徑，不複製檔案
            pdf_path = local_path
            initial_status = "ingested"
        else:
            pdf_path = REPORTS_DIR / f"{report_id}_{safe_name}.pdf"
            initial_status = "downloading"

        report = Report(
            report_id       = report_id,
            company_id      = company.company_id,
            year            = year,
            source_pdf_path = str(pdf_path),
            status          = initial_status,
        )
        db.add(report)
        db.commit()

        if local_path:
            background_tasks.add_task(_run_ingest_and_analyze, report_id)
            return {"report_id": report_id, "status": "ingested", "source": "local"}
        else:
            background_tasks.add_task(_download_and_analyze, report_id, url, pdf_path)
            return {"report_id": report_id, "status": "downloading", "source": "remote"}
    finally:
        db.close()


def _download_and_analyze(report_id: str, url: str, pdf_path: Path) -> None:
    """背景工作：下載 PDF 後呼叫 _run_ingest_and_analyze。"""
    db = _db()
    try:
        with httpx.Client(timeout=120, follow_redirects=True) as client:
            resp = client.get(url, headers={"User-Agent": "Mozilla/5.0"})
            resp.raise_for_status()
            pdf_path.write_bytes(resp.content)
        report = db.query(Report).filter(Report.report_id == report_id).first()
        if report:
            report.status = "downloaded"
            db.add(report)
            db.commit()
    except Exception as exc:
        report = db.query(Report).filter(Report.report_id == report_id).first()
        if report:
            report.status = f"error: download failed – {exc}"
            db.add(report)
            db.commit()
        db.close()
        return
    finally:
        db.close()
    _run_ingest_and_analyze(report_id)


def _match_company_codes(query: str, limit: int = 5) -> list[str]:
    q = (query or "").strip().lower().replace("臺", "台")
    if not q:
        return []

    scored: list[tuple[int, str]] = []
    seen: set[str] = set()
    for row in _SOURCES:
        code = str(row.get("company_id", "")).strip()
        name = str(row.get("company_name", "")).strip().lower().replace("臺", "台")
        if not code:
            continue
        score = -1
        if q == code:
            score = 0
        elif q in code:
            score = 1
        elif q == name:
            score = 2
        elif q in name:
            score = 3
        elif len(q) <= 5 and all(ch in name for ch in q):
            score = 4
        if score >= 0 and code not in seen:
            seen.add(code)
            scored.append((score, code))

    scored.sort(key=lambda x: (x[0], x[1]))
    return [code for _, code in scored[:limit]]


def _pick_best_downloaded_file(paths: list[str], preferred_lang: str = "zh") -> str | None:
    if not paths:
        return None
    ranked: list[tuple[int, str]] = []
    pref = (preferred_lang or "zh").lower()
    for p in paths:
        s = p.lower()
        score = 99
        if "\\esg\\" in s or "/esg/" in s:
            score -= 20
        if f"_{pref}.pdf" in s:
            score -= 10
        if s.endswith(".pdf"):
            score -= 5
        ranked.append((score, p))
    ranked.sort(key=lambda x: x[0])
    return ranked[0][1]


@app.post("/api/agent/download-import")
async def agent_download_and_import(body: dict, background_tasks: BackgroundTasks):
    """
    透過外部 esg_csr_agent 下載指定公司報告，下載後沿用既有分析流程。
    body: { query, year?, report_type? }
    """
    query = (body.get("query") or "").strip()
    if not query:
        raise HTTPException(status_code=400, detail="query 為必填（公司代號或公司名稱）")

    report_type = str(body.get("report_type") or "both").strip().lower()
    if report_type not in {"esg", "csr", "both"}:
        raise HTTPException(status_code=400, detail="report_type 僅支援 esg/csr/both")

    year_raw = body.get("year")
    year: int | None
    try:
        year = int(year_raw) if year_raw not in (None, "", "null") else None
    except Exception:
        raise HTTPException(status_code=400, detail="year 格式錯誤")

    matched_codes = _match_company_codes(query, limit=5)
    if not matched_codes:
        raise HTTPException(status_code=404, detail=f"找不到符合「{query}」的公司")
    code = matched_codes[0]
    company_name = _SOURCE_NAME_BY_CODE.get(code) or query

    desktop_dir = Path(__file__).resolve().parents[3]
    if str(desktop_dir) not in sys.path:
        sys.path.insert(0, str(desktop_dir))
    try:
        from esg_csr_agent import download_reports as download_mod  # type: ignore
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"無法載入 esg_csr_agent：{exc}")

    db = _db()
    report_id = str(uuid.uuid4())
    try:
        company = _get_or_create_company(
            db,
            name=company_name,
            ticker=code,
            industry=None,
        )
        report = Report(
            report_id=report_id,
            company_id=company.company_id,
            year=year or datetime.now().year,
            source_pdf_path=str(REPORTS_DIR / f"{report_id}_agent_pending.pdf"),
            status="downloading",
        )
        db.add(report)
        db.commit()
        background_tasks.add_task(
            _agent_download_and_analyze_job,
            report_id,
            code,
            company_name,
            year,
            report_type,
        )
    finally:
        db.close()

    return {
        "report_id": report_id,
        "status": "downloading",
        "company_code": code,
        "company_name": company_name,
        "selected_file": "",
        "downloaded_count": 0,
    }


def _agent_download_and_analyze_job(
    report_id: str,
    code: str,
    company_name: str,
    year: int | None,
    report_type: str,
) -> None:
    db = _db()
    try:
        report = db.query(Report).filter(Report.report_id == report_id).first()
        if not report:
            return
        report.status = "downloading"
        db.add(report)
        db.commit()
    finally:
        db.close()

    desktop_dir = Path(__file__).resolve().parents[3]
    if str(desktop_dir) not in sys.path:
        sys.path.insert(0, str(desktop_dir))
    try:
        from esg_csr_agent import download_reports as download_mod  # type: ignore
        summary = download_mod.run(
            report_type=report_type,
            year=year,
            company_codes=[code],
            jobs=8,
            fallback_url=False,
        )
        downloaded_paths: list[str] = []
        for t in ("esg", "csr"):
            info = summary.get(t) or {}
            downloaded_paths.extend([str(p) for p in (info.get("downloaded") or [])])
        downloaded_paths = [p for p in downloaded_paths if p.lower().endswith(".pdf")]
        picked = _pick_best_downloaded_file(downloaded_paths, preferred_lang="zh")
        if not picked:
            raise RuntimeError(f"未抓到 {code} 可用 PDF")
        picked_path = Path(picked)

        inferred_year = year
        m = re.search(r"_(\d{4})_(zh|en)\.pdf$", picked_path.name.lower())
        if m:
            try:
                inferred_year = int(m.group(1))
            except Exception:
                pass
        if inferred_year is None:
            inferred_year = datetime.now().year

        db = _db()
        try:
            report = db.query(Report).filter(Report.report_id == report_id).first()
            if not report:
                return
            report.year = inferred_year
            report.source_pdf_path = str(picked_path)
            report.status = "ingested"
            db.add(report)
            db.commit()
        finally:
            db.close()

        _run_ingest_and_analyze(report_id)
    except Exception as exc:
        db = _db()
        try:
            report = db.query(Report).filter(Report.report_id == report_id).first()
            if report:
                report.status = f"error: agent download failed – {exc}"
                db.add(report)
                db.commit()
        finally:
            db.close()


# ── TEJ ERS 分數 ─────────────────────────────────────────────────────────────
TEJ_EXPORT_DIR = Path(r"C:\TejPro\TejPro\DataExport")

def _latest_tej_file() -> Path | None:
    """回傳 DataExport 資料夾中最新的 xlsx 檔。"""
    files = sorted(TEJ_EXPORT_DIR.glob("*.xlsx"), reverse=True)
    return files[0] if files else None


_tej_cache: dict = {}  # {filepath_str: DataFrame}

def _load_tej_df():
    """載入最新 TEJ Excel，並以公司代碼為 index 快取。"""
    import pandas as pd
    latest = _latest_tej_file()
    if latest is None:
        return None, None
    key = str(latest)
    if key not in _tej_cache:
        df = pd.read_excel(str(latest))
        cols = list(df.columns)
        # 固定以位置存取（不依賴中文欄名，避免編碼問題）
        # [0]=公司代碼 [1]=名稱 [2]=日期 [3]=行業別 [4]=SASB行業
        # [5]=E比率 [6]=S比率 [7]=G比率
        # [8]=ERS_E [9]=ERS_S [10]=ERS_G [11]=ERS總分
        # [12]=行業最高ERS [17]=同月年ERS變動
        df.columns = [
            "code", "name", "date", "industry", "sasb",
            "e_ratio", "s_ratio", "g_ratio",
            "ers_e", "ers_s", "ers_g", "ers_total",
            "industry_max_ers",
            "chg_1m", "chg_1mp", "chg_same_period", "chg_1y_month", "chg_1y",
        ] if len(cols) == 18 else cols
        df["code"] = df["code"].astype(str).str.zfill(4)
        _tej_cache.clear()
        _tej_cache[key] = df
    return _tej_cache[key], latest.name


@app.get("/api/tej/scores")
def get_tej_scores(codes: str = ""):
    """回傳指定公司代碼（逗號分隔）的 TEJ ERS 分數；不帶 codes 則回傳全部。"""
    df, filename = _load_tej_df()
    if df is None:
        raise HTTPException(status_code=404, detail="找不到 TEJ Excel 檔案")
    if codes:
        code_list = [c.strip().zfill(4) for c in codes.split(",") if c.strip()]
        df = df[df["code"].isin(code_list)]
    result = []
    for _, row in df.iterrows():
        result.append({
            "code": row["code"],
            "name": row.get("name", ""),
            "date": str(row.get("date", "")),
            "e_ratio": row.get("e_ratio"),
            "s_ratio": row.get("s_ratio"),
            "g_ratio": row.get("g_ratio"),
            "ers_e": row.get("ers_e"),
            "ers_s": row.get("ers_s"),
            "ers_g": row.get("ers_g"),
            "ers_total": row.get("ers_total"),
            "industry_max_ers": row.get("industry_max_ers"),
            "chg_1y": row.get("chg_1y"),
        })
    return {"filename": filename, "items": result}

