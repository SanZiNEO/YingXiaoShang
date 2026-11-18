from __future__ import annotations

import re
from urllib.parse import urljoin, urlparse

from ..html import clean_text, first_html, html_to_text, normalize_date, page_summary, page_title
from ..models import (
    RawArticle,
    RawListItem,
    RawPage,
    SourceCapabilities,
    SourceDescriptor,
    SourcePolicy,
)
from .base import NewsSource, soup_of

BASE = "https://www.adquan.com/"
ARTICLE_RE = re.compile(r"^/article/(\d+)$")
DATE_PREFIX_RE = re.compile(r"发布时间：\s*(\S+(?:\s+\d{2}:\d{2})?)")


class AdquanSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        html = await self.http.get_text(self.id, BASE)
        soup = soup_of(html)
        entries: dict[str, RawListItem] = {}
        for node in soup.find_all("a", href=True):
            href = str(node["href"])
            path = urlparse(urljoin(BASE, href)).path
            match = ARTICLE_RE.match(path)
            if not match:
                continue
            absolute = urljoin(BASE, href)
            title = clean_text(node.get_text(" "))
            existing = entries.get(absolute)
            if existing:
                if not existing.title and title:
                    existing.title = title
                continue
            entries[absolute] = RawListItem(
                source_id=match.group(1),
                url=absolute,
                title=title,
            )
        return RawPage(items=list(entries.values()))

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(soup, (".articleContent", ".infoNewDIV", ".infoMain"))
        title_node = soup.select_one(".infoTitle_left")
        title = clean_text(title_node.get_text(" ")) if title_node else ""
        published_at = item.published_at
        time_node = soup.select_one(".infoTitle_right .time, .time")
        if time_node:
            meta = clean_text(time_node.get_text(" "))
            date_match = DATE_PREFIX_RE.search(meta)
            if date_match:
                published_at = normalize_date(date_match.group(1)) or published_at
        return RawArticle(
            source_id=item.source_id,
            url=item.url,
            title=title or page_title(soup, item.title),
            published_at=published_at,
            summary=page_summary(soup, item.summary),
            content=html_to_text(content_html),
            content_html=content_html,
        )


DESCRIPTOR = SourceDescriptor(
    id="adquan",
    name="广告门",
    group="case",
    homepage="https://www.adquan.com/",
    adapter="html-list",
    entry="https://www.adquan.com/",
    pagination="none",
    capabilities=SourceCapabilities(
        anti_crawler=True,
        requires_browser=True,
        content_mode="full",
        supports_pagination=False,
    ),
    policy=SourcePolicy(
        interval_s=30 * 60,
        detail_concurrency=1,
        min_interval_ms=2_000,
        timeout_s=30.0,
        retries=0,
        max_items=60,
        max_pages=1,
    ),
    enabled=False,
    note="详情页被阿里云 WAF 挑战拦截（renderData/arg1/aliyun_waf 挑战壳），裸 HTTP 无法取正文；列表页仍正常。2026-11-18 联调实测，降速（concurrency=1、2s 间隔、retries=0）后详情仍被挑战，暂不接入，待浏览器兜底可用后再接。",
)
ADAPTER = AdquanSource
