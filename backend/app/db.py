from __future__ import annotations

from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker


DATA_DIR = Path(__file__).resolve().parents[2] / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = DATA_DIR / "verigreen.db"
engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


class Base(DeclarativeBase):
    pass


def init_db() -> None:
    from . import models  # noqa: F401

    Base.metadata.create_all(bind=engine)

    # 對既有資料庫做欄位補齊（create_all 不會修改已存在的資料表）
    with engine.connect() as conn:
        for col_def in ("dashboard_url TEXT",):
            col_name = col_def.split()[0]
            try:
                conn.execute(
                    __import__("sqlalchemy").text(
                        f"ALTER TABLE companies ADD COLUMN {col_def}"
                    )
                )
                conn.commit()
            except Exception:
                pass  # 欄位已存在時忽略

