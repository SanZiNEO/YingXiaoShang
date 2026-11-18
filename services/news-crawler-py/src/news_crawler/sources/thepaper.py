from __future__ import annotations

import re
from urllib.parse import urljoin

from ..html import clean_text, first_html, html_to_text, page_date, page_summary, page_title
from ..models import (
    RawArticle,
    RawListItem,
    RawPage,
    SourceCapabilities,
    SourceDescriptor,
    SourcePolicy,
)
from .base import NewsSource, soup_of

BASE = "https://www.thepaper.cn/"
ENTRY = f"{BASE}channel_25951"
DETAIL_RE = re.compile(r"/newsDetail_forward_(\d+)")
AUTHOR_RE = re.compile(r"^(\S+)\s+\d{4}-\d{2}-\d{2}")


class ThepaperSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        html = await self.http.get_text(self.id, ENTRY)
        soup = soup_of(html)
        entries: dict[str, RawListItem] = {}
        for node in soup.find_all("a", href=True):
            href = str(node["href"])
            match = DETAIL_RE.search(href)
            if not match:
                continue
            absolute = urljoin(BASE, href)
            title = clean_text(node.get_text(" "))
            existing = entries.get(absolute)
            if existing:
                if not existing.title and title:
                    existing.title = title
                continue
            entries[absolute] = RawListItem(
                source_id=match.group(1),
                url=absolute,
                title=title,
            )
        return RawPage(items=list(entries.values()))

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(
            soup,
            (
                ".cententWrap__UojXm",
                ".leftcontent__XcRTe",
                ".normalContentWrap__i8VSb",
                "main",
            ),
        )
        author = ""
        meta_node = soup.select_one(".leftcontent__XcRTe")
        if meta_node:
            match = AUTHOR_RE.search(clean_text(meta_node.get_text(" ")))
            if match:
                author = match.group(1)
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
    id="thepaper",
    name="澎湃新闻",
    group="industry",
    homepage="https://www.thepaper.cn/",
    adapter="html-list",
    entry="https://www.thepaper.cn/channel_25951",
    pagination="none",
    capabilities=SourceCapabilities(
        anti_crawler=True,
        content_mode="full",
        supports_pagination=False,
    ),
    policy=SourcePolicy(
        interval_s=10 * 60,
        detail_concurrency=1,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=60,
        max_pages=1,
    ),
)
ADAPTER = ThepaperSource
