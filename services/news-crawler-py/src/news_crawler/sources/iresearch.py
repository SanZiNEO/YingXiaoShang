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

BASE = "https://www.iresearch.com.cn/"
INDEX_API = f"{BASE}api/Home/GetIndexReport"
HOT_API = f"{BASE}api/products/GetHotReportList"


def _norm_date(value: str) -> str:
    return normalize_date(value.replace("/", "-"))


class IresearchSource(NewsSource):
    async def _fetch(self, url: str) -> list[dict]:
        payload = await self.http.get_json(self.id, url)
        records = payload.get("List") or []
        return [record for record in records if isinstance(record, dict)]

    async def list_page(self, cursor: str | None) -> RawPage:
        merged: dict[str, RawListItem] = {}
        for endpoint in (INDEX_API, HOT_API):
            for record in await self._fetch(endpoint):
                news_id = str(record.get("NewsId") or record.get("Id") or "").strip()
                title = clean_text(str(record.get("Title") or record.get("sTitle") or ""))
                url = str(record.get("VisitUrl") or "").strip()
                if not news_id or not title or not url:
                    continue
                if news_id in merged:
                    continue
                content = clean_text(str(record.get("Content") or ""))
                published_at = _norm_date(str(record.get("Uptime") or ""))
                author = clean_text(str(record.get("Author") or ""))
                fallback = RawArticle(
                    source_id=news_id,
                    url=url,
                    title=title,
                    author=author,
                    published_at=published_at,
                    summary=content,
                    content=content,
                    content_html="",
                )
                merged[news_id] = RawListItem(
                    source_id=news_id,
                    url=url,
                    title=title,
                    author=author,
                    published_at=published_at,
                    summary=content,
                    fallback=fallback,
                )
        return RawPage(items=list(merged.values()), next_cursor=None)

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
    id="iresearch",
    name="艾瑞咨询",
    group="data",
    homepage=BASE,
    adapter="json-list",
    entry=INDEX_API,
    pagination="none",
    capabilities=SourceCapabilities(content_mode="summary", supports_pagination=False),
    policy=SourcePolicy(
        interval_s=12 * 3600,
        detail_concurrency=2,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=30,
        max_pages=1,
    ),
    note="研究报告全文/PDF 需留资下载，仅入库接口公开摘要；报告详情页为 GBK 编码，未直连抓取正文。",
)
ADAPTER = IresearchSource
