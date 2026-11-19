"""中国日报商业频道（英文站；正文保留原文，元信息优先取 JSON-LD）。"""
from __future__ import annotations

import json
import re
from urllib.parse import urljoin, urlparse

from ..html import clean_text, first_html, html_to_text, page_summary, page_title
from ..models import (
    RawArticle,
    RawListItem,
    RawPage,
    SourceCapabilities,
    SourceDescriptor,
    SourcePolicy,
)
from .base import NewsSource, soup_of

BASE = "https://www.chinadaily.com.cn/"
ENTRY = f"{BASE}business"
ARTICLE_RE = re.compile(r"/a/\d{6}/\d{2}/(WS\w+)\.html")


def _json_ld(soup) -> dict:  # type: ignore[no-untyped-def]
    for tag in soup.find_all("script", type="application/ld+json"):
        if not tag.string:
            continue
        try:
            payload = json.loads(tag.string)
        except ValueError:
            continue
        if isinstance(payload, dict):
            return payload
    return {}


class ChinadailyBusinessSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        html = await self.http.get_text(self.id, ENTRY)
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
        content_html = first_html(soup, ("#Content.Artical_Content", "#Content"))
        ld = _json_ld(soup)
        published_at = clean_text(str(ld.get("datePublished") or "")) or item.published_at
        author = ""
        ld_author = ld.get("author")
        if isinstance(ld_author, dict):
            author = clean_text(str(ld_author.get("name") or ""))
        elif isinstance(ld_author, str):
            author = clean_text(ld_author)
        if not author:
            meta = soup.select_one("meta[name='author']")
            if meta and meta.get("content"):
                author = clean_text(str(meta["content"]))
        title = clean_text(str(ld.get("headline") or "")) or page_title(soup, item.title)
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
    id="chinadaily-business",
    name="中国日报商业",
    group="portal",
    homepage="https://www.chinadaily.com.cn/business",
    adapter="html-list",
    entry="https://www.chinadaily.com.cn/business",
    pagination="none",
    capabilities=SourceCapabilities(content_mode="full", supports_pagination=False),
    language="en",
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
ADAPTER = ChinadailyBusinessSource
