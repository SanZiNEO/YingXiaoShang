"""Normalize a raw article into the shared news contract."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from .html import canonical_url, clean_text
from .models import NewsIngestItem, RawArticle, SourceDescriptor

MIN_CONTENT_CHARS = 40
FULL_TEXT_CHARS = 300


@dataclass(slots=True)
class NormalizedArticle:
    id: str
    source: str
    source_id: str
    title: str
    url: str
    author: str
    published_at: str
    summary: str
    content: str
    content_status: str
    rights: str
    fetched_at: str
    ingest: NewsIngestItem


def normalize(descriptor: SourceDescriptor, raw: RawArticle) -> tuple[NormalizedArticle | None, str]:
    body = clean_text(raw.content)
    summary = clean_text(raw.summary)
    content = body if len(body) >= MIN_CONTENT_CHARS else (summary if len(summary) > len(body) else body)
    if len(content) < MIN_CONTENT_CHARS:
        return None, f"content too short ({len(content)} chars)"
    title = clean_text(raw.title)
    if not title:
        return None, "missing title"
    source_id = raw.source_id.strip()
    if not source_id:
        return None, "missing source id"
    url = canonical_url(raw.url.strip())
    if not url.startswith(("http://", "https://")):
        return None, "missing url"
    fetched_at = datetime.now(UTC).isoformat()
    author = clean_text(raw.author)
    published_at = raw.published_at.strip()
    content_mode = "full" if len(content) >= FULL_TEXT_CHARS else "summary"
    ingest = NewsIngestItem(
        source_id=descriptor.id,
        external_id=source_id,
        url=url,
        title=title,
        content=content,
        content_mode=content_mode,
        summary=summary,
        published_at=published_at,
        author=author,
        media_name=descriptor.name,
        language="zh",
        kind="article",
        section=descriptor.group,
        fetched_at=fetched_at,
    )
    article = NormalizedArticle(
        id=f"{descriptor.id}-{source_id}",
        source=descriptor.id,
        source_id=source_id,
        title=title,
        url=url,
        author=author,
        published_at=published_at,
        summary=summary,
        content=content,
        content_status="full" if len(content) >= 1_000 else "partial",
        rights="internal-research; source-link",
        fetched_at=fetched_at,
        ingest=ingest,
    )
    return article, ""
