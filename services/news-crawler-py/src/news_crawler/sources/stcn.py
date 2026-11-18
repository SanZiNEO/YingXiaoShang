from __future__ import annotations

import re
from urllib.parse import urljoin, urlparse

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

BASE = "https://www.stcn.com/"
LIST_API = f"{BASE}article/list.html"
LIST_REFERER = f"{BASE}article/list/xw.html"
DETAIL_RE = re.compile(r"^/article/detail/(\d+)\.html$")
AUTHOR_RE = re.compile(r"^([^/\n]{1,20})/文")


class StcnSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        page_time = int(cursor or "1")
        url = f"{LIST_API}?type=xw&page_time={page_time}"
        payload = await self.http.get_json(
            self.id,
            url,
            headers={"referer": LIST_REFERER, "x-requested-with": "XMLHttpRequest"},
        )
        if payload.get("state") != 1 or not isinstance(payload.get("data"), str):
            raise RuntimeError(f"stcn list state {payload.get('state')}")
        soup = soup_of(f"<ul>{payload['data']}</ul>")
        entries: dict[str, RawListItem] = {}
        for node in soup.find_all("a"):
            path = urlparse(urljoin(BASE, str(node.get("href") or ""))).path
            match = DETAIL_RE.match(path)
            if not match:
                continue
            absolute = urljoin(BASE, path)
            if absolute in entries:
                continue
            entries[absolute] = RawListItem(
                source_id=match.group(1),
                url=absolute,
                title=clean_text(node.get_text(" ")),
            )
        items = list(entries.values())
        next_cursor = str(payload["page_time"]) if payload.get("page_time") else None
        return RawPage(items=items, next_cursor=next_cursor)

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(soup, (".detail-content-wrapper",))
        author = ""
        wrapper = soup.select_one(".detail-content-wrapper")
        if wrapper:
            match = AUTHOR_RE.search(clean_text(wrapper.get_text(" ")))
            if match:
                author = match.group(1)
        return RawArticle(
            source_id=item.source_id,
            url=item.url,
            title=page_title(soup, item.title),
            author=author,
            published_at=page_date(soup, item.published_at),
            summary=page_summary(soup, item.summary),
            content=html_to_text(content_html),
            content_html=content_html,
        )


DESCRIPTOR = SourceDescriptor(
    id="stcn",
    name="证券时报",
    group="finance",
    homepage="https://www.stcn.com/",
    adapter="json-list",
    entry="https://www.stcn.com/article/list.html?type=xw&page_time=1",
    pagination="cursor",
    capabilities=SourceCapabilities(
        anti_crawler=True,
        content_mode="full",
        supports_pagination=True,
    ),
    policy=SourcePolicy(
        interval_s=10 * 60,
        detail_concurrency=2,
        min_interval_ms=500,
        timeout_s=30.0,
        retries=2,
        max_items=100,
        max_pages=5,
    ),
)
ADAPTER = StcnSource
