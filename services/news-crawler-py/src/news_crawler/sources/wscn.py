from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

from ..html import clean_text, html_to_text
from ..models import (
    RawArticle,
    RawListItem,
    RawPage,
    SourceCapabilities,
    SourceDescriptor,
    SourcePolicy,
)
from .base import NewsSource

LIST_API = "https://api-one-wscn.awtmt.com/apiv1/content/articles?limit=20"
DETAIL_API = "https://api-one-wscn.awtmt.com/apiv1/content/articles/{article_id}?extract=0"
CST = timezone(timedelta(hours=8))


def _timestamp(value: object) -> str:
    try:
        ts = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return ""
    if not ts:
        return ""
    if ts > 1_000_000_000_000:
        ts //= 1000
    return datetime.fromtimestamp(ts, UTC).astimezone(CST).isoformat()


def _author(payload: dict[str, object]) -> str:
    author = payload.get("author")
    if isinstance(author, dict):
        return clean_text(str(author.get("display_name") or ""))
    return ""


class WscnSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        payload = await self.http.get_json(self.id, LIST_API)
        if payload.get("code") != 20000:
            raise RuntimeError(f"wscn list code {payload.get('code')}: {payload.get('message')}")
        data = payload.get("data")
        items = data.get("items") if isinstance(data, dict) else None
        if not isinstance(items, list):
            raise TypeError("wscn list payload has no items")
        entries: dict[str, RawListItem] = {}
        for item in items:
            if not isinstance(item, dict):
                continue
            source_id = str(item.get("id") or "").strip()
            url = str(item.get("uri") or "").strip()
            if not source_id or not url:
                continue
            if source_id in entries:
                continue
            entries[source_id] = RawListItem(
                source_id=source_id,
                url=url,
                title=clean_text(str(item.get("title") or "")),
                author=_author(item),
                published_at=_timestamp(item.get("display_time")),
                summary=clean_text(str(item.get("content_short") or "")),
            )
        return RawPage(items=list(entries.values()))

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        url = DETAIL_API.format(article_id=item.source_id)
        payload = await self.http.get_json(self.id, url)
        if payload.get("code") != 20000 or not isinstance(payload.get("data"), dict):
            raise RuntimeError(f"wscn detail code {payload.get('code')}: {payload.get('message')}")
        data = payload["data"]
        content_html = str(data.get("content") or "")
        summary = clean_text(str(data.get("content_short") or "")) or item.summary
        title = clean_text(str(data.get("title") or "")) or item.title
        author = _author(data) or item.author
        published_at = _timestamp(data.get("display_time")) or item.published_at
        return RawArticle(
            source_id=item.source_id,
            url=item.url,
            title=title,
            author=author,
            published_at=published_at,
            summary=summary,
            content=html_to_text(content_html),
            content_html=content_html,
        )


DESCRIPTOR = SourceDescriptor(
    id="wscn",
    name="华尔街见闻",
    group="finance",
    homepage="https://wallstreetcn.com/",
    adapter="json-list",
    entry="https://api-one-wscn.awtmt.com/apiv1/content/articles?limit=20",
    pagination="none",
    capabilities=SourceCapabilities(content_mode="full", supports_pagination=False),
    policy=SourcePolicy(
        interval_s=10 * 60,
        detail_concurrency=2,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=60,
        max_pages=1,
    ),
)
ADAPTER = WscnSource
