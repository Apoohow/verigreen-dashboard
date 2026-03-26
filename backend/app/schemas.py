from __future__ import annotations

from pydantic import BaseModel, Field


class CompanyListItem(BaseModel):
    company_id: str
    name: str
    ticker: str | None = None
    industry: str | None = None
    latest_report_year: int | None = None
    latest_overall_score: int | None = None
    latest_risk_level: str | None = None


class CompaniesResponse(BaseModel):
    items: list[CompanyListItem]
    total: int


class UploadReportResponse(BaseModel):
    report_id: str
    status: str


class ReportStatusResponse(BaseModel):
    report_id: str
    company_id: str
    year: int | None = None
    pages: int | None = None
    status: str
    progress: dict[str, int] | None = None


class BreakdownItem(BaseModel):
    reason: str
    weight: float = Field(ge=0, le=1)
    score_contribution: int


class KeyMetricItem(BaseModel):
    metric: str
    target: str
    actual: str
    gap: str
    status: str


class AnalysisResponse(BaseModel):
    overall_score: int
    risk_level: str
    breakdown: list[BreakdownItem]
    key_metrics: list[KeyMetricItem]
    dimension_scores: dict[str, int]


class Citation(BaseModel):
    chunk_id: str
    page_number: int
    quote: str
    confidence: float | None = None


class EvidenceItemResponse(BaseModel):
    evidence_id: str
    dimension: str
    claim: str
    severity: int
    citations: list[Citation]


class EvidenceResponse(BaseModel):
    items: list[EvidenceItemResponse]


class PageResponse(BaseModel):
    page_number: int
    text: str
    highlights: list[str] | None = None


class ChatHistoryItem(BaseModel):
    role: str          # "user" | "assistant"
    content: str


class ChatRequest(BaseModel):
    session_id: str | None = None
    message: str
    history: list[ChatHistoryItem] = []   # 前端傳來的對話歷史（最近 N 輪）


class ChatResponse(BaseModel):
    session_id: str
    answer: str
    citations: list[Citation]
    suggested_questions: list[str] | None = None

