from __future__ import annotations

import datetime as dt
import uuid

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def _uuid() -> str:
    return str(uuid.uuid4())


class Company(Base):
    __tablename__ = "companies"

    company_id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String, index=True)
    ticker: Mapped[str | None] = mapped_column(String, index=True, nullable=True)
    industry: Mapped[str | None] = mapped_column(String, index=True, nullable=True)
    dashboard_url: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow)

    reports: Mapped[list["Report"]] = relationship(back_populates="company")


class User(Base):
    __tablename__ = "users"

    user_id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    google_sub: Mapped[str] = mapped_column(String, unique=True, index=True)
    email: Mapped[str] = mapped_column(String, unique=True, index=True)
    name: Mapped[str | None] = mapped_column(String, nullable=True)
    picture: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow)
    last_login_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow)

    sessions: Mapped[list["AuthSession"]] = relationship(back_populates="user")


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    session_id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.user_id"), index=True)
    session_token: Mapped[str] = mapped_column(String, unique=True, index=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow)
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime, index=True)
    revoked_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True, index=True)

    user: Mapped["User"] = relationship(back_populates="sessions")


class OAuthState(Base):
    """Google OAuth CSRF state（Safari／手機常不帶跨站 Cookie，改存 DB 驗證）。"""

    __tablename__ = "oauth_states"

    state: Mapped[str] = mapped_column(String, primary_key=True)
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime, index=True)


class Report(Base):
    __tablename__ = "reports"

    report_id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    company_id: Mapped[str] = mapped_column(String, ForeignKey("companies.company_id"), index=True)
    year: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    source_pdf_path: Mapped[str] = mapped_column(String)
    pages: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String, default="uploaded", index=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow)

    company: Mapped["Company"] = relationship(back_populates="reports")
    pages_text: Mapped[list["ReportPage"]] = relationship(back_populates="report", cascade="all, delete-orphan")
    chunks: Mapped[list["Chunk"]] = relationship(back_populates="report", cascade="all, delete-orphan")
    analysis: Mapped["Analysis | None"] = relationship(back_populates="report", cascade="all, delete-orphan")


class ReportPage(Base):
    __tablename__ = "report_pages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    report_id: Mapped[str] = mapped_column(String, ForeignKey("reports.report_id"), index=True)
    page_number: Mapped[int] = mapped_column(Integer, index=True)
    text: Mapped[str] = mapped_column(Text)

    report: Mapped["Report"] = relationship(back_populates="pages_text")


class Chunk(Base):
    __tablename__ = "chunks"

    chunk_id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    report_id: Mapped[str] = mapped_column(String, ForeignKey("reports.report_id"), index=True)
    company_id: Mapped[str] = mapped_column(String, index=True)
    year: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    industry: Mapped[str | None] = mapped_column(String, index=True, nullable=True)
    page_start: Mapped[int] = mapped_column(Integer)
    page_end: Mapped[int] = mapped_column(Integer)
    section: Mapped[str | None] = mapped_column(String, nullable=True)
    text: Mapped[str] = mapped_column(Text)
    char_count: Mapped[int] = mapped_column(Integer)

    report: Mapped["Report"] = relationship(back_populates="chunks")


class Analysis(Base):
    __tablename__ = "analyses"

    analysis_id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    report_id: Mapped[str] = mapped_column(String, ForeignKey("reports.report_id"), unique=True, index=True)
    overall_score: Mapped[int] = mapped_column(Integer)
    risk_level: Mapped[str] = mapped_column(String, index=True)
    dimension_scores: Mapped[dict] = mapped_column(JSON)
    breakdown: Mapped[list] = mapped_column(JSON)
    key_metrics: Mapped[list] = mapped_column(JSON)
    generated_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow)
    model_version: Mapped[str | None] = mapped_column(String, nullable=True)

    report: Mapped["Report"] = relationship(back_populates="analysis")
    evidence_items: Mapped[list["EvidenceItem"]] = relationship(
        back_populates="analysis", cascade="all, delete-orphan"
    )


class EvidenceItem(Base):
    __tablename__ = "evidence_items"

    evidence_id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    analysis_id: Mapped[str] = mapped_column(String, ForeignKey("analyses.analysis_id"), index=True)
    dimension: Mapped[str] = mapped_column(String, index=True)
    claim: Mapped[str] = mapped_column(Text)
    severity: Mapped[int] = mapped_column(Integer)  # 0..100
    citations: Mapped[list] = mapped_column(JSON)

    analysis: Mapped["Analysis"] = relationship(back_populates="evidence_items")

