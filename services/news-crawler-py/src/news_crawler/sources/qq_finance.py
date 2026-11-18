from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

from ..html import (
    clean_text,
    first_html,
    html_to_text,
    normalize_date,
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

FEED_API = "https://i.news.qq.com/web_feed/getPCList"
REFERER = "https://news.qq.com/ch/finance/"
CHANNEL = "news_news_finance"


def _flatten(items: list[dict[str, Any]], out: list[dict[str, Any]]) -> None:
    for item in items:
        sub = item.get("sub_item")
        if isinstance(sub, list) and sub:
            _flatten(sub, out)
        else:
            out.append(item)


class QqFinanceSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        page = int(cursor or "1")
        query = urlencode(
            {
                "base_req[from]": "pc",
                "forward": "2",
                "flush_num": str(page),
                "channel_id": CHANNEL,
                "item_count": 12,
                "is_local_chlid": "0",
            }
        )
        payload = await self.http.get_json(
            self.id,
            f"{FEED_API}?{query}",
            headers={"referer": REFERER, "x-requested-with": "XMLHttpRequest"},
        )
        groups = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(groups, list):
            raise TypeError("qq-finance feed payload missing data list")
        flat: list[dict[str, Any]] = []
        _flatten(groups, flat)
        entries: dict[str, RawListItem] = {}
        for item in flat:
            source_id = str(item.get("id") or "").strip()
            link_info = item.get("link_info") or {}
            url = str(link_info.get("share_url") or "").strip()
            title = clean_text(str(item.get("title") or ""))
            # articletype=4 为视频/短条详情页，无文章正文，列表层排除。
            if not source_id or not url or not title or str(item.get("articletype")) == "4":
                continue
            media = item.get("media_info") or {}
            author = clean_text(str(media.get("chl_name") or ""))
            published_at = normalize_date(str(item.get("publish_time") or ""))
            entries[url] = RawListItem(
                source_id=source_id,
                url=url,
                title=title,
                author=author,
                published_at=published_at,
                summary=clean_text(str(item.get("abstract") or "")),
            )
        items = list(entries.values())
        return RawPage(items=items, next_cursor=str(page + 1) if items else None)

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(soup, (".content", "article", "main"))
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
    id="qq-finance",
    name="腾讯新闻产经",
    group="brandnews",
    homepage=REFERER,
    adapter="spa-json",
    entry=FEED_API,
    pagination="cursor",
    capabilities=SourceCapabilities(content_mode="full", supports_pagination=True),
    policy=SourcePolicy(
        interval_s=5 * 60,
        detail_concurrency=2,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=50,
        max_pages=3,
    ),
    note="getPCList 走 GET 查询参数（base_req[from] 括号形态），子条目递归展开；正文取详情页 .content。",
)
ADAPTER = QqFinanceSource
