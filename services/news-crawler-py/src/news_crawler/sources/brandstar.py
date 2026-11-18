from __future__ import annotations

import re
import xml.etree.ElementTree as ET

from ..html import canonical_url, clean_text, html_to_text, normalize_date
from ..models import (
    RawArticle,
    RawListItem,
    RawPage,
    SourceCapabilities,
    SourceDescriptor,
    SourcePolicy,
)
from .base import NewsSource

FEED = "https://www.brandstar.com.cn/feed/"
CONTENT_NS = "{http://purl.org/rss/1.0/modules/content/}encoded"
DC_NS = "{http://purl.org/dc/elements/1.1/}creator"


def source_id_of(url: str) -> str:
    match = re.search(r"/articles/([^/]+)/", url)
    if match:
        return match.group(1)
    return re.sub(r"[^a-z0-9]+", "-", url, flags=re.IGNORECASE).strip("-")[:80] or "article"


class BrandstarSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        page = int(cursor or "1")
        feed_url = FEED if page <= 1 else f"{FEED}?paged={page}"
        xml = await self.http.get_text(self.id, feed_url)
        root = ET.fromstring(xml)
        items: list[RawListItem] = []
        for node in root.findall(".//item"):
            title = clean_text(node.findtext("title") or "")
            link = clean_text(node.findtext("link") or "")
            if not title or not link:
                continue
            url = canonical_url(link)
            source_id = source_id_of(url)
            content_html = node.findtext(CONTENT_NS) or node.findtext("description") or ""
            summary = clean_text(html_to_text(node.findtext("description") or ""))
            published_at = normalize_date(node.findtext("pubDate") or "")
            fallback = RawArticle(
                source_id=source_id,
                url=url,
                title=title,
                author=clean_text(node.findtext(DC_NS) or ""),
                published_at=published_at,
                summary=summary,
                content=html_to_text(content_html),
                content_html=content_html,
            )
            items.append(
                RawListItem(
                    source_id=source_id,
                    url=url,
                    title=title,
                    published_at=published_at,
                    summary=summary,
                    fallback=fallback,
                )
            )
        return RawPage(items=items, next_cursor=str(page + 1) if items else None)

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        if item.fallback:
            return item.fallback
        html = await self.http.get_text(self.id, item.url)
        return RawArticle(
            source_id=item.source_id,
            url=item.url,
            title=item.title,
            published_at=item.published_at,
            summary=item.summary,
            content=html_to_text(html),
            content_html=html,
        )


DESCRIPTOR = SourceDescriptor(
    id="brandstar",
    name="品牌星球",
    group="case",
    homepage="https://www.brandstar.com.cn/",
    adapter="rss",
    entry="https://www.brandstar.com.cn/feed/",
    pagination="page",
    capabilities=SourceCapabilities(content_mode="full", supports_pagination=True),
    policy=SourcePolicy(
        interval_s=30 * 60,
        detail_concurrency=1,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=500,
        max_pages=10,
    ),
)
ADAPTER = BrandstarSource
