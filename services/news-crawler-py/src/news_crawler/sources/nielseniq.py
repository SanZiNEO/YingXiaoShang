"""尼尔森IQ NielsenIQ：全球零售/快消消费者研究，英文全球站洞察列表 + 详情页。"""

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

BASE = "https://nielseniq.com"
ENTRY = f"{BASE}/global/en/insights/"
ARTICLE_RE = re.compile(
    r"^/global/en/insights/(analysis|report|education|success-story|knowledge|commentary|news)"
    r"/\d{4}/([a-z0-9-]+)/?$"
)


class NielseniqSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        html = await self.http.get_text(self.id, ENTRY)
        soup = soup_of(html)
        entries: dict[str, RawListItem] = {}
        for node in soup.find_all("a"):
            href = str(node.get("href") or "")
            path = urlparse(urljoin(ENTRY, href)).path
            match = ARTICLE_RE.match(path)
            if not match:
                continue
            slug = match.group(2)
            if slug in entries:
                continue
            title = clean_text(node.get_text(" "))
            entries[slug] = RawListItem(
                source_id=slug,
                url=urljoin(ENTRY, path),
                title=title,
            )
        return RawPage(items=list(entries.values()), next_cursor=None)

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(soup, ("article", "main"))
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
    id="nielseniq",
    name="尼尔森IQ",
    group="data",
    homepage=BASE,
    adapter="html-list",
    entry=ENTRY,
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
    language="en",
    note="英文全球站按 /global/en/ 路径区分地区；报告 PDF 需留资表单下载，仅入库公开 HTML 洞察。",
)
ADAPTER = NielseniqSource
