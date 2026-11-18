"""One-off URL ingestion used by the AI/desktop "paste a link" path.

Registered-source adapters are the normal collection path. This module is the
explicit exception: it fetches a single URL on demand, extracts a generic
article body, normalizes it through the same contract and writes it through the
same SQLite sink. It never expands into a site-wide crawl.
"""

from __future__ import annotations

from pathlib import Path
from urllib.parse import urlparse

from bs4 import BeautifulSoup

from .html import clean_text, html_to_text, page_date, page_summary, page_title
from .http import HttpClient, HttpPolicy
from .models import (
    RawArticle,
    SourceCapabilities,
    SourceDescriptor,
    SourcePolicy,
)
from .normalize import NormalizedArticle, normalize
from .output import SQLiteSink

_BODY_SELECTORS = (
    "article",
    "main",
    "[itemprop='articleBody']",
    "#article",
    "#content",
    ".article-content",
    ".article_body",
    ".post-content",
    ".rich_media_content",
)


class AdhocError(RuntimeError):
    pass


def _descriptor(url: str) -> SourceDescriptor:
    host = urlparse(url).netloc
    return SourceDescriptor(
        id="manual",
        name=host or "网页",
        group="manual",
        homepage=url,
        adapter="adhoc",
        entry="",
        pagination="single",
        capabilities=SourceCapabilities(
            requires_browser=False,
            anti_crawler=False,
            auth="none",
            content_mode="full",
            supports_pagination=False,
        ),
        policy=SourcePolicy(
            interval_s=0,
            detail_concurrency=1,
            min_interval_ms=0,
            timeout_s=30,
            retries=1,
        ),
        enabled=False,
        note="按 URL 单篇导入；不在注册表的周期采集里",
    )


def _extract(html: str, url: str) -> RawArticle:
    soup = BeautifulSoup(html, "lxml")
    body_html = ""
    for selector in _BODY_SELECTORS:
        node = soup.select_one(selector)
        if node is None:
            continue
        candidate = "".join(str(child) for child in node.contents)
        if len(clean_text(html_to_text(candidate))) >= 20:
            body_html = candidate
            break
    if not body_html:
        body_html = str(soup)
    body = html_to_text(body_html)
    author = ""
    meta = soup.select_one('meta[name="author"], meta[property="article:author"]')
    if meta and meta.get("content"):
        author = clean_text(str(meta["content"]))
    return RawArticle(
        source_id=url,
        url=url,
        title=page_title(soup, fallback=url),
        content=body,
        author=author,
        published_at=page_date(soup),
        summary=page_summary(soup),
        content_html=body_html,
    )


async def ingest_url(url: str, db_path: str | Path) -> NormalizedArticle:
    target = url.strip()
    if not target.startswith(("http://", "https://")):
        raise AdhocError("url 必须是 http:// 或 https://")
    descriptor = _descriptor(target)
    http = HttpClient(
        {"manual": HttpPolicy(timeout_s=30, retries=1)},
        browser_fallback=False,
    )
    sink: SQLiteSink | None = None
    try:
        html = await http.get_text("manual", target)
        raw = _extract(html, target)
        article, reason = normalize(descriptor, raw)
        if article is None:
            raise AdhocError(reason or "正文为空")
        sink = SQLiteSink(Path(db_path))
        await sink.emit(article)
        return article
    finally:
        if sink is not None:
            await sink.close()
        await http.close()
