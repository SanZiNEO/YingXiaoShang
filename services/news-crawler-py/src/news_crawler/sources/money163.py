from __future__ import annotations

import re
from urllib.parse import urljoin, urlparse

from ..html import (
    clean_text,
    first_html,
    html_to_text,
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

BASE = "https://www.163.com/"
LIST_PAGE = "https://money.163.com/"
ARTICLE_RE = re.compile(r"^/(?:money|dy|news)/article/([A-Za-z0-9]+)\.html$")


class Money163Source(NewsSource):
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
            entries[absolute] = RawListItem(
                source_id=match.group(1),
                url=absolute,
                title=clean_text(node.get_text(" ")),
            )
        return RawPage(items=list(entries.values()))

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(soup, ("#content", ".article-body", ".post_body"))
        author = item.author
        author_node = soup.select_one('meta[property="article:author"]')
        if author_node and author_node.get("content"):
            author = clean_text(str(author_node["content"]))
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
    id="money163",
    name="网易商业",
    group="brandnews",
    homepage=LIST_PAGE,
    adapter="html-list",
    entry=LIST_PAGE,
    pagination="none",
    capabilities=SourceCapabilities(content_mode="full", supports_pagination=False),
    policy=SourcePolicy(
        interval_s=5 * 60,
        detail_concurrency=2,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=50,
        max_pages=1,
    ),
    note="快讯约 200 字，正文偏短时以 summary 兜底；正文容器 #content。",
)
ADAPTER = Money163Source
