"""中国消费者协会（官方机构，消费提示 / 比较试验 / 投诉分析发布）。"""
from __future__ import annotations

import re
from urllib.parse import urljoin, urlparse

from ..html import clean_text, first_html, html_to_text, normalize_date, page_summary, page_title
from ..models import (
    RawArticle,
    RawListItem,
    RawPage,
    SourceCapabilities,
    SourceDescriptor,
    SourcePolicy,
)
from .base import NewsSource, soup_of

BASE = "https://www.cca.org.cn/"
ARTICLE_RE = re.compile(r"/(?:single/\d+|content/\d{4}/[a-z]+)/(\d+)\.html")
DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")


NAV_CLASSES = {"nav-div", "nav-sub", "nav-sub_ul", "nav-sub_ul2"}


def _in_nav(node) -> bool:  # type: ignore[no-untyped-def]
    for ancestor in node.parents:
        classes = ancestor.get("class") or []
        if NAV_CLASSES.intersection(classes):
            return True
    return False


class CcaSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        html = await self.http.get_text(self.id, self.descriptor.entry)
        soup = soup_of(html)
        entries: dict[str, RawListItem] = {}
        for node in soup.find_all("a", href=True):
            href = str(node["href"])
            path = urlparse(urljoin(BASE, href)).path
            match = ARTICLE_RE.search(path)
            if not match or _in_nav(node):
                continue
            title = clean_text(node.get_text(" "))
            if not title:
                continue
            absolute = urljoin(BASE, href)
            if absolute in entries:
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
        content_html = first_html(soup, ("#content.content.level_2", ".detail_content"))
        title_node = soup.select_one(".detail_content h2")
        title = clean_text(title_node.get_text(" ")) if title_node else page_title(soup, item.title)
        published_at = item.published_at
        head = soup.select_one(".detail_content .infos, .detail_content, .page-main")
        if head:
            date_match = DATE_RE.search(head.get_text(" "))
            if date_match:
                published_at = normalize_date(date_match.group(1))
        return RawArticle(
            source_id=item.source_id,
            url=item.url,
            title=title,
            published_at=published_at,
            summary=page_summary(soup, item.summary),
            content=html_to_text(content_html),
            content_html=content_html,
        )


DESCRIPTOR = SourceDescriptor(
    id="cca",
    name="中国消费者协会",
    group="official",
    homepage="https://www.cca.org.cn/",
    adapter="html-list",
    entry="https://www.cca.org.cn/",
    pagination="none",
    capabilities=SourceCapabilities(content_mode="full", supports_pagination=False),
    policy=SourcePolicy(
        interval_s=30 * 60,
        detail_concurrency=2,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=60,
        max_pages=1,
    ),
    note="消费提示/比较试验/投诉分析类官方发布，非实时新闻流，更新频率周/月级。",
)
ADAPTER = CcaSource
