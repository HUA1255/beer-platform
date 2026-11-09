"""录音记录的持久化（SQLite）。每一步状态变化都立刻落库，进程重启后可续跑。"""

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

# 五步进度：上传 → 排队 → 转写 → 摘要 → 入库
STEPS = [("upload", "上传"), ("queue", "排队"), ("transcribe", "转写"), ("summarize", "摘要"), ("store", "入库")]
STEP_KEYS = [k for k, _ in STEPS]

_COLUMNS = {
    "id": "TEXT PRIMARY KEY",
    "filename": "TEXT NOT NULL",
    "original_path": "TEXT NOT NULL",
    "created_at": "TEXT NOT NULL",
    "updated_at": "TEXT NOT NULL",
    "steps": "TEXT NOT NULL",
    "asr_task_id": "TEXT",
    "asr_status": "TEXT",
    "progress": "REAL",
    "error_code": "TEXT",
    "error": "TEXT",
    "transcript_md": "TEXT",
    "transcript_srt": "TEXT",
    "summary": "TEXT",
    "summary_type": "TEXT",
    "mail_error": "TEXT",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        cols = ", ".join(f"{k} {v}" for k, v in _COLUMNS.items())
        self._db.execute(f"CREATE TABLE IF NOT EXISTS recordings ({cols})")
        self._migrate()

    def _migrate(self) -> None:
        """老库补新列（#20 的 summary_type / mail_error），不丢已有录音。"""
        existing = {row["name"] for row in self._db.execute("PRAGMA table_info(recordings)")}
        for name, decl in _COLUMNS.items():
            if name not in existing:
                self._db.execute(f"ALTER TABLE recordings ADD COLUMN {name} {decl}")

    def close(self) -> None:
        self._db.close()

    def create(self, rec_id: str, filename: str, original_path: Path) -> dict:
        steps = {k: "pending" for k in STEP_KEYS} | {"upload": "done"}
        now = _now()
        with self._lock:
            self._db.execute(
                "INSERT INTO recordings (id, filename, original_path, created_at, updated_at, steps)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (rec_id, filename, str(original_path), now, now, json.dumps(steps)),
            )
        return self.get(rec_id)

    def get(self, rec_id: str) -> dict | None:
        with self._lock:
            row = self._db.execute("SELECT * FROM recordings WHERE id = ?", (rec_id,)).fetchone()
        return _decode(row) if row else None

    def all(self) -> list[dict]:
        with self._lock:
            rows = self._db.execute("SELECT * FROM recordings ORDER BY created_at DESC, rowid DESC").fetchall()
        return [_decode(r) for r in rows]

    def update(self, rec_id: str, **fields) -> None:
        if "steps" in fields:
            fields["steps"] = json.dumps(fields["steps"])
        fields["updated_at"] = _now()
        sets = ", ".join(f"{k} = ?" for k in fields)
        with self._lock:
            self._db.execute(f"UPDATE recordings SET {sets} WHERE id = ?", (*fields.values(), rec_id))

    def delete(self, rec_id: str) -> None:
        with self._lock:
            self._db.execute("DELETE FROM recordings WHERE id = ?", (rec_id,))

    def set_step(self, rec_id: str, step: str, status: str, **fields) -> None:
        steps = self.get(rec_id)["steps"]
        steps[step] = status
        self.update(rec_id, steps=steps, **fields)


def _decode(row: sqlite3.Row) -> dict:
    rec = dict(row)
    rec["steps"] = json.loads(rec["steps"])
    return rec
