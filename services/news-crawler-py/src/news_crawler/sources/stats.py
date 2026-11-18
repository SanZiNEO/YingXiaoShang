from __future__ import annotations

import re
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

BASE = "https://www.stats.gov.cn/"
LIST_PAGE = f"{BASE}sj/zxfb/"
ID_RE = re.compile(r"_(\d+)\.html$")


class StatsSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        html = await self.http.get_text(self.id, LIST_PAGE)
        soup = soup_of(html)
        entries: dict[str, RawListItem] = {}
        for node in soup.find_all("a", href=True):
            href = str(node.get("href") or "")
            match = ID_RE.search(href)
            if not match:
                continue
            absolute = urljoin(LIST_PAGE, href)
            if absolute in entries:
                continue
            title = clean_text(str(node.get("title") or "") or node.get_text(" "))
            if not title:
                continue
            date_node = node.find_parent("li").find("span") if node.find_parent("li") else None
            entries[absolute] = RawListItem(
                source_id=match.group(1),
                url=absolute,
                title=title,
                published_at=normalize_date(clean_text(date_node.get_text(" ")) if date_node else ""),
            )
        return RawPage(items=list(entries.values()), next_cursor=None)

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(
            soup,
            (".detail-text-content", ".txt-content", ".trs_editor_view"),
        )
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
    id="stats",
    name="国家统计局",
    group="official",
    homepage=BASE,
    adapter="html-list",
    entry=LIST_PAGE,
    pagination="none",
    capabilities=SourceCapabilities(content_mode="full", supports_pagination=False),
    policy=SourcePolicy(
        interval_s=2 * 3600,
        detail_concurrency=2,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=50,
        max_pages=1,
    ),
    note="仅抓取数据发布（zxfb）栏目，首页时政要闻不入库；发布稿按月度/季度更新。",
)
ADAPTER = StatsSource
