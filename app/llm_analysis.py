from __future__ import annotations

import json
import os
from typing import Iterable

import google.generativeai as genai

from .models import Chunk


SYSTEM_INSTRUCTION = """
# Role
你是 ESG 審計專家與 NLP 分析師。請依據四維度新標準評估漂綠風險。

# 評估維度（固定四項）
1) selective_disclosure（選擇性揭露）
- 掃描四大模組共 20 項環境指標，估算已揭露項目數 D（0~20）與象徵性揭露項目數 S（0~D）。
- GWLS = 100 * (1 - D / 20)
- GWLE = 100 * (S / max(D,1))
- GWL = sqrt(GWLS * GWLE)
- selective_disclosure 分數 = clamp(round((GWLS + GWLE + GWL) / 3), 0, 100)

2) readability（文本可讀性）
- 統計：文本總字數 N、長句字數 L（連續>=15中文字且中間無標點）、複雜詞彙數 C。
- Modified Fog = 0.4 * ((L + C) / max(N,1))
- Read_Score = Fog / -100
- readability 分數（風險）= clamp(round(min(1.0, Fog) * 100), 0, 100)

3) greenwashing_language（漂綠語言使用）
- 統計：總詞彙 T、正向吹捧分 P、風險/客觀事實分 R。
- Comparative Sentiment = (P - R) / max(T,1)
- greenwashing_language 分數 = clamp(round((Comparative Sentiment + 0.2) / 0.4 * 100), 0, 100)
  （分數越高表示語氣操弄越明顯）

4) target_gap（目標與現況落差）
- 統計：總字數 W、量化詞彙數 Num、時程詞彙數 Hor。
- RATIO_NUM = Num / max(W,1)
- RATIO_HOR = Hor / max(W,1)
- target_gap 分數 = clamp(round((1 - min(1, (RATIO_NUM + RATIO_HOR) / 0.08)) * 100), 0, 100)
  （缺少數字與期限時分數高）

# 附件關鍵字詞典（務必套用）
## A. 文本可讀性（readability）
文本可讀性「不使用關鍵字詞典」，僅依公式計算：
- 總字數 N
- 長句字數 L（連續>=15中文字且中間無標點）
- 複雜詞彙數 C（四字成語與生僻冗長術語，由模型語義判定）

## B. 漂綠語言（greenwashing_language）
請使用外部詞典檔：
- `backend/app/dictionaries/appendix_a_keywords.txt`

並套用其中：
- Appendix A.1 Greenwashing Dictionary
- Appendix A.2 Environmental Dictionary
- Appendix A.3 Social Dictionary
- Appendix A.4 Governance Dictionary

注意：同一詞在不同語境可正可負，需依上下文判定權重，不能只做機械計數。

## C. 目標與現況落差（target_gap）時程詞彙
Horizon_Count 除年份（如 2030、2050）外，還需納入：
[
  "短期", "中期", "長期", "未來三年", "未來五年", "未來十年", "下一階段",
  "路徑圖", "時間表", "milestone", "roadmap", "by 2030", "by 2050"
]

# 統一輸出規格（JSON Only）
{
  "overall_risk_level": "極高" | "高" | "中" | "低",
  "overall_risk_score": number,
  "scoring": {
    "selective_disclosure": number,
    "readability": number,
    "greenwashing_language": number,
    "target_gap": number
  },
  "evidence_summary": [
    { "quote": "原文句子", "page": number, "dimension": "selective_disclosure|readability|greenwashing_language|target_gap", "analysis": "判定理由" }
  ],
  "red_flags": ["重點警示1", "重點警示2"]
}

只輸出合法 JSON，不得輸出其他文字。
"""


CHAT_SYSTEM_INSTRUCTION = """
你是一位專業的 ESG 報告分析師與永續金融顧問。

- 你會閱讀提供的 ESG 報告節錄內容，協助使用者理解是否存在漂綠風險。
- 回答時請使用繁體中文，語氣專業但易懂，嚴格限制在 50 字以內。
- 盡量引用報告中的具體數據、目標與頁碼（如果有提供）。
- 如果資訊不足以下結論，要清楚說明還缺少哪些關鍵資訊。
"""


