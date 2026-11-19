from __future__ import annotations

import re
from urllib.parse import urljoin, urlparse

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

BASE = "https://www.news.cn/"
ENTRY = f"{BASE}finance/"
ARTICLE_RE = re.compile(r"^/finance/\d{8}/([0-9a-f]+)/c\.html$")


class XinhuaSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        html = await self.http.get_text(self.id, ENTRY)
        soup = soup_of(html)
        entries: dict[str, RawListItem] = {}
        for node in soup.find_all("a", href=True):
            href = str(node["href"])
            path = urlparse(urljoin(BASE, href)).path
            match = ARTICLE_RE.match(path)
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
        content_html = first_html(soup, ("#detail", ".main-left", ".article"))
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
    id="xinhua",
    name="新华网",
    group="portal",
    homepage="https://www.news.cn/",
    adapter="html-list",
    entry="https://www.news.cn/finance/",
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
ADAPTER = XinhuaSource
