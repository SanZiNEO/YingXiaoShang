from __future__ import annotations

import json

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

BASE = "https://www.admen.cn/"
LIST_API = f"{BASE}api/app/cms/content-server/find-page-list"
DETAIL_URL = f"{BASE}content/{{id}}"


class AdmenSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        page = int(cursor or "1")
        payload = {"size": 20, "current": page}
        text = await self.http.post_json(self.id, LIST_API, payload)
        data = json.loads(text)
        records = (data.get("data") or {}).get("records") or []
        items: list[RawListItem] = []
        for record in records:
            item_id = str(record.get("id") or "").strip()
            title = clean_text(str(record.get("title") or ""))
            if not item_id or not title:
                continue
            items.append(
                RawListItem(
                    source_id=item_id,
                    url=DETAIL_URL.format(id=item_id),
                    title=title,
                    published_at=normalize_date(str(record.get("uploadAt") or "")),
                    summary=clean_text(str(record.get("subTitle") or "")),
                )
            )
        return RawPage(items=items, next_cursor=str(page + 1) if items else None)

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(
            soup,
            (".detail-center.content-html-scope", ".media-body", ".body-content"),
        )
        author = ""
        author_node = soup.select_one(".author-name, .write-author, .media-author, .article-author")
        if author_node:
            author = clean_text(author_node.get_text(" "))
        return RawArticle(
            source_id=item.source_id,
            url=item.url,
            title=page_title(soup, item.title),
            author=author,
            published_at=page_date(soup, item.published_at),
            summary=page_summary(soup, item.summary),
            content=html_to_text(content_html),
            content_html=content_html,
        )


DESCRIPTOR = SourceDescriptor(
    id="admen",
    name="广告人网",
    group="case",
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
        max_items=100,
        max_pages=5,
    ),
)
ADAPTER = AdmenSource