def _build_model() -> genai.GenerativeModel:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("缺少 GEMINI_API_KEY 環境變數（用於 Google Generative AI）")
    genai.configure(api_key=api_key)
    return genai.GenerativeModel(
        model_name="gemini-2.5-flash",
        system_instruction=SYSTEM_INSTRUCTION,
        generation_config={"response_mime_type": "application/json"},
    )


def _build_chat_model() -> genai.GenerativeModel:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("缺少 GEMINI_API_KEY 環境變數（用於 Google Generative AI）")
    genai.configure(api_key=api_key)
    return genai.GenerativeModel(
        model_name="gemini-2.5-flash",
        system_instruction=CHAT_SYSTEM_INSTRUCTION,
    )


def run_greenwashing_detector_from_chunks(chunks: Iterable[Chunk]) -> dict:
    """
    從資料庫中的 Chunk 產生合併文本，呼叫 Gemini 做進階漂綠分析。
    回傳值為已解析的 JSON dict，結構遵守 SYSTEM_INSTRUCTION 中的說明。
    """
    chunks_list = list(chunks)
    if not chunks_list:
        raise ValueError("沒有可用的 chunks 供分析")

    # 簡單控制長度：優先取前幾個 chunk，直到字數上限
    max_chars = 12000
    buf: list[str] = []
    total = 0
    for c in chunks_list:
        snippet = c.text.strip()
        if not snippet:
            continue
        part = f"[Page {c.page_start}-{c.page_end}]: {snippet}"
        if total + len(part) > max_chars and total > 0:
            break
        buf.append(part)
        total += len(part)

    combined_text = "\n\n".join(buf)

    model = _build_model()
    resp = model.generate_content(f"請分析以下 ESG 報告書節錄內容：\n\n{combined_text}")

    # resp.text 已為 JSON 字串
    return json.loads(resp.text)


def run_chat_on_chunks(
    question: str,
    chunks: Iterable[Chunk],
    history: list[dict] | None = None,
) -> dict:
    """
    針對使用者提問與指定報告 chunks，使用 Gemini 產生自然語言回答。
    回傳 {"answer": str, "cited_pages": list[int]}
    """
    chunks_list = list(chunks)
    if not chunks_list:
        raise ValueError("沒有可用的 chunks 供聊天")

    max_chars = 9000
    buf: list[str] = []
    total = 0
    for c in chunks_list:
        snippet = c.text.strip()
        if not snippet:
            continue
        part = f"[Page {c.page_start}-{c.page_end}]: {snippet}"
        if total + len(part) > max_chars and total > 0:
            break
        buf.append(part)
        total += len(part)

    context = "\n\n".join(buf)
    model = _build_chat_model()

    # 組合對話歷史段落
    history_block = ""
    if history:
        lines = []
        for turn in history[-8:]:   # 最多帶入最近 8 輪
            role_label = "使用者" if turn.get("role") == "user" else "助理"
            lines.append(f"{role_label}：{turn.get('content', '')}")
        history_block = "=== 之前的對話 ===\n" + "\n".join(lines) + "\n\n"

    prompt = (
        "以下是某家公司 ESG 報告中的節錄段落（已標註頁碼）。\n"
        "請根據這些內容，回答使用者的問題。答案要具體、可追溯，"
        "並在回答中自然地引用頁碼（例如：根據第 10 頁…）。\n\n"
        f"=== 報告節錄 ===\n{context}\n\n"
        f"{history_block}"
        f"=== 使用者問題 ===\n{question}\n\n"
        "回答完畢後，請在最後一行單獨輸出 JSON，格式：\n"
        '{"cited_pages": [頁碼1, 頁碼2, ...]}\n'
        "只列出你實際引用的頁碼，最多 5 個。"
    )
    resp = model.generate_content(prompt)
    raw = resp.text.strip()

    # 嘗試從最後一行解析 cited_pages
    cited_pages: list[int] = []
    lines = raw.splitlines()
    for line in reversed(lines):
        line = line.strip()
        if line.startswith("{") and "cited_pages" in line:
            try:
                parsed = json.loads(line)
                cited_pages = [int(p) for p in parsed.get("cited_pages", []) if str(p).isdigit()]
                # 把這行 JSON 從顯示文字中去掉
                raw = "\n".join(ln for ln in lines if ln.strip() != line).strip()
            except Exception:
                pass
            break

    return {"answer": raw, "cited_pages": cited_pages}

