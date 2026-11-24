"""SQLite 文档存储：每个集合一张逻辑表，数据为 JSON；带 rev 乐观锁，便于后续迁移到 PostgreSQL JSONB。"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path


class Conflict(Exception):
    """文档在读取之后被他人修改。"""

    def __init__(self, current):
        super().__init__("conflict")
        self.current = current


def now() -> float:
    return time.time()


def new_id(prefix: str = "") -> str:
    return prefix + uuid.uuid4().hex[:16]


class Store:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self._lock = threading.RLock()
        with self._conn() as c:
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("""CREATE TABLE IF NOT EXISTS docs(
                col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
                rev INTEGER NOT NULL DEFAULT 1, created REAL NOT NULL, updated REAL NOT NULL,
                PRIMARY KEY(col, id))""")
            c.execute("CREATE INDEX IF NOT EXISTS docs_col ON docs(col, created)")

    def _conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.path, timeout=30, check_same_thread=False)
            self._local.conn = conn
        return conn

    @staticmethod
    def _row(r):
        d = json.loads(r[0])
        d["id"], d["_rev"], d["_created"], d["_updated"] = r[1], r[2], r[3], r[4]
        return d

    def get(self, col: str, id: str):
        r = self._conn().execute("SELECT data,id,rev,created,updated FROM docs WHERE col=? AND id=?", (col, id)).fetchone()
        return self._row(r) if r else None

    def list(self, col: str, **eq):
        rows = self._conn().execute("SELECT data,id,rev,created,updated FROM docs WHERE col=? ORDER BY created", (col,)).fetchall()
        out = [self._row(r) for r in rows]
        if eq:
            out = [d for d in out if all(d.get(k) == v for k, v in eq.items())]
        return out

    def insert(self, col: str, data: dict, id: str | None = None):
        id = id or data.get("id") or new_id()
        body = {k: v for k, v in data.items() if not k.startswith("_") and k != "id"}
        t = now()
        with self._lock, self._conn() as c:
            c.execute("INSERT INTO docs(col,id,data,rev,created,updated) VALUES(?,?,?,?,?,?)",
                      (col, id, json.dumps(body, ensure_ascii=False), 1, t, t))
        return self.get(col, id)

    def update(self, col: str, id: str, changes: dict, if_rev: int | None = None):
        with self._lock, self._conn() as c:
            cur = self.get(col, id)
            if cur is None:
                raise KeyError(id)
            if if_rev is not None and int(if_rev) != cur["_rev"]:
                raise Conflict(cur)
            body = {k: v for k, v in cur.items() if not k.startswith("_") and k != "id"}
            body.update({k: v for k, v in changes.items() if not k.startswith("_") and k != "id"})
            c.execute("UPDATE docs SET data=?, rev=rev+1, updated=? WHERE col=? AND id=?",
                      (json.dumps(body, ensure_ascii=False), now(), col, id))
        return self.get(col, id)

    def delete(self, col: str, id: str):
        with self._lock, self._conn() as c:
            c.execute("DELETE FROM docs WHERE col=? AND id=?", (col, id))
