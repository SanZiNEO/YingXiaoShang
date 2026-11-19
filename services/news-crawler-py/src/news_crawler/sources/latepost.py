from __future__ import annotations

import json
from urllib.parse import urljoin

from ..html import first_html, html_to_text, page_date, page_summary, page_title
from ..models import (
    RawArticle,
    RawListItem,
    RawPage,
    SourceCapabilities,
    SourceDescriptor,
    SourcePolicy,
)
from .base import NewsSource, soup_of

BASE = "https://www.latepost.com/"
LIST_API = f"{BASE}site/index"


class LatepostSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        text = await self.http.post_json(
            self.id,
            LIST_API,
            {"page": "1", "limit": "100"},
            headers={"content-type": "application/json"},
        )
        payload = json.loads(text)
        if payload.get("code") != 1 or not isinstance(payload.get("data"), list):
            raise RuntimeError(f"latepost list code {payload.get('code')}")
        entries: dict[str, RawListItem] = {}
        for item in payload["data"]:
            source_id = str(item.get("id") or "").strip()
            href = str(item.get("detail_url") or "").strip()
            if not source_id or not href:
                continue
            url = urljoin(BASE, href)
            if url in entries:
                continue
            entries[url] = RawListItem(
                source_id=source_id,
                url=url,
                title=str(item.get("title") or "").strip(),
                summary=str(item.get("abstract") or "").strip(),
            )
        return RawPage(items=list(entries.values()))

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(soup, (".article-body", ".article"))
        return RawArticle(
            source_id=item.source_id,
            url=item.url,
            title=page_title(soup, item.title),
            published_at=page_date(soup, item.published_at),
            summary=page_summary(soup, item.summary),
            content=html_to_text(content_html),
            content_html=content_html,
        )


DESCRIPTOR = SourceDescriptor(
    id="latepost",
    name="晚点 LatePost",
    group="industry",
    homepage="https://www.latepost.com/",
    adapter="json-list",
    entry="https://www.latepost.com/site/index",
    pagination="none",
    capabilities=SourceCapabilities(content_mode="full", supports_pagination=False),
    policy=SourcePolicy(
        interval_s=30 * 60,
        detail_concurrency=2,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=200,
        max_pages=1,
    ),
)
ADAPTER = LatepostSource
