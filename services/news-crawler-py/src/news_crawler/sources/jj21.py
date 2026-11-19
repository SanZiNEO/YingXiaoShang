from __future__ import annotations

from ..html import clean_text, normalize_date
from ..models import (
    RawArticle,
    RawListItem,
    RawPage,
    SourceCapabilities,
    SourceDescriptor,
    SourcePolicy,
)
from .base import NewsSource

BASE = "https://www.21jingji.com/"
LIST_API = "https://api.21jingji.com/timestream/getListweb?page={page}"


class Jj21Source(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        page = int(cursor or "1")
        payload = await self.http.get_json(self.id, LIST_API.format(page=page))
        records = payload.get("list") or []
        items: list[RawListItem] = []
        for record in records:
            item_id = str(record.get("id") or "").strip()
            title = clean_text(str(record.get("title") or ""))
            url = str(record.get("url") or "").strip()
            if not item_id or not title or not url:
                continue
            content = clean_text(str(record.get("content") or ""))
            published_at = normalize_date(str(record.get("inputtime") or ""))
            author = clean_text(str(record.get("username") or record.get("author") or ""))
            summary = clean_text(str(record.get("description") or "")) or content[:160]
            fallback = RawArticle(
                source_id=item_id,
                url=url,
                title=title,
                author=author,
                published_at=published_at,
                summary=summary,
                content=content,
                content_html="",
            )
            items.append(
                RawListItem(
                    source_id=item_id,
                    url=url,
                    title=title,
                    author=author,
                    published_at=published_at,
                    summary=summary,
                    fallback=fallback,
                )
            )
        return RawPage(items=items, next_cursor=str(page + 1) if items else None)

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
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
    id="jj21",
    name="21世纪经济报道",
    group="finance",
    homepage=BASE,
    adapter="json-list",
    entry=LIST_API.format(page=1),
    pagination="page",
    capabilities=SourceCapabilities(content_mode="full", supports_pagination=True),
    policy=SourcePolicy(
        interval_s=10 * 60,
        detail_concurrency=2,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=100,
        max_pages=5,
    ),
    note="快报接口列表已带全文；机器短讯多在数百字符内，短稿以摘要兜底，不逐篇打开详情页。",
)
ADAPTER = Jj21Source
