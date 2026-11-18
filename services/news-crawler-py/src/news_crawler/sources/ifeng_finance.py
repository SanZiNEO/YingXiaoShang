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

BASE = "https://finance.ifeng.com/"
LIST_PAGE = BASE
# original / finance / tech / biz 频道的正文页；专题页 /c/special/ 排除。
ARTICLE_RE = re.compile(
    r"^(?:(?:https?:)?//)?(?:original|finance|tech|biz)\.ifeng\.com/c/([A-Za-z0-9]+)$"
)


class IfengFinanceSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        html = await self.http.get_text(self.id, LIST_PAGE)
        soup = soup_of(html)
        entries: dict[str, RawListItem] = {}
        for node in soup.find_all("a", href=True):
            href = str(node["href"]).strip()
            if "/c/special/" in href:
                continue
            parsed = urlparse(urljoin(BASE, href))
            match = ARTICLE_RE.match(f"{parsed.netloc}{parsed.path}")
            if not match:
                continue
            absolute = parsed._replace(params="", query="", fragment="").geturl()
            if absolute in entries:
                continue
            entries[absolute] = RawListItem(
                source_id=match.group(1),
                url=absolute,
                title=clean_text(node.get_text(" ")),
            )
        return RawPage(items=list(entries.values()))

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(
            soup,
            ('section[aria-label="正文"]', ".index_main_content_j-HoG", "article"),
        )
        author = item.author
        author_node = soup.select_one('a[rel="medianame"], .index_sourceTitleText_wlTy- a')
        if author_node:
            author = clean_text(author_node.get_text(" "))
        published_at = item.published_at
        time_node = soup.select_one("time[itemProp=datePublished], time[itemprop=datePublished]")
        if time_node:
            published_at = normalize_date(
                clean_text(time_node.get("datetime") or time_node.get_text(" "))
            )
        return RawArticle(
            source_id=item.source_id,
            url=item.url,
            title=page_title(soup, item.title),
            author=author,
            published_at=published_at,
            summary=page_summary(soup, item.summary),
            content=html_to_text(content_html),
            content_html=content_html,
        )


DESCRIPTOR = SourceDescriptor(
    id="ifeng-finance",
    name="凤凰网财经",
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
    note="正文容器 section[aria-label=\"正文\"]，样式类名带哈希时回退 article。",
)
ADAPTER = IfengFinanceSource
