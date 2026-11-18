"""新浪财经（roll 滚动列表接口；转载稿保留原始来源到 author）。"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

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

LIST_API = (
    "https://feed.mix.sina.com.cn/api/roll/get"
    "?pageid=153&lid=2516&num=20&page={page}"
)
CST = timezone(timedelta(hours=8))


def _timestamp(value: object) -> str:
    try:
        ts = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return ""
    if not ts:
        return ""
    if ts > 1_000_000_000_000:
        ts //= 1000
    return datetime.fromtimestamp(ts, UTC).astimezone(CST).isoformat()


class SinaFinanceSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        page = int(cursor or "1")
        payload = await self.http.get_json(self.id, LIST_API.format(page=page))
        data = payload.get("result", {}).get("data")
        if not isinstance(data, list):
            raise TypeError("sina-finance 列表返回结构异常")
        entries: dict[str, RawListItem] = {}
        for raw in data:
            if not isinstance(raw, dict):
                continue
            url = str(raw.get("url") or raw.get("wapurl") or "").strip()
            title = clean_text(str(raw.get("title") or ""))
            source_id = str(raw.get("docid") or raw.get("oid") or "").strip()
            if not url or not title or not source_id:
                continue
            media = clean_text(str(raw.get("media_name") or raw.get("author") or ""))
            entries[source_id] = RawListItem(
                source_id=source_id,
                url=url,
                title=title,
                author=media,
                published_at=_timestamp(raw.get("ctime")),
                summary=clean_text(str(raw.get("intro") or raw.get("summary") or "")),
            )
        items = list(entries.values())
        return RawPage(items=items, next_cursor=str(page + 1) if items else None)

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(soup, (".article-content", "#artibody", ".main-content"))
        return RawArticle(
            source_id=item.source_id,
            url=item.url,
            title=page_title(soup, item.title),
            author=item.author,
            published_at=page_date(soup, item.published_at),
            summary=page_summary(soup, item.summary),
            content=html_to_text(content_html),
            content_html=content_html,
        )


DESCRIPTOR = SourceDescriptor(
    id="sina-finance",
    name="新浪财经",
    group="portal",
    homepage="https://finance.sina.com.cn/",
    adapter="json-list",
    entry=LIST_API.format(page=1),
    pagination="page",
    capabilities=SourceCapabilities(content_mode="full", supports_pagination=True),
    policy=SourcePolicy(
        interval_s=5 * 60,
        detail_concurrency=2,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=100,
        max_pages=3,
    ),
    note="以转载为主，原始来源写入 author（协议 RawArticle 无独立 media_name 字段）。",
)
ADAPTER = SinaFinanceSource
