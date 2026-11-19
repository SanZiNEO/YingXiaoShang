from __future__ import annotations

import re
from urllib.parse import urljoin, urlparse

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

BASE = "https://www.newrank.cn/"
LIST_PAGE = f"{BASE}report"
DETAIL_RE = re.compile(r"^/report/detail/(\d+)$")


class NewrankSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        html = await self.http.get_text(self.id, LIST_PAGE)
        soup = soup_of(html)
        entries: dict[str, RawListItem] = {}
        for node in soup.select('li.index_wrap__XVUBy a[href*="/report/detail/"]'):
            href = str(node.get("href") or "")
            path = urlparse(urljoin(BASE, href)).path
            match = DETAIL_RE.match(path)
            if not match:
                continue
            absolute = urljoin(BASE, path)
            if absolute in entries:
                continue
            card = node.find_parent("li") or node
            title_node = card.select_one("strong.index_title__mSetX")
            time_node = card.select_one("span.index_time__JVraD")
            desc_node = card.select_one("div.index_desc__isRUb")
            title = clean_text(
                str(title_node.get("title") or "")
                if title_node and title_node.get("title")
                else (title_node.get_text(" ") if title_node else "")
            )
            if not title:
                title = clean_text(node.get_text(" "))
            if not title:
                continue
            entries[absolute] = RawListItem(
                source_id=match.group(1),
                url=absolute,
                title=title,
                published_at=normalize_date(
                    clean_text(time_node.get_text(" ")) if time_node else ""
                ),
                summary=clean_text(desc_node.get("title") or desc_node.get_text(" "))
                if desc_node
                else "",
            )
        return RawPage(items=list(entries.values()), next_cursor=None)

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(soup, ('article[class^="index_articleContent"]',))
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
    id="newrank",
    name="新榜",
    group="data",
    homepage=BASE,
    adapter="html-list",
    entry=LIST_PAGE,
    pagination="none",
    capabilities=SourceCapabilities(
        auth="none",
        content_mode="full",
        supports_pagination=False,
    ),
    policy=SourcePolicy(
        interval_s=6 * 3600,
        detail_concurrency=2,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=30,
        max_pages=1,
    ),
    note="榜单与账号数据工具需登录/会员，仅接入公开报告栏目；部分报告 PDF 全文需登录下载。",
)
ADAPTER = NewrankSource
