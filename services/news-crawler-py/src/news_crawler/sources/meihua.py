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

BASE = "https://www.meihua.info/"
SHOT_RE = re.compile(r"^/shots/(\d+)$")


class MeihuaSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        html = await self.http.get_text(self.id, BASE)
        soup = soup_of(html)
        entries: dict[str, RawListItem] = {}
        for node in soup.find_all("a", href=True):
            href = str(node["href"])
            if "#comment" in href:
                continue
            path = urlparse(urljoin(BASE, href)).path
            match = SHOT_RE.match(path)
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
        items = [item for item in entries.values() if item.title]
        return RawPage(items=items)

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(
            soup,
            (".shots-detail-body", ".shots-content-main", ".shots-detail-contanier"),
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
    id="meihua",
    name="梅花网",
    group="case",
    homepage="https://www.meihua.info/",
    adapter="html-list",
    entry="https://www.meihua.info/",
    pagination="none",
    capabilities=SourceCapabilities(
        anti_crawler=True,
        content_mode="summary",
        supports_pagination=False,
    ),
    policy=SourcePolicy(
        interval_s=30 * 60,
        detail_concurrency=2,
        min_interval_ms=0,
        timeout_s=30.0,
        retries=1,
        max_items=60,
        max_pages=1,
    ),
    note="详情页并发 4 时出现 429；保留 2 并发且不做固定间隔，靠失败退避。",
)
ADAPTER = MeihuaSource
