"""麦肯锡大中华区：WordPress SSR 首页文章列表 + entry-content 正文。"""

from __future__ import annotations

from urllib.parse import unquote, urljoin, urlparse

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

BASE = "https://www.mckinsey.com.cn/"
NAV_SLUGS = {
    "contact-us",
    "insights",
    "latest-updates",
    "post-17653",
    "ceo-訪談",
    "ceo-访谈",
    "视频",
    "制胜中国新篇章",
    "cn",
}


class McKinseySource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        html = await self.http.get_text(self.id, BASE)
        soup = soup_of(html)
        entries: dict[str, RawListItem] = {}
        for node in soup.find_all("a"):
            href = str(node.get("href") or "")
            path = urlparse(urljoin(BASE, href)).path
            slug = unquote(path.strip("/"))
            parts = slug.split("/")
            if len(parts) != 1 or not parts[0]:
                continue
            if parts[0].startswith("page/") or parts[0] in NAV_SLUGS:
                continue
            if parts[0] in entries:
                continue
            title = clean_text(node.get_text(" "))
            entries[parts[0]] = RawListItem(
                source_id=parts[0],
                url=urljoin(BASE, path),
                title=title,
            )
        return RawPage(items=list(entries.values()), next_cursor=None)

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(soup, (".entry-content", "article", "main"))
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
    id="mckinsey",
    name="麦肯锡",
    group="consulting",
    homepage=BASE,
    adapter="html-list",
    entry=BASE,
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
    note="机构洞见非新闻流，中文站周/月级更新；RSS 已被站点关闭，仅走 SSR HTML。",
)
ADAPTER = McKinseySource
