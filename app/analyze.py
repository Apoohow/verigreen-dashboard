from __future__ import annotations

import random
import re
from typing import Iterable


DIMENSIONS = [
    "selective_disclosure",
    "readability",
    "greenwashing_language",
    "target_gap",
]


VAGUE_PATTERNS = [
    "致力於",
    "我們致力",
    "我們熱愛地球",
    "積極推動",
    "持續精進",
    "努力達成",
]


def _risk_level(score: int) -> str:
    if score >= 70:
        return "high"
    if score >= 30:
        return "moderate"
    return "low"


def _first_percent(text: str) -> str | None:
    """從文字中抓出第一個百分比表示。"""
    m = re.search(r"\d{1,3}(?:\.\d+)?\s*%", text)
    return m.group(0) if m else None


def _find_snippet(chunks: list[dict], keywords: list[str]) -> str:
    """在 chunks 中找到第一個含指定關鍵字的段落。"""
    for c in chunks:
        txt = c.get("text", "")
        if any(k in txt for k in keywords):
            return txt
    return ""


def _build_key_metrics(chunks: list[dict]) -> list[dict]:
    """
    從實際報告文字中粗略抽出三個代表性指標：
    - 2030 減碳目標
    - 再生能源占比
    - 用水效率

    目前採用 rule-based 抽取：
    - 先找包含關鍵字的段落
    - 嘗試抓出百分比
    - 根據是否提到「基準年」等字樣給出簡單狀態
    """
    if not chunks:
        return [
            {
                "metric": "2030 減碳目標",
                "target": "—",
                "actual": "尚未上傳或尚未解析到任何文本。",
                "gap": "—",
                "status": "warning",
            },
            {
                "metric": "再生能源占比",
                "target": "—",
                "actual": "尚未上傳或尚未解析到任何文本。",
                "gap": "—",
                "status": "warning",
            },
            {
                "metric": "用水效率",
                "target": "—",
                "actual": "尚未上傳或尚未解析到任何文本。",
                "gap": "—",
                "status": "warning",
            },
        ]

    def build_one(title: str, kw: list[str]) -> dict:
        snippet = _find_snippet(chunks, kw)
        pct = _first_percent(snippet) if snippet else None
        has_baseline = any(w in snippet for w in ["基準年", "base year", "baseline"]) if snippet else False

        if snippet:
            short = snippet.strip().replace("\n", " ")
            if len(short) > 96:
                short = short[:96] + "…"
        else:
            short = "未在報告中找到明確相關段落。"

        if pct and has_baseline:
            gap = "具體目標與基準年皆有揭露。"
            status = "ok"
        elif pct:
            gap = "有提到數值目標，但缺少清楚的基準年或範圍說明。"
            status = "warning"
        else:
            gap = "缺少可量化指標或百分比描述。"
            status = "warning"

        return {
            "metric": title,
            "target": pct or "未找到明確百分比",
            "actual": short,
            "gap": gap,
            "status": status,
        }

    return [
        build_one("2030 減碳目標", ["2030", "減碳", "碳排", "溫室氣體", "GHG"]),
        build_one("再生能源占比", ["再生能源", "再生電力", "綠電", "可再生能源", "renewable"]),
        build_one("用水效率", ["用水", "耗水", "水資源", "節水"]),
    ]


def score_report(chunks: Iterable[dict]) -> dict:
    """
    MVP：用簡單 heuristics 產生可展示的分數、拆解、evidence。
    後續可替換為：
    - 維度種子 query + 向量檢索
    - LLM 判定 + citations
    """
    chunks_list = list(chunks)

    # base score seeded from content size for stability-ish
    base = min(80, max(20, int(len(chunks_list) ** 0.5 * 15)))
    jitter = random.randint(-6, 6)
    overall = max(0, min(100, base + jitter))

    dim_scores = {d: max(0, min(100, overall + random.randint(-15, 15))) for d in DIMENSIONS}

    breakdown = [
        {"reason": "選擇性揭露",   "weight": 0.25, "score_contribution": int(overall * 0.25)},
        {"reason": "文本可讀性",   "weight": 0.25, "score_contribution": int(overall * 0.25)},
        {"reason": "漂綠語言使用", "weight": 0.25, "score_contribution": int(overall * 0.25)},
        {"reason": "目標與現況落差", "weight": 0.25, "score_contribution": int(overall * 0.25)},
    ]

    # 從實際 chunks 文本中產生 key metrics（不再使用純示範文字）
    key_metrics = _build_key_metrics(chunks_list)

    evidence = []
    for c in chunks_list:
        txt = c["text"]
        if any(p in txt for p in VAGUE_PATTERNS):
            quote = txt[:450].strip()
            evidence.append(
                {
                    "dimension": "greenwashing_language",
                    "claim": "段落使用較多模糊承諾用語，但缺少可量化指標或基準年。",
                    "severity": 70,
                    "citations": [
                        {
                            "chunk_id": c.get("chunk_id", "pending"),
                            "page_number": int(c.get("page_start", 1)),
                            "quote": quote,
                            "confidence": 0.55,
                        }
                    ],
                }
            )
        if len(evidence) >= 6:
            break

    if not evidence and chunks_list:
        c = chunks_list[0]
        evidence.append(
            {
                "dimension": "target_gap",
                "claim": "目前尚未在樣本段落中找到明確可疑語句，建議擴大掃描範圍或檢視其他維度。",
                "severity": 35,
                "citations": [
                    {
                        "chunk_id": c.get("chunk_id", "pending"),
                        "page_number": int(c.get("page_start", 1)),
                        "quote": c["text"][:450].strip(),
                        "confidence": 0.3,
                    }
                ],
            }
        )

    return {
        "overall_score": overall,
        "risk_level": _risk_level(overall),
        "dimension_scores": dim_scores,
        "breakdown": breakdown,
        "key_metrics": key_metrics,
        "evidence": evidence,
    }

