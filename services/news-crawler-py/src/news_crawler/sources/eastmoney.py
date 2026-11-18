"""东方财富（kuaixun v2 快讯；只取财经资讯，不取股吧 UGC）。"""
from __future__ import annotations

import re

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

LIST_API = (
    "https://newsapi.eastmoney.com/kuaixun/v2/api/list"
    "?column=102&limit=20&p={page}"
)
SOURCE_RE = re.compile(r"来源：\s*(\S+)")
TITLE_SUFFIX_RE = re.compile(r"\s*_\s*东方财富网$")


class EastmoneySource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        page = int(cursor or "1")
        payload = await self.http.get_json(self.id, LIST_API.format(page=page))
        news = payload.get("news")
        if not isinstance(news, list):
            raise TypeError("eastmoney 列表返回结构异常")
        entries: dict[str, RawListItem] = {}
        for raw in news:
            if not isinstance(raw, dict):
                continue
            url = str(raw.get("url_w") or raw.get("url_unique") or "").strip()
            title = clean_text(str(raw.get("title") or ""))
            source_id = str(raw.get("newsid") or raw.get("id") or "").strip()
            if not url or not title or not source_id:
                continue
            media = clean_text(str(raw.get("Art_Media_Name") or ""))
            entries[source_id] = RawListItem(
                source_id=source_id,
                url=url,
                title=title,
                author=media,
                published_at=normalize_date(str(raw.get("showtime") or "")),
                summary=clean_text(str(raw.get("digest") or "")),
            )
        items = list(entries.values())
        return RawPage(items=items, next_cursor=str(page + 1) if items else None)

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(soup, (".contentbox", ".mainleft", ".zwinfos"))
        author = item.author
        published_at = item.published_at
        infos = soup.select_one(".infos")
        if infos:
            meta = clean_text(infos.get_text(" "))
            source_match = SOURCE_RE.search(meta)
            if source_match and not author:
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
    id="eastmoney",
    name="东方财富",
    group="portal",
    homepage="https://www.eastmoney.com/",
    adapter="json-list",
    entry=LIST_API.format(page=1),
    pagination="page",
    capabilities=SourceCapabilities(content_mode="summary", supports_pagination=True),
    policy=SourcePolicy(
        interval_s=5 * 60,
        detail_concurrency=2,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=100,
        max_pages=3,
    ),
    note="快讯型源：正文短，以 digest 补摘要；仅取 kuaixun 资讯，股吧 UGC 未接入。",
)
ADAPTER = EastmoneySource
