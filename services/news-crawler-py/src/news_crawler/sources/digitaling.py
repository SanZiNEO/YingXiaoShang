from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

from ..html import clean_text, first_html, html_to_text, page_summary, page_title
from ..models import (
    RawArticle,
    RawListItem,
    RawPage,
    SourceCapabilities,
    SourceDescriptor,
    SourcePolicy,
)
from .base import NewsSource, soup_of

LIST_API = "https://www.digitaling.com/api/getArticles/type/viewCount"
DETAIL_URL = "https://www.digitaling.com/articles/{article_id}.html"
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


class DigitalingSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        payload = await self.http.get_json(self.id, LIST_API)
        content = payload.get("content")
        if not isinstance(content, list):
            raise TypeError("digitaling list payload has no content")
        entries: dict[str, RawListItem] = {}
        for item in content:
            if not isinstance(item, dict):
                continue
            source_id = str(item.get("articleId") or "").strip()
            if not source_id:
                continue
            url = DETAIL_URL.format(article_id=source_id)
            entries[source_id] = RawListItem(
                source_id=source_id,
                url=url,
                title=clean_text(str(item.get("title") or "")),
                published_at=_timestamp(item.get("publishTime")),
            )
        return RawPage(items=list(entries.values()))

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(soup, ("#article_con", ".con_l_art", ".content"))
        return RawArticle(
            source_id=item.source_id,
            url=item.url,
            title=page_title(soup, item.title),
            published_at=item.published_at,
            summary=page_summary(soup, item.summary),
            content=html_to_text(content_html),
            content_html=content_html,
        )


DESCRIPTOR = SourceDescriptor(
    id="digitaling",
    name="数英",
    group="case",
    homepage="https://www.digitaling.com/",
    adapter="json-list",
    entry="https://www.digitaling.com/api/getArticles/type/viewCount",
    pagination="none",
    capabilities=SourceCapabilities(content_mode="full", supports_pagination=False),
    policy=SourcePolicy(
        interval_s=30 * 60,
        detail_concurrency=2,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=60,
        max_pages=1,
    ),
)
ADAPTER = DigitalingSource
