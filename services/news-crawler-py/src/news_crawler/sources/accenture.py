"""埃森哲中国站：AEM SSR 首页洞察/新闻卡片链接 + main 容器正文。"""

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

BASE = "https://www.accenture.com/"
ENTRY = f"{BASE}cn-zh"
INSIGHT_RE = re.compile(r"^/cn-zh/insights/[a-z0-9-]+/([a-z0-9-]+)/?$")
NEWS_RE = re.compile(r"^/cn-zh/about/newsroom/([a-z0-9-]+)/?$")


def match_slug(path: str) -> str | None:
    match = INSIGHT_RE.match(path) or NEWS_RE.match(path)
    if not match:
        return None
    slug = match.group(1)
    return None if slug.endswith("-index") else slug


class AccentureSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        html = await self.http.get_text(self.id, ENTRY)
        soup = soup_of(html)
        entries: dict[str, RawListItem] = {}
        for node in soup.find_all("a"):
            href = str(node.get("href") or "")
            path = urlparse(urljoin(ENTRY, href)).path
            slug = match_slug(path)
            if not slug or slug in entries:
                continue
            title = clean_text(node.get_text(" "))
            entries[slug] = RawListItem(
                source_id=slug,
                url=urljoin(BASE, path),
                title=title,
            )
        return RawPage(items=list(entries.values()), next_cursor=None)

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(soup, ("main", "article"))
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
    id="accenture",
    name="埃森哲",
    group="consulting",
    homepage=ENTRY,
    adapter="html-list",
    entry=ENTRY,
    pagination="none",
    capabilities=SourceCapabilities(content_mode="full", supports_pagination=False),
    policy=SourcePolicy(
        interval_s=24 * 3600,
        detail_concurrency=2,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=30,
        max_pages=1,
    ),
    note="企业官网以研究/观点/案例页为主，月/季级更新；列表卡片标题常为“了解更多”，标题以详情页 h1 为准。",
)
ADAPTER = AccentureSource
