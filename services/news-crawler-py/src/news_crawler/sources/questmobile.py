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

BASE = "https://www.questmobile.com.cn/"
LIST_PAGE = f"{BASE}research/reports"
DETAIL_RE = re.compile(r"^/research/report/(\d+)$")


class QuestmobileSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        html = await self.http.get_text(self.id, LIST_PAGE)
        soup = soup_of(html)
        entries: dict[str, RawListItem] = {}
        for card in soup.find_all("dl"):
            anchor = card.select_one("dd h3 a[href]")
            if anchor is None:
                continue
            href = str(anchor.get("href") or "")
            path = urlparse(urljoin(BASE, href)).path
            match = DETAIL_RE.match(path)
            if not match:
                continue
            absolute = urljoin(BASE, path)
            if absolute in entries:
                continue
            time_node = card.select_one("span.shijian")
            summary_node = card.select_one("dd p")
            title = clean_text(str(anchor.get("title") or "") or anchor.get_text(" "))
            if not title:
                continue
            entries[absolute] = RawListItem(
                source_id=match.group(1),
                url=absolute,
                title=title,
                published_at=normalize_date(clean_text(time_node.get_text(" ")) if time_node else ""),
                summary=clean_text(summary_node.get("title") or summary_node.get_text(" "))
                if summary_node
                else "",
            )
        return RawPage(items=list(entries.values()), next_cursor=None)

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(soup, (".report .cont", ".report .text", ".cont", ".text"))
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
    id="questmobile",
    name="QuestMobile",
    group="data",
    homepage=BASE,
    adapter="html-list",
    entry=LIST_PAGE,
    pagination="none",
    capabilities=SourceCapabilities(content_mode="full", supports_pagination=False),
    policy=SourcePolicy(
        interval_s=12 * 3600,
        detail_concurrency=2,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=30,
        max_pages=1,
    ),
    note="报告 PDF 下载需登录/留资，仅取网页公开正文与摘要；报告更新频率低，按 12 小时轮询。",
)
ADAPTER = QuestmobileSource
