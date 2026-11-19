from __future__ import annotations

from datetime import datetime, timedelta, timezone

from ..html import (
    clean_text,
    first_html,
    html_to_text,
    page_date,
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

BASE = "https://www.cbndata.com/"
LIST_API = (
    "https://api-next.cbndata.com/consumerstation/web/home/informations"
    "?pageIndex={page}&pageSize=20&oldTagId="
)
DETAIL_URL = f"{BASE}information/{{id}}"
CST = timezone(timedelta(hours=8))


def _epoch_ms(value: object) -> str:
    try:
        ts = int(value) / 1000
        return datetime.fromtimestamp(ts, CST).isoformat()
    except (TypeError, ValueError, OverflowError):
        return ""


class CbndataSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        page = int(cursor or "1")
        payload = await self.http.get_json(self.id, LIST_API.format(page=page))
        records = (payload.get("data") or {}).get("list") or []
        items: list[RawListItem] = []
        for record in records:
            item_id = str(record.get("id") or "").strip()
            title = clean_text(str(record.get("title") or ""))
            if not item_id or not title:
                continue
            items.append(
                RawListItem(
                    source_id=item_id,
                    url=DETAIL_URL.format(id=item_id),
                    title=title,
                    published_at=_epoch_ms(record.get("date")),
                )
            )
        return RawPage(items=items, next_cursor=str(page + 1) if items else None)

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(soup, (".detail-main-content", "section.content", ".content"))
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
    id="cbndata",
    name="CBNData",
    group="data",
    homepage=BASE,
    adapter="json-list",
    entry=LIST_API.format(page=1),
    pagination="page",
    capabilities=SourceCapabilities(content_mode="full", supports_pagination=True),
    policy=SourcePolicy(
        interval_s=30 * 60,
        detail_concurrency=2,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=100,
        max_pages=5,
    ),
)
ADAPTER = CbndataSource
