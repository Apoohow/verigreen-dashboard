"""一次性檢查 GEMINI_API_KEY 與 API 是否可用（不印出金鑰）。"""
from __future__ import annotations

import os
import sys
from pathlib import Path


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    load_dotenv(root / ".env")
    key = (os.getenv("GEMINI_API_KEY") or "").strip()
    if not key:
        print("結果: GEMINI_API_KEY 未在 .env 中找到或為空")
        return 1
    print(f"結果: GEMINI_API_KEY 已設定（長度 {len(key)} 字元）")

    try:
        import google.generativeai as genai
    except ImportError as e:
        print("結果: 未安裝 google-generativeai —", e)
        return 2

    try:
        genai.configure(api_key=key)
        model = genai.GenerativeModel("gemini-2.5-flash")
        r = model.generate_content("只回覆一個字: OK")
        text = (getattr(r, "text", None) or "").strip()[:120]
        print("API 呼叫: 成功")
        print("模型回覆片段:", repr(text))
        return 0
    except Exception as e:
        err = str(e)
        low = err.lower()
        print("API 呼叫: 失敗")
        print("錯誤類型:", type(e).__name__)
        if "429" in err or "quota" in low or "resource exhausted" in low:
            print("判讀: 較像配額 / 速率限制 (quota / rate limit)")
        elif "401" in err or "403" in err or ("api" in low and "invalid" in low):
            print("判讀: 較像 API Key 無效或權限問題")
        elif "billing" in low or "payment" in low:
            print("判讀: 較像計費 / 付款相關")
        print("訊息摘要:", err[:800])
        return 3


if __name__ == "__main__":
    sys.exit(main())
