from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from pypdf import PdfReader


@dataclass(frozen=True)
class PageText:
    page_number: int
    text: str


def extract_pages(pdf_path: Path) -> tuple[int, list[PageText]]:
    reader = PdfReader(str(pdf_path))
    pages: list[PageText] = []
    for i, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        pages.append(PageText(page_number=i, text=text.strip()))
    return len(reader.pages), pages


def chunk_pages(pages: list[PageText], *, max_chars: int = 2500, min_chars: int = 800) -> list[dict]:
    """
    簡化版 chunking：
    - 以頁面文字為基礎，按字元長度切塊
    - 每塊保留 page_start/page_end
    """
    chunks: list[dict] = []
    buf: list[str] = []
    buf_len = 0
    page_start = None
    page_end = None

    def flush() -> None:
        nonlocal buf, buf_len, page_start, page_end
        if not buf:
            return
        text = "\n".join(buf).strip()
        if text:
            chunks.append(
                {
                    "page_start": int(page_start or 1),
                    "page_end": int(page_end or (page_start or 1)),
                    "text": text,
                    "char_count": len(text),
                }
            )
        buf = []
        buf_len = 0
        page_start = None
        page_end = None

    for p in pages:
        if page_start is None:
            page_start = p.page_number
        page_end = p.page_number

        t = p.text
        if not t:
            continue

        if buf_len + len(t) > max_chars and buf_len >= min_chars:
            flush()
            page_start = p.page_number
            page_end = p.page_number

        buf.append(t)
        buf_len += len(t)

    flush()
    return chunks

