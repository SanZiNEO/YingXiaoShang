"""财联社（7×24 电报 / 快评；列表取自首页 __NEXT_DATA__）。"""
from __future__ import annotations

import json
import re
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

BASE = "https://www.cls.cn/"
DETAIL_URL = f"{BASE}detail/{{article_id}}"
NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.DOTALL
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


class ClsSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        html = await self.http.get_text(self.id, self.descriptor.entry)
        match = NEXT_DATA_RE.search(html)
        if not match:
            raise RuntimeError("cls 首页未找到 __NEXT_DATA__")
        payload = json.loads(match.group(1))
        assemble = (
            payload.get("props", {})
            .get("pageProps", {})
            .get("assembleData", {})
        )
        entries: dict[str, RawListItem] = {}
        for bucket in ("depth_list", "top_article"):
            for raw in assemble.get(bucket) or []:
                if not isinstance(raw, dict):
                    continue
                article_id = str(raw.get("id") or "").strip()
                title = clean_text(str(raw.get("title") or ""))
                if not article_id or not title:
                    continue
                if raw.get("is_ad") or raw.get("external_link"):
                    continue
                if article_id in entries:
                    continue
                author = clean_text(str(raw.get("source") or raw.get("author") or ""))
                entries[article_id] = RawListItem(
                    source_id=article_id,
                    url=DETAIL_URL.format(article_id=article_id),
                    title=title,
                    author=author,
                    published_at=_timestamp(raw.get("ctime")),
                    summary=clean_text(str(raw.get("brief") or "")),
                )
        return RawPage(items=list(entries.values()))

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(soup, (".detail-content",))
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
    id="cls",
    name="财联社",
    group="portal",
    homepage="https://www.cls.cn/",
    adapter="spa-json",
    entry="https://www.cls.cn/",
    pagination="none",
    capabilities=SourceCapabilities(content_mode="full", supports_pagination=False),
    policy=SourcePolicy(
        interval_s=5 * 60,
        detail_concurrency=2,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=60,
        max_pages=1,
    ),
    note="快讯型源：电报短稿正文常不足 300 字，以 brief/summary 兜底；无付费锁。",
)
ADAPTER = ClsSource
