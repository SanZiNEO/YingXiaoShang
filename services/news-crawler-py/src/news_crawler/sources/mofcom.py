from __future__ import annotations

import re
from urllib.parse import urlencode, urljoin

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

BASE = "https://www.mofcom.gov.cn/"
UNIT_API = BASE + "api-gateway/jpaas-publish-server/front/page/build/unit"
QUERY = {
    "parseType": "bulidstatic",
    "webId": "8f43c7ad3afc411fb56f281724b73708",
    "tplSetId": "52551ea0e2c14bca8c84792f7aa37ead",
    "pageType": "column",
    "tagId": "分页列表",
    "editType": "null",
    "pageId": "95d89972d8aa4fcea511701cd0f212d9",
}
DETAIL_RE = re.compile(r"art_([a-f0-9]+)\.html$")


class MofcomSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        url = f"{UNIT_API}?{urlencode(QUERY)}"
        payload = await self.http.get_json(self.id, url)
        fragment = (payload.get("data") or {}).get("html") or ""
        soup = soup_of(fragment)
        entries: dict[str, RawListItem] = {}
        for node in soup.select("ul.txtList_01 li a[href]"):
            href = str(node.get("href") or "")
            match = DETAIL_RE.search(href)
            if not match:
                continue
            absolute = urljoin(BASE, href)
            if absolute in entries:
                continue
            title = clean_text(str(node.get("title") or "") or node.get_text(" "))
            if not title:
                continue
            li = node.find_parent("li")
            date_node = li.find("span") if li else None
            raw_date = clean_text(date_node.get_text(" ")) if date_node else ""
            entries[absolute] = RawListItem(
                source_id=match.group(1),
                url=absolute,
                title=title,
                published_at=normalize_date(raw_date.strip("[]")),
            )
        return RawPage(items=list(entries.values()), next_cursor=None)

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(soup, (".art-con",))
        title_node = soup.select_one(".art-title")
        return RawArticle(
            source_id=item.source_id,
            url=item.url,
            title=clean_text(title_node.get_text(" ")) if title_node else page_title(soup, item.title),
            published_at=page_date(soup, item.published_at),
            summary=page_summary(soup, item.summary),
            content=html_to_text(content_html),
            content_html=content_html,
        )


DESCRIPTOR = SourceDescriptor(
    id="mofcom",
    name="商务部",
    group="official",
    homepage=BASE,
    adapter="json-list",
    entry=f"{UNIT_API}?{urlencode(QUERY)}",
    pagination="none",
    capabilities=SourceCapabilities(content_mode="full", supports_pagination=False),
    policy=SourcePolicy(
        interval_s=2 * 3600,
        detail_concurrency=1,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=30,
        max_pages=1,
    ),
    note="仅接入日常新闻发布（rcxwfb）栏目；政策图解、统计数据等栏目未纳入。",
)
ADAPTER = MofcomSource
