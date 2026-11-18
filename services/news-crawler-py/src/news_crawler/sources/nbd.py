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

BASE = "https://www.nbd.com.cn/"
LIST_PAGE = f"{BASE}columns/3/"
HEADERS = {
    "referer": LIST_PAGE,
    "accept-language": "zh-CN,zh;q=0.9",
}
ARTICLE_RE = re.compile(r"^/articles/(\d{4}-\d{2}-\d{2}/\d+)\.html$")
AUTHOR_RE = re.compile(r"每经记者[｜|]\s*([^\s]+)")


class NbdSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        page = int(cursor or "1")
        url = LIST_PAGE if page <= 1 else f"{LIST_PAGE}page/{page}/"
        html = await self.http.get_text(self.id, url, headers=HEADERS)
        soup = soup_of(html)
        entries: dict[str, RawListItem] = {}
        for node in soup.find_all("a"):
            href = str(node.get("href") or "")
            path = urlparse(urljoin(BASE, href)).path
            match = ARTICLE_RE.match(path)
            if not match:
                continue
            absolute = urljoin(BASE, path)
            if absolute in entries:
                continue
            entries[absolute] = RawListItem(
                source_id=match.group(1),
                url=absolute,
                title=clean_text(node.get_text(" ")),
            )
        items = list(entries.values())
        return RawPage(items=items, next_cursor=str(page + 1) if items else None)

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url, headers=HEADERS)
        soup = soup_of(html)
        content_html = first_html(soup, (".g-articl-text",))
        author = ""
        left = soup.select_one(".g-article-left")
        if left:
            match = AUTHOR_RE.search(clean_text(left.get_text(" ")))
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
    id="nbd",
    name="每日经济新闻",
    group="finance",
    homepage="https://www.nbd.com.cn/",
    adapter="html-list",
    entry="https://www.nbd.com.cn/columns/3/",
    pagination="page",
    capabilities=SourceCapabilities(
        requires_browser=False,
        anti_crawler=True,
        content_mode="full",
        supports_pagination=True,
    ),
    policy=SourcePolicy(
        interval_s=10 * 60,
        detail_concurrency=1,
        min_interval_ms=500,
        timeout_s=30.0,
        retries=0,
        max_items=100,
        max_pages=5,
    ),
)
ADAPTER = NbdSource
