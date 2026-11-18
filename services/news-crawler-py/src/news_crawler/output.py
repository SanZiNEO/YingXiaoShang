"""Ingest sinks.

JSONL is the protocol boundary; SQLite is a local convenience so the existing
Electron app can read the rows before the Node ingest CLI exists.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Protocol

from .normalize import NormalizedArticle

NEWS_SCHEMA = """
CREATE TABLE IF NOT EXISTS news_articles (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL,
  title TEXT NOT NULL, url TEXT NOT NULL, author TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', content TEXT NOT NULL,
  content_status TEXT NOT NULL, rights TEXT NOT NULL, fetched_at TEXT NOT NULL,
  content_hash TEXT NOT NULL DEFAULT '', tag_content_hash TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS news_articles_by_url ON news_articles(url);
CREATE INDEX IF NOT EXISTS news_articles_by_published ON news_articles(published_at);
CREATE INDEX IF NOT EXISTS news_articles_by_tag_hash ON news_articles(tag_content_hash);
"""


class Sink(Protocol):
    async def emit(self, article: NormalizedArticle) -> str: ...

    async def close(self) -> None: ...


class JsonlSink:
    def __init__(self, path: Path, *, truncate: bool = False) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = asyncio.Lock()
        self._handle = self.path.open("w" if truncate else "a", encoding="utf-8")

    async def emit(self, article: NormalizedArticle) -> str:
        async with self._lock:
            self._handle.write(json.dumps(article.ingest.to_dict(), ensure_ascii=False) + "\n")
            self._handle.flush()
        return "inserted"

    async def close(self) -> None:
        self._handle.close()


class SQLiteSink:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(path)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.execute("PRAGMA busy_timeout=5000")
        self._connection.executescript(NEWS_SCHEMA)
        self._ensure_columns()
        self._lock = asyncio.Lock()

    def _ensure_columns(self) -> None:
        columns = {
            row["name"]
            for row in self._connection.execute("PRAGMA table_info(news_articles)").fetchall()
        }
        for column in ("content_hash", "tag_content_hash"):
            if column not in columns:
                self._connection.execute(
                    f"ALTER TABLE news_articles ADD COLUMN {column} TEXT NOT NULL DEFAULT ''"
                )

    def _has_table(self, name: str) -> bool:
        row = self._connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
        ).fetchone()
        return row is not None

    def _drop_drafts(self, article_id: str) -> None:
        for table, condition in (
            ("case_matches", "review_status='draft'"),
            ("news_tags", "review_status='draft'"),
        ):
            if self._has_table(table):
                self._connection.execute(
                    f"DELETE FROM {table} WHERE article_id=? AND {condition}", (article_id,)
                )
        if self._has_table("ideology_tags"):
            self._connection.execute(
                "DELETE FROM ideology_tags WHERE target_type='news_article' "
                "AND target_id=? AND review_status='draft'",
                (article_id,),
            )

    async def emit(self, article: NormalizedArticle) -> str:
        digest = hashlib.sha256(article.content.encode("utf-8")).hexdigest()
        async with self._lock:
            existing = self._connection.execute(
                "SELECT id, content_hash FROM news_articles WHERE url=?", (article.url,)
            ).fetchone()
            if existing and existing["content_hash"] == digest:
                self._connection.execute(
                    "UPDATE news_articles SET fetched_at=? WHERE id=?",
                    (article.fetched_at, existing["id"]),
                )
                self._connection.commit()
                return "skipped"
            if existing and existing["content_hash"] != digest:
                self._drop_drafts(existing["id"])
            self._connection.execute(
                """
                INSERT INTO news_articles (
                  id, source, source_id, title, url, author, published_at, summary, content,
                  content_status, rights, fetched_at, content_hash
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(url) DO UPDATE SET title=excluded.title, author=excluded.author,
                  published_at=excluded.published_at, summary=excluded.summary,
                  content=excluded.content, content_status=excluded.content_status,
                  rights=excluded.rights, fetched_at=excluded.fetched_at,
                  content_hash=excluded.content_hash
                """,
                (
                    article.id,
                    article.source,
                    article.source_id,
                    article.title,
                    article.url,
                    article.author,
                    article.published_at,
                    article.summary,
                    article.content,
                    article.content_status,
                    article.rights,
                    article.fetched_at,
                    digest,
                ),
            )
            self._connection.commit()
            return "updated" if existing else "inserted"

    async def close(self) -> None:
        self._connection.close()


class CompositeSink:
    def __init__(self, sinks: list[Sink]) -> None:
        self.sinks = sinks

    async def emit(self, article: NormalizedArticle) -> str:
        statuses = [await sink.emit(article) for sink in self.sinks]
        if "inserted" in statuses:
            return "inserted"
        if "updated" in statuses:
            return "updated"
        return statuses[0] if statuses else "skipped"

    async def close(self) -> None:
        for sink in self.sinks:
            await sink.close()
