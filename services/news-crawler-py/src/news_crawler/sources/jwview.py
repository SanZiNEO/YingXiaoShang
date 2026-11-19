from __future__ import annotations

import re
from urllib.parse import urljoin, urlparse

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

BASE = "https://www.jwview.com/"
# PC 频道页是 gb2312，抓取层只按 UTF-8 解码会丢字节；WAP 移动页同为 SSR 且是 UTF-8，
# 列表与详情统一走 /jingwei/html/m/ 移动路径。
LIST_PAGE = f"{BASE}jingwei/html/m/index.shtml"
ARTICLE_RE = re.compile(r"^/jingwei/html/(?:m/)?(\d{2}-\d{2})/(\d+)\.shtml$")
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?")


def mobile_url(match: re.Match[str]) -> str:
    return f"{BASE}jingwei/html/m/{match.group(1)}/{match.group(2)}.shtml"


class JwviewSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        html = await self.http.get_text(self.id, LIST_PAGE)
        soup = soup_of(html)
        entries: dict[str, RawListItem] = {}
        for node in soup.find_all("a", href=True):
            href = str(node["href"])
            path = urlparse(urljoin(BASE, href)).path
            match = ARTICLE_RE.match(path)
            if not match:
                continue
            absolute = mobile_url(match)
            if absolute in entries:
                continue
            entries[absolute] = RawListItem(
                source_id=match.group(2),
                url=absolute,
                title=clean_text(node.get_text(" ")),
            )
        return RawPage(items=list(entries.values()))

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(soup, (".content", ".content_zw"))
        author = ""
        published_at = item.published_at
        pubtime = soup.select_one(".pubtime")
        if pubtime:
            text = clean_text(pubtime.get_text(" "))
            date_match = DATE_RE.search(text)
            if date_match:
                published_at = normalize_date(date_match.group(0))
            parts = text.split("|", 1)
            author = clean_text(parts[0])
        title_node = soup.select_one(".title")
        title = clean_text(title_node.get_text(" ")) if title_node else page_title(soup, item.title)
        return RawArticle(
            source_id=item.source_id,
            url=item.url,
            title=title or item.title,
            author=author,
            published_at=published_at,
            summary=page_summary(soup, item.summary),
            content=html_to_text(content_html),
            content_html=content_html,
        )


DESCRIPTOR = SourceDescriptor(
    id="jwview",
    name="中新经纬",
    group="brandnews",
    homepage=BASE,
    adapter="html-list",
    entry=LIST_PAGE,
    pagination="none",
    capabilities=SourceCapabilities(content_mode="full", supports_pagination=False),
    policy=SourcePolicy(
        interval_s=10 * 60,
        detail_concurrency=2,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=50,
        max_pages=1,
    ),
    note="PC 页为 gb2312 编码，适配器改走 UTF-8 的 WAP 移动版路径（/jingwei/html/m/）。",
)
ADAPTER = JwviewSource
