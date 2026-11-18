"""中国名牌网（新华社《中国名牌》杂志官网；首访有 WAF 会话校验，需二次放行）。"""
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

BASE = "https://www.chinatopbrands.net/"
ARTICLE_RE = re.compile(r"/s/\d+-\d+-(\d+)\.html")
CHALLENGE_RE = re.compile(r"WebShieldSessionVerify=([A-Za-z0-9]+)")
DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})")
SOURCE_RE = re.compile(r"来源[:：]\s*(\S+)")
TITLE_SUFFIX_RE = re.compile(r"(_中国名牌网)+$")


class ChinatopbrandsSource(NewsSource):
    async def _home_html(self) -> str:
        html = await self.http.get_text(self.id, self.descriptor.entry)
        token = CHALLENGE_RE.search(html)
        if not token:
            return html
        # WAF 会话校验：带一次性 token 回跳一次，匿名 Cookie 由 HttpClient 保留
        await self.http.get_text(
            self.id, f"{self.descriptor.entry}?WebShieldSessionVerify={token.group(1)}"
        )
        html = await self.http.get_text(self.id, self.descriptor.entry)
        if CHALLENGE_RE.search(html):
            raise RuntimeError("chinatopbrands WAF 会话校验未通过（2026-11-18）")
        return html

    async def list_page(self, cursor: str | None) -> RawPage:
        html = await self._home_html()
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
        content_html = first_html(soup, ("#Content", ".det_right", ".GoneContainer_without_title"))
        author = item.author
        published_at = item.published_at
        head = soup.select_one(".zgmpw_second_detail, .det_right")
        if head:
            meta = clean_text(head.get_text(" "))
            date_match = DATE_RE.search(meta)
            if date_match:
                published_at = normalize_date(f"{date_match.group(1)} {date_match.group(2)}")
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
    id="chinatopbrands",
    name="中国名牌网",
    group="brandnews",
    homepage="https://www.chinatopbrands.net/",
    adapter="html-list",
    entry="https://www.chinatopbrands.net/",
    pagination="none",
    capabilities=SourceCapabilities(
        anti_crawler=True,
        content_mode="full",
        supports_pagination=False,
    ),
    policy=SourcePolicy(
        interval_s=15 * 60,
        detail_concurrency=1,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=60,
        max_pages=1,
    ),
    note="首访返回 WebShieldSessionVerify 会话校验页，适配器按 token 二次回跳放行；转载稿标注原始来源。",
)
ADAPTER = ChinatopbrandsSource
