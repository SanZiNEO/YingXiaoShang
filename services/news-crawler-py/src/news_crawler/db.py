"""SQLite ingest boundary for the Python crawler.

Two tables matter here:

* `news_articles` -- the ingest target (news-ingest/v1 rows). `url` is unique,
  so re-crawling an article updates instead of duplicating; `content_hash`
  changes when the body changed, which is what triggers re-tagging downstream.
* `source_runs` -- one row per source run, the collection statistics the service
  and the health endpoint read back.

Everything that writes or reads the database goes through this module, so the
crawler, the scheduler and the AI query facade share one schema and one DAL.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

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

STATS_SCHEMA = """
CREATE TABLE IF NOT EXISTS source_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  fetched INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  failures TEXT NOT NULL DEFAULT '[]'
) STRICT;
CREATE INDEX IF NOT EXISTS source_runs_by_source ON source_runs(source, started_at);
CREATE INDEX IF NOT EXISTS source_runs_by_started ON source_runs(started_at);
"""

SCHEMA = NEWS_SCHEMA + STATS_SCHEMA

COLUMN_ADDITIONS = (
    ("news_articles", "content_hash", "TEXT NOT NULL DEFAULT ''"),
    ("news_articles", "tag_content_hash", "TEXT NOT NULL DEFAULT ''"),
)


def connect(path: Path | str) -> sqlite3.Connection:
    """Open (and initialise) the shared database. Safe to call from many tasks."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(target, check_same_thread=False)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA busy_timeout=5000")
    connection.executescript(SCHEMA)
    _ensure_columns(connection)
    return connection


def _ensure_columns(connection: sqlite3.Connection) -> None:
    for table, column, ddl in COLUMN_ADDITIONS:
        existing = {
            row["name"] for row in connection.execute(f"PRAGMA table_info({table})").fetchall()
        }
        if column not in existing:
            connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


def has_table(connection: sqlite3.Connection, name: str) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row is not None


@dataclass(slots=True)
class RunRecord:
    source: str
    status: str
    started_at: str
    finished_at: str
    duration_ms: int
    fetched: int
    inserted: int
    updated: int
    skipped: int
    errors: int
    failures: list[dict[str, str]]
    trigger: str = "manual"


def record_run(connection: sqlite3.Connection, record: RunRecord) -> None:
    connection.execute(
        """
        INSERT INTO source_runs (
          source, trigger, status, started_at, finished_at, duration_ms,
          fetched, inserted, updated, skipped, errors, failures
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            record.source,
            record.trigger,
            record.status,
            record.started_at,
            record.finished_at,
            record.duration_ms,
            record.fetched,
            record.inserted,
            record.updated,
            record.skipped,
            record.errors,
            json.dumps(record.failures, ensure_ascii=False),
        ),
    )
    connection.commit()


def run_from_result(result: Any, trigger: str = "manual") -> RunRecord:
    """Adapt a `SourceRunResult` (kept loose to avoid a circular import)."""
    started = result.started_at.isoformat()
    finished = datetime.now(UTC).isoformat()
    return RunRecord(
        source=result.source,
        status=result.status.value,
        started_at=started,
        finished_at=finished,
        duration_ms=result.duration_ms,
        fetched=result.fetched,
        inserted=result.inserted,
        updated=result.updated,
        skipped=result.skipped,
        errors=result.errors,
        failures=[
            {"stage": failure.stage.value, "message": failure.message, "url": failure.url}
            for failure in result.failures
        ],
        trigger=trigger,
    )


def recent_runs(
    connection: sqlite3.Connection,
    *,
    source: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    if source:
        rows = connection.execute(
            "SELECT * FROM source_runs WHERE source=? ORDER BY id DESC LIMIT ?",
            (source, limit),
        ).fetchall()
    else:
        rows = connection.execute(
            "SELECT * FROM source_runs ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(row) for row in rows]


def source_health(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    """Latest run per source, plus lifetime totals."""
    rows = connection.execute(
        """
        SELECT r.*
        FROM source_runs r
        JOIN (SELECT source, MAX(id) AS max_id FROM source_runs GROUP BY source) latest
          ON latest.max_id = r.id
        ORDER BY r.source
        """
    ).fetchall()
    health = []
    for row in rows:
        record = dict(row)
        totals = connection.execute(
            """
            SELECT COUNT(*) AS runs, SUM(inserted) AS inserted, SUM(updated) AS updated,
                   SUM(errors) AS errors, MIN(started_at) AS first_run
            FROM source_runs WHERE source=?
            """,
            (record["source"],),
        ).fetchone()
        record["totals"] = dict(totals)
        record["failures"] = json.loads(record["failures"] or "[]")
        health.append(record)
    return health


ARTICLE_FIELDS = (
    "id",
    "source",
    "source_id",
    "title",
    "url",
    "author",
    "published_at",
    "summary",
    "content",
    "content_status",
    "fetched_at",
)


def _like_terms(query: str) -> list[str]:
    terms = [term for term in "".join(query.split()).split() if term]
    return [term for term in terms if len(term) >= 2][:6] or (
        [query.strip()] if query.strip() else []
    )


def search_articles(
    connection: sqlite3.Connection,
    *,
    query: str = "",
    limit: int = 40,
    sources: list[str] | None = None,
    since: str | None = None,
    exclude_ids: set[str] | None = None,
) -> list[dict[str, Any]]:
    """Keyword search over stored rows, newest first. Cheap enough for a 3s budget."""
    where = ["1=1"]
    params: list[Any] = []
    if sources:
        where.append("source IN (" + ",".join("?" for _ in sources) + ")")
        params.extend(sources)
    if since:
        where.append("published_at >= ?")
        params.append(since)
    if exclude_ids:
        where.append("id NOT IN (" + ",".join("?" for _ in exclude_ids) + ")")
        params.extend(sorted(exclude_ids))
    terms = _like_terms(query)
    for term in terms:
        where.append("(title LIKE ? OR summary LIKE ? OR content LIKE ?)")
        params.extend([f"%{term}%"] * 3)
    sql = (
        f"SELECT {', '.join(ARTICLE_FIELDS)} FROM news_articles WHERE "
        + " AND ".join(where)
        + " ORDER BY published_at DESC, fetched_at DESC LIMIT ?"
    )
    params.append(limit)
    rows = connection.execute(sql, params).fetchall()
    return [dict(row) for row in rows]


def latest_articles(
    connection: sqlite3.Connection,
    *,
    limit: int = 40,
    sources: list[str] | None = None,
    exclude_ids: set[str] | None = None,
) -> list[dict[str, Any]]:
    return search_articles(
        connection,
        query="",
        limit=limit,
        sources=sources,
        exclude_ids=exclude_ids,
    )


def article_counts(connection: sqlite3.Connection) -> dict[str, Any]:
    total = connection.execute("SELECT COUNT(*) AS n FROM news_articles").fetchone()["n"]
    per_source = connection.execute(
        "SELECT source, COUNT(*) AS n FROM news_articles GROUP BY source ORDER BY n DESC"
    ).fetchall()
    newest = connection.execute(
        "SELECT MAX(fetched_at) AS fetched_at FROM news_articles"
    ).fetchone()["fetched_at"]
    return {
        "total": total,
        "per_source": [dict(row) for row in per_source],
        "newest_fetch": newest,
    }
