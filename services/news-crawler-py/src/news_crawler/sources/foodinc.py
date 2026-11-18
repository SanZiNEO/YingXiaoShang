from __future__ import annotations

from urllib.parse import urljoin

from ..html import (
    clean_text,
    first_html,
    html_to_text,
    normalize_date,
    page_date,
    page_summary,
    page_title,
)
from ..models import (
    RawArticle,
    RawListItem,
    RawPage,
    SourceCapabilities,
    SourceDescriptor,
    SourcePolicy,
)
from .base import NewsSource, soup_of

BASE = "https://www.foodinc.com.cn/"
LIST_API = f"{BASE}wp-json/wp/v2/posts"


class FoodincSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        page = int(cursor or "1")
        url = f"{LIST_API}?per_page=10&page={page}&_embed=1"
        payload = await self.http.get_json(self.id, url)
        if not isinstance(payload, list):
            raise TypeError("foodinc list payload is not a list")
        items: list[RawListItem] = []
        for raw in payload:
            source_id = str(raw.get("id") or "").strip()
            link = str(raw.get("link") or "").strip()
            title = clean_text(html_to_text(str(raw.get("title", {}).get("rendered") or "")))
            if not source_id or not link or not title:
                continue
            excerpt = clean_text(html_to_text(str(raw.get("excerpt", {}).get("rendered") or "")))
            content_html = str(raw.get("content", {}).get("rendered") or "")
            content = html_to_text(content_html)
            published_at = normalize_date(str(raw.get("date") or ""))
            authors = (raw.get("_embedded") or {}).get("author") or []
            author = clean_text(str(authors[0].get("name") or "")) if authors else ""
            fallback = None
            if len(content) >= 40:
                fallback = RawArticle(
                    source_id=source_id,
                    url=urljoin(BASE, link),
                    title=title,
                    author=author,
                    published_at=published_at,
                    summary=excerpt,
                    content=content,
                    content_html=content_html,
                )
            items.append(
                RawListItem(
                    source_id=source_id,
                    url=urljoin(BASE, link),
                    title=title,
                    author=author,
                    published_at=published_at,
                    summary=excerpt,
                    fallback=fallback,
                )
            )
        return RawPage(items=items, next_cursor=str(page + 1) if items else None)

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        if item.fallback is not None:
            return item.fallback
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(soup, ("#content-article", ".entry-content", ".post-content"))
        return RawArticle(
            source_id=item.source_id,
            url=item.url,
            title=page_title(soup, item.title),
            author=item.author,
            published_at=page_date(soup, item.published_at),
            summary=page_summary(soup, item.summary),
            content=html_to_text(content_html),
            content_html=content_html,
        )


DESCRIPTOR = SourceDescriptor(
    id="foodinc",
    name="小食代",
    group="brandnews",
    homepage=BASE,
    adapter="json-list",
    entry=LIST_API,
    pagination="page",
    capabilities=SourceCapabilities(content_mode="full", supports_pagination=True),
    policy=SourcePolicy(
        interval_s=15 * 60,
        detail_concurrency=2,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=50,
        max_pages=5,
    ),
)
ADAPTER = FoodincSource
