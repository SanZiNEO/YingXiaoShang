"""中欧国际工商学院：Drupal RSS，description 即正文 HTML；详情页 article 容器补抓。"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from urllib.parse import urlparse

from ..html import clean_text, html_to_text, normalize_date, page_summary, page_title
from ..models import (
    RawArticle,
    RawListItem,
    RawPage,
    SourceCapabilities,
    SourceDescriptor,
    SourcePolicy,
)
from .base import NewsSource, soup_of

FEED = "https://cn.ceibs.edu/rss.xml"
DC_NS = "{http://purl.org/dc/elements/1.1/}creator"
NUM_RE = re.compile(r"(\d+)/?$")


def source_id_of(url: str) -> str:
    match = NUM_RE.search(urlparse(url).path.strip("/").split("/")[-1])
    return match.group(1) if match else urlparse(url).path.strip("/").replace("/", "-")


class CeibsSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        xml = await self.http.get_text(self.id, FEED)
        root = ET.fromstring(xml)
        items: list[RawListItem] = []
        for node in root.findall(".//item"):
            title = clean_text(node.findtext("title") or "")
            link = clean_text(node.findtext("link") or "")
            if not title or not link:
                continue
            description = node.findtext("description") or ""
            summary = clean_text(html_to_text(description))
            published_at = normalize_date(node.findtext("pubDate") or "")
            author = clean_text(node.findtext(DC_NS) or "")
            source_id = source_id_of(link)
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
        return RawPage(items=items, next_cursor=None)

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        article = soup.select_one("article")
        body = clean_text(article.get_text(" ")) if article else ""
        if len(body) >= 40:
            content_html = "".join(str(child) for child in article.contents)
            return RawArticle(
                source_id=item.source_id,
                url=item.url,
                title=page_title(soup, item.title),
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
    id="ceibs",
    name="中欧国际工商学院",
    group="consulting",
    homepage="https://cn.ceibs.edu/",
    adapter="rss",
    entry=FEED,
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
    note="商学院观点/研究/活动动态，非新闻流；RSS description 已含正文，课程招生页面不在 feed 内。",
)
ADAPTER = CeibsSource
