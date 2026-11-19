"""Core contracts for the Python crawler.

The field names stay in snake_case inside Python; the JSON boundary maps them
to the existing `news-ingest/v1` camelCase protocol.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import Literal


class RunStatus(str, Enum):
    SUCCESS = "success"
    EMPTY = "empty"
    PARTIAL_FAILURE = "partial_failure"
    FAILURE = "failure"


class FailureStage(str, Enum):
    LIST = "list"
    DETAIL = "detail"
    NORMALIZE = "normalize"
    DB = "db"


@dataclass(slots=True)
class SourcePolicy:
    interval_s: float
    detail_concurrency: int
    # Legacy per-request gap metadata kept for source descriptors. Normal
    # requests no longer wait on a fixed interval; retries use adaptive backoff.
    min_interval_ms: int
    timeout_s: float
    retries: int
    max_items: int | None = None
    max_pages: int | None = None


@dataclass(slots=True)
class SourceCapabilities:
    requires_browser: bool = False
    anti_crawler: bool = False
    auth: Literal["none", "cookie", "paywall"] = "none"
    content_mode: Literal["full", "summary"] = "full"
    supports_pagination: bool = False


@dataclass(slots=True)
class SourceDescriptor:
    id: str
    name: str
    group: str
    homepage: str
    adapter: str
    entry: str
    pagination: str
    capabilities: SourceCapabilities
    policy: SourcePolicy
    enabled: bool = True
    maintainer: str = "news"
    language: str = "zh"
    # Reason an enabled=False source stays in the registry (paid wall, login
    # wall, dead site, browser-only ...). Empty for sources that are live.
    note: str = ""


@dataclass(slots=True)
class RawArticle:
    source_id: str
    url: str
    title: str
    content: str
    author: str = ""
    published_at: str = ""
    summary: str = ""
    content_html: str = ""


@dataclass(slots=True)
class RawListItem:
    source_id: str
    url: str
    title: str = ""
    author: str = ""
    published_at: str = ""
    summary: str = ""
    fallback: RawArticle | None = None


@dataclass(slots=True)
class RawPage:
    items: list[RawListItem]
    next_cursor: str | None = None


@dataclass(slots=True)
class SourceFailure:
    stage: FailureStage
    message: str
    url: str = ""


@dataclass(slots=True)
class SourceRunResult:
    source: str
    status: RunStatus = RunStatus.SUCCESS
    fetched: int = 0
    inserted: int = 0
    updated: int = 0
    skipped: int = 0
    errors: int = 0
    failures: list[SourceFailure] = field(default_factory=list)
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    duration_ms: int = 0


@dataclass(slots=True)
class NewsIngestItem:
    source_id: str
    external_id: str
    url: str
    title: str
    content: str
    content_mode: Literal["full", "summary"]
    summary: str = ""
    published_at: str = ""
    author: str = ""
    media_name: str = ""
    language: str = "zh"
    kind: str = "article"
    section: str = ""
    fetched_at: str = ""
    protocol: str = "news-ingest/v1"

    def to_dict(self) -> dict[str, str]:
        return {
            "protocol": self.protocol,
            "sourceId": self.source_id,
            "externalId": self.external_id,
            "url": self.url,
            "title": self.title,
            "content": self.content,
            "contentMode": self.content_mode,
            "summary": self.summary,
            "publishedAt": self.published_at,
            "author": self.author,
            "mediaName": self.media_name,
            "language": self.language,
            "kind": self.kind,
            "section": self.section,
            "fetchedAt": self.fetched_at,
        }
