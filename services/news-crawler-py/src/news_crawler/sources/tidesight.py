from __future__ import annotations

import re
from urllib.parse import urljoin, urlparse

from ..html import (
    clean_text,
    first_html,
    html_to_text,
    normalize_date,
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

BASE = "https://www.tidesight.com/"
LIST_PAGE = BASE
ARTICLE_RE = re.compile(r"^/news/(\d+)\.html$")


class TidesightSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        html = await self.http.get_text(self.id, LIST_PAGE)
        soup = soup_of(html)
        entries: dict[str, RawListItem] = {}
        for node in soup.find_all("a", href=True):
            href = str(node["href"])
            path = urlparse(urljoin(BASE, href)).path
            match = ARTICLE_RE.match(path)
            if not match:
                continue
            absolute = urljoin(BASE, path)
            if absolute in entries:
                continue
            summary = ""
            desc = node.select_one(".desc")
            if desc:
                summary = clean_text(desc.get_text(" "))
            entries[absolute] = RawListItem(
                source_id=match.group(1),
                url=absolute,
                title=clean_text(node.get_text(" ")),
                summary=summary,
            )
        return RawPage(items=list(entries.values()))

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(soup, ("#news-content", ".news-content"))
        author = ""
        author_node = soup.select_one(".author")
        if author_node:
            author = clean_text(author_node.get_text(" "))
        published_at = item.published_at
        date_node = soup.select_one(".date")
        if date_node:
            published_at = normalize_date(clean_text(date_node.get_text(" ")))
        return RawArticle(
            source_id=item.source_id,
            url=item.url,
            title=page_title(soup, item.title),
            author=author,
            published_at=published_at,
            summary=page_summary(soup, item.summary),
            content=html_to_text(content_html),
            content_html=content_html,
        )


DESCRIPTOR = SourceDescriptor(
    id="tidesight",
    name="观潮新消费",
    group="brandnews",
    homepage=BASE,
    adapter="html-list",
    entry=LIST_PAGE,
    pagination="none",
    capabilities=SourceCapabilities(content_mode="full", supports_pagination=False),
    policy=SourcePolicy(
        interval_s=15 * 60,
        detail_concurrency=2,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=50,
        max_pages=1,
    ),
)
ADAPTER = TidesightSource
