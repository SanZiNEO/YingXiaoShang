"""Ingest sinks.

JSONL is the protocol boundary; SQLite is a local convenience so the existing
Electron app can read the rows before the Node ingest CLI exists.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
from typing import Protocol

from . import db
from .normalize import NormalizedArticle


class Sink(Protocol):
    #: True only for sinks that can tell a re-crawl from a first insert.
    reports_dedup: bool

    async def emit(self, article: NormalizedArticle) -> str: ...

    async def close(self) -> None: ...


class JsonlSink:
    reports_dedup = False

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
    """Writes articles through the shared schema owned by :mod:`news_crawler.db`.

    The schema, indexes and any column migrations live in ``db.py``; this sink
    only owns the per-row upsert semantics: unique URL, ``content_hash`` change
    drops stale drafts, and the returned status is inserted / updated / skipped.
    """

    reports_dedup = True

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._connection = db.connect(self.path)
        self._lock = asyncio.Lock()

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
    """Fan-out sink.

    Only sinks that actually deduplicate may report the row status: the JSONL
    sink always says "inserted", so letting it win would report a re-crawl of an
    already-stored article as a fresh insert and make the run statistics lie.
    """

    def __init__(self, sinks: list[Sink]) -> None:
        self.sinks = sinks
        self.reports_dedup = any(getattr(sink, "reports_dedup", False) for sink in sinks)

    async def emit(self, article: NormalizedArticle) -> str:
        statuses = [(sink, await sink.emit(article)) for sink in self.sinks]
        dedup = [status for sink, status in statuses if getattr(sink, "reports_dedup", False)]
        if dedup:
            if "inserted" in dedup:
                return "inserted"
            if "updated" in dedup:
                return "updated"
            return "skipped"
        return statuses[0][1] if statuses else "skipped"

    async def close(self) -> None:
        for sink in self.sinks:
            await sink.close()
