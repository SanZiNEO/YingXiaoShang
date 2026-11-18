"""雨果跨境（CIFNews）：跨境电商资讯，首页 SSR HTML 列表 + 详情页正文容器。"""

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

BASE = "https://www.cifnews.com/"
ARTICLE_RE = re.compile(r"^/article/(\d+)/?$")
# 2026-11-18: the desktop UA is answered with an Aliyun WAF 405 page while the
# mobile UA gets the normal SSR article. Keep this source on a mobile identity.
MOBILE_HEADERS = {
    "user-agent": (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 "
        "Mobile/15E148 Safari/604.1"
    ),
}


class CifnewsSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        html = await self.http.get_text(self.id, BASE, headers=MOBILE_HEADERS)
        soup = soup_of(html)
        entries: dict[str, RawListItem] = {}
        for node in soup.find_all("a"):
            href = str(node.get("href") or "")
            path = urlparse(urljoin(BASE, href)).path
            match = ARTICLE_RE.match(path)
            if not match:
                continue
            article_id = match.group(1)
            if article_id in entries:
                continue
            title = clean_text(node.get("data-fetch-title") or node.get_text(" "))
            entries[article_id] = RawListItem(
                source_id=article_id,
                url=urljoin(BASE, path),
                title=title,
            )
        return RawPage(items=list(entries.values()), next_cursor=None)

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url, headers=MOBILE_HEADERS)
        soup = soup_of(html)
        content_html = first_html(soup, (".article-content", ".article-detail"))
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
    id="cifnews",
    name="雨果跨境",
    group="ecommerce",
    homepage=BASE,
    adapter="html-list",
    entry=BASE,
    pagination="none",
    capabilities=SourceCapabilities(content_mode="full", supports_pagination=False),
    policy=SourcePolicy(
        interval_s=15 * 60,
        detail_concurrency=2,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=50,
        max_pages=1,
    ),
    note="桌面 UA 会触发阿里云 WAF 405；适配器统一使用移动端 UA，详情可并发抓取。",
)
ADAPTER = CifnewsSource
