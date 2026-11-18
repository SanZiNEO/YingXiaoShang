"""中国企业报道（企业新闻门户；转载稿保留原始来源）。"""
from __future__ import annotations

import re
from urllib.parse import urljoin, urlparse

from ..html import (
    clean_text,
    first_html,
    html_to_text,
    normalize_date,
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

BASE = "https://www.cenr.com.cn/"
ARTICLE_RE = re.compile(r"/\d{4}/\d{2}/\d{2}/(\d+)\.html")
CN_DATE_RE = re.compile(r"(\d{4})年(\d{1,2})月(\d{1,2})日")
SOURCE_RE = re.compile(r"来源：\s*(\S+)")
TITLE_SUFFIX_RE = re.compile(r"-中国企业报道$")


class CenrSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        html = await self.http.get_text(self.id, self.descriptor.entry)
        soup = soup_of(html)
        entries: dict[str, RawListItem] = {}
        for node in soup.find_all("a", href=True):
            href = str(node["href"])
            path = urlparse(urljoin(BASE, href)).path
            match = ARTICLE_RE.search(path)
            if not match:
                continue
            absolute = urljoin(BASE, href)
            if absolute in entries:
                continue
            entries[absolute] = RawListItem(
                source_id=match.group(1),
                url=absolute,
                title=clean_text(node.get_text(" ")),
            )
        return RawPage(items=list(entries.values()))

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(soup, (".con.size18.gray", ".details"))
        author = item.author
        published_at = item.published_at
        head = soup.select_one(".details, .fl_l.w_910")
        if head:
            meta = clean_text(head.get_text(" "))
            date_match = CN_DATE_RE.search(meta)
            if date_match:
                published_at = normalize_date(
                    f"{date_match.group(1)}-{date_match.group(2)}-{date_match.group(3)}"
                )
            source_match = SOURCE_RE.search(meta)
            if source_match:
                author = source_match.group(1)
        title = TITLE_SUFFIX_RE.sub("", page_title(soup, item.title)).strip()
        return RawArticle(
            source_id=item.source_id,
            url=item.url,
            title=title,
            author=author,
            published_at=published_at,
            summary=page_summary(soup, item.summary),
            content=html_to_text(content_html),
            content_html=content_html,
        )


DESCRIPTOR = SourceDescriptor(
    id="cenr",
    name="中国企业报道",
    group="brandnews",
    homepage="https://www.cenr.com.cn/",
    adapter="html-list",
    entry="https://www.cenr.com.cn/",
    pagination="none",
    capabilities=SourceCapabilities(content_mode="full", supports_pagination=False),
    policy=SourcePolicy(
        interval_s=15 * 60,
        detail_concurrency=2,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=60,
        max_pages=1,
    ),
)
ADAPTER = CenrSource
