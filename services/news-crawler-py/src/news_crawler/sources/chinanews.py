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

BASE = "https://www.chinanews.com.cn/"
ENTRY = f"{BASE}finance/"
ARTICLE_RE = re.compile(r"^/cj/\d{4}/\d{2}-\d{2}/(\d+)\.shtml$")
DATE_RE = re.compile(r"(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\d{2}:\d{2})")
SOURCE_RE = re.compile(r"来源：\s*(\S+)")


def _single_title(title: str) -> str:
    parts = title.split(" ")
    if len(parts) == 2 and parts[0] and parts[0] == parts[1]:
        return parts[0]
    return title


class ChinanewsSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        html = await self.http.get_text(self.id, ENTRY)
        soup = soup_of(html)
        entries: dict[str, RawListItem] = {}
        for node in soup.find_all("a", href=True):
            href = str(node["href"])
            path = urlparse(urljoin(BASE, href)).path
            match = ARTICLE_RE.match(path)
            if not match:
                continue
            absolute = urljoin(BASE, href)
            title = _single_title(clean_text(node.get_text(" ")))
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
        return RawPage(items=list(entries.values()))

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(soup, (".content_maincontent_content", ".content"))
        title_node = soup.select_one(".content_left_title")
        title = clean_text(title_node.get_text(" ")) if title_node else ""
        author = ""
        published_at = item.published_at
        time_node = soup.select_one(".content_left_time")
        if time_node:
            meta = clean_text(time_node.get_text(" "))
            date_match = DATE_RE.search(meta)
            if date_match:
                published_at = normalize_date(
                    f"{date_match.group(1)}-{date_match.group(2)}-{date_match.group(3)} "
                    f"{date_match.group(4)}"
                ) or published_at
            source_match = SOURCE_RE.search(meta)
            if source_match:
                author = source_match.group(1)
        return RawArticle(
            source_id=item.source_id,
            url=item.url,
            title=title or page_title(soup, item.title),
            author=author,
            published_at=published_at,
            summary=page_summary(soup, item.summary),
            content=html_to_text(content_html),
            content_html=content_html,
        )


DESCRIPTOR = SourceDescriptor(
    id="chinanews",
    name="中国新闻网",
    group="portal",
    homepage="https://www.chinanews.com.cn/",
    adapter="html-list",
    entry="https://www.chinanews.com.cn/finance/",
    pagination="none",
    capabilities=SourceCapabilities(content_mode="full", supports_pagination=False),
    policy=SourcePolicy(
        interval_s=10 * 60,
        detail_concurrency=2,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=60,
        max_pages=1,
    ),
)
ADAPTER = ChinanewsSource
