"""TLS 驗證：Linux/Render 上部分站點憑證鏈與 OpenSSL 3 不相容時可設 ESG_CSR_INSECURE_SSL=1。"""

from __future__ import annotations

import os


def get_requests_verify():  # bool | str
    if os.getenv("ESG_CSR_INSECURE_SSL", "").strip().lower() in {"1", "true", "yes", "on"}:
        return False
    try:
        import certifi

        return certifi.where()
    except Exception:
        return True
