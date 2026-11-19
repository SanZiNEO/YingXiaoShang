"""贝恩公司中国站：PHP 栏目页列表（news_info.php?id=）+ 详情页正文容器。"""

from __future__ import annotations

from urllib.parse import parse_qs, urljoin, urlparse

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

BASE = "https://www.bain.cn/"
LIST_URL = f"{BASE}news.php"


def list_title(node) -> str:
    title = clean_text(node.get_text(" "))
    if title:
        return title
    heading = node.find(["h5", "h4", "h3"])
    if heading:
        return clean_text(heading.get_text(" "))
    return ""


class BainSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        html = await self.http.get_text(self.id, LIST_URL)
        soup = soup_of(html)
        entries: dict[str, RawListItem] = {}
        for node in soup.find_all("a"):
            href = str(node.get("href") or "")
            parsed = urlparse(urljoin(LIST_URL, href))
            if "news_info.php" not in parsed.path:
                continue
            article_id = (parse_qs(parsed.query).get("id") or [""])[0]
            if not article_id or article_id in entries:
                continue
            url = urljoin(BASE, f"{parsed.path}?{parsed.query}")
            entries[article_id] = RawListItem(
                source_id=article_id,
                url=url,
                title=list_title(node),
            )
        return RawPage(items=list(entries.values()), next_cursor=None)

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(soup, (".content", ".detail-content"))
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
    id="bain",
    name="贝恩",
    group="consulting",
    homepage=BASE,
    adapter="html-list",
    entry=LIST_URL,
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
    note="观点/报告更新频率低（月/季）；报告 PDF 多为留资下载，仅入库公开 HTML 观点与媒体报道。",
)
ADAPTER = BainSource
