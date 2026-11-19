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

BASE = "https://www.ebrun.com/"
LIST_PAGE = BASE
DATE_PATH_RE = re.compile(r"^/(\d{8})/(\d+)\.shtml$")
ZB_PATH_RE = re.compile(r"^/ebrungo/zb/(\d+)\.shtml$")
# WAF 首访返回 345 字节挑战脚本，下发轮换的 C3VK cookie，带 cookie 重取即放行。
CHALLENGE_RE = re.compile(r"C3VK=([0-9a-f]+)")


def _match_id(path: str) -> str | None:
    match = DATE_PATH_RE.match(path)
    if match:
        return match.group(2)
    match = ZB_PATH_RE.match(path)
    return match.group(1) if match else None


class EbrunSource(NewsSource):
    def __init__(self, http, descriptor) -> None:
        super().__init__(http, descriptor)
        self._cookie: str | None = None

    async def _get_text(self, url: str) -> str:
        headers = {"cookie": self._cookie} if self._cookie else None
        text = await self.http.get_text(self.id, url, headers=headers)
        if len(text) < 1000 and "C3VK=" in text:
            match = CHALLENGE_RE.search(text)
            if match:
                self._cookie = f"C3VK={match.group(1)}"
                text = await self.http.get_text(
                    self.id, url, headers={"cookie": self._cookie}
                )
        return text

    async def list_page(self, cursor: str | None) -> RawPage:
        html = await self._get_text(LIST_PAGE)
        soup = soup_of(html)
        entries: dict[str, RawListItem] = {}
        for node in soup.find_all("a", href=True):
            href = str(node["href"])
            path = urlparse(urljoin(BASE, href)).path
            source_id = _match_id(path)
            if not source_id:
                continue
            absolute = urljoin(BASE, path)
            if absolute in entries:
                continue
            entries[absolute] = RawListItem(
                source_id=source_id,
                url=absolute,
                title=clean_text(node.get_text(" ")),
            )
        return RawPage(items=list(entries.values()))

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self._get_text(item.url)
        soup = soup_of(html)
        content_html = first_html(soup, (".post-text", ".article-detail", ".article-body"))
        author = item.author
        author_node = soup.select_one(".source .info span, .source span")
        if author_node:
            author = clean_text(author_node.get_text(" ")).removeprefix(
                "作者："
            ).removeprefix("文章来源：")
        published_at = item.published_at
        date_node = soup.select_one(".date-time")
        if date_node:
            published_at = normalize_date(clean_text(date_node.get_text(" ")))
        summary = item.summary
        note_node = soup.select_one(".editor-note")
        if note_node:
            summary = clean_text(note_node.get_text(" "))
        return RawArticle(
            source_id=item.source_id,
            url=item.url,
            title=page_title(soup, item.title),
            author=author,
            published_at=published_at,
            summary=page_summary(soup, summary),
            content=html_to_text(content_html),
            content_html=content_html,
        )


DESCRIPTOR = SourceDescriptor(
    id="ebrun",
    name="亿邦动力",
    group="ecommerce",
    homepage=BASE,
    adapter="html-list",
    entry=LIST_PAGE,
    pagination="none",
    capabilities=SourceCapabilities(
        anti_crawler=True, content_mode="full", supports_pagination=False
    ),
    policy=SourcePolicy(
        interval_s=10 * 60,
        detail_concurrency=1,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=50,
        max_pages=1,
    ),
    note=(
        "WAF 首访下发轮换 C3VK cookie，适配器在适配器内提取该 cookie 后重取；"
        "原创长文与 ebrungo/zb 快讯两类路径都收录，正文容器 .post-text。"
    ),
)
ADAPTER = EbrunSource
