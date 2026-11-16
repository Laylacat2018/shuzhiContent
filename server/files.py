"""Workspace-scoped immutable files. SQLite stores metadata; paths never come from clients."""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from pathlib import Path


class Files:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.db_path = self.root / "files.sqlite3"
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, name TEXT NOT NULL, path TEXT UNIQUE NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, media_type TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)")
            db.execute("CREATE INDEX IF NOT EXISTS files_workspace ON files(workspace)")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.db_path, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")
        try:
            with db:yield db
        finally:db.close()

    def put(self, workspace: str, name: str, source: Path | bytes, media_type: str = "application/octet-stream") -> dict:
        fid = uuid.uuid4().hex
        name = Path(name.replace("\\", "/")).name[:180]
        if not name:
            raise ValueError("文件名为空")
        dest = self.root / "objects" / fid[:2] / fid
        dest.parent.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256()
        with dest.open("xb") as out:
            if isinstance(source, bytes):
                digest.update(source); out.write(source)
            else:
                with source.open("rb") as inp:
                    while chunk := inp.read(1024 * 1024):
                        digest.update(chunk); out.write(chunk)
            out.flush(); os.fsync(out.fileno())
        row = dict(id=fid, workspace=workspace, name=name, path=str(dest.relative_to(self.root)), sha256=digest.hexdigest(), size=dest.stat().st_size, media_type=media_type)
        with self.connect() as db:
            db.execute("INSERT INTO files(id,workspace,name,path,sha256,size,media_type) VALUES(:id,:workspace,:name,:path,:sha256,:size,:media_type)", row)
        return self.public(row)

    def get(self, workspace: str, fid: str) -> dict:
        with self.connect() as db:
            row = db.execute("SELECT * FROM files WHERE id=? AND workspace=?", (fid, workspace)).fetchone()
        if row is None:
            raise FileNotFoundError("文件不存在或不属于当前工作区")
        return dict(row)

    def path(self, workspace: str, fid: str) -> Path:
        p = (self.root / self.get(workspace, fid)["path"]).resolve()
        if not p.is_relative_to(self.root) or not p.is_file():
            raise FileNotFoundError("文件不存在")
        return p

    def verify(self, workspace: str, fid: str) -> dict:
        row = self.get(workspace, fid)
        with self.path(workspace, fid).open("rb") as inp:
            sha = hashlib.file_digest(inp, "sha256").hexdigest()
        if sha != row["sha256"]:
            raise ValueError("文件校验失败，原始文件已被修改")
        return row

    @staticmethod
    def public(row: dict) -> dict:
        return {"file_id": row["id"], "name": row["name"], "sha256": row["sha256"], "size": row["size"], "url": "/api/v1/files/" + row["id"]}
