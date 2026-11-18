"""益普索 Ipsos 中文站：Drupal RSS 源，feed description 兜底正文，详情页补抓 SSR HTML。"""

from __future__ import annotations

from urllib.parse import urlparse

from bs4 import BeautifulSoup

from ..html import clean_text, first_html, html_to_text, normalize_date, page_summary
from ..models import (
    RawArticle,
    RawListItem,
    RawPage,
    SourceCapabilities,
    SourceDescriptor,
    SourcePolicy,
)
from .base import NewsSource, soup_of

FEED = "https://www.ipsos.com/zh-cn/rss.xml"
DC_NS = "{http://purl.org/dc/elements/1.1/}creator"


def slug_of(url: str) -> str:
    path = urlparse(url).path.strip("/")
    return path.split("/")[-1] or "article"


class IpsosSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        xml = await self.http.get_text(self.id, FEED)
        soup = BeautifulSoup(xml, "xml")
        items: list[RawListItem] = []
        for node in soup.find_all("item"):
            title = clean_text(node.title.get_text() if node.title else "")
            link = clean_text(node.link.get_text() if node.link else "")
            if not title or not link:
                continue
            description = node.description.get_text() if node.description else ""
            summary = clean_text(html_to_text(description))
            published_at = normalize_date(node.pubDate.get_text() if node.pubDate else "")
            author_node = node.find(DC_NS)
            author = clean_text(author_node.get_text() if author_node else "")
            source_id = slug_of(link)
            fallback = RawArticle(
                source_id=source_id,
                url=link,
                title=title,
                author=author,
                published_at=published_at,
                summary=summary,
                content=summary,
                content_html=description,
            )
            items.append(
                RawListItem(
                    source_id=source_id,
                    url=link,
                    title=title,
                    author=author,
                    published_at=published_at,
                    summary=summary,
                    fallback=fallback,
                )
            )
        # 短视频/短讯条目的 RSS 摘要与详情正文都很薄，排到末尾，优先入库扎实条目。
        items.sort(key=lambda item: len(item.summary) < 40)
        return RawPage(items=items, next_cursor=None)

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(soup, (".wysiwyg", ".node__content", "main"))
        body = clean_text(html_to_text(content_html))
        if len(body) >= 40:
            return RawArticle(
                source_id=item.source_id,
                url=item.url,
                title=item.title,
                author=item.author,
                published_at=item.published_at,
                summary=page_summary(soup, item.summary),
                content=body,
                content_html=content_html,
            )
        if item.fallback is not None:
            return item.fallback
        return RawArticle(
            source_id=item.source_id,
            url=item.url,
            title=item.title,
            author=item.author,
            published_at=item.published_at,
            summary=item.summary,
            content=item.summary,
        )


DESCRIPTOR = SourceDescriptor(
    id="ipsos",
    name="益普索",
    group="data",
    homepage="https://www.ipsos.com/zh-cn",
    adapter="rss",
    entry=FEED,
    pagination="none",
    capabilities=SourceCapabilities(content_mode="summary", supports_pagination=False),
    policy=SourcePolicy(
        interval_s=6 * 3600,
        detail_concurrency=2,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=30,
        max_pages=1,
    ),
    note="中文站更新周/月级；部分详情页为短视频/短讯，正文不足时以 RSS description 摘要兜底。",
)
ADAPTER = IpsosSource
