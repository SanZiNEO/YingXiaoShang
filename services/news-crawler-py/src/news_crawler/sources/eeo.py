from __future__ import annotations

import re
from urllib.parse import urljoin

from ..html import (
    clean_text,
    first_html,
    html_to_text,
    normalize_date,
    page_date,
    page_summary,
    page_title,
)
from ..models import RawArticle, RawListItem, RawPage
from .base import NewsSource, soup_of

BASE = "https://www.eeo.com.cn/"
LIST_API = "https://app.eeo.com.cn/"
LIST_REFERER = f"{BASE}jg/kuaixun/"
CAT_ID = "3690"
AUTHOR_RE = re.compile(r"^([^/\n]{1,20})/文")


class EeoSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        page = int(cursor or "1")
        url = (
            f"{LIST_API}?app=article&controller=index&action=getMoreArticle"
            f"&catid={CAT_ID}&page={page}&pageSize=20"
        )
        payload = await self.http.get_json(self.id, url, headers={"referer": LIST_REFERER})
        if payload.get("code") != 200 or not isinstance(payload.get("data"), list):
            raise RuntimeError(f"eeo list code {payload.get('code')}")
        items: list[RawListItem] = []
        for raw in payload["data"]:
            article_url = str(raw.get("url") or "").strip()
            source_id = str(raw.get("id") or raw.get("contentid") or "").strip()
            title = str(raw.get("title") or "").strip()
            if not article_url or not source_id or not title:
                continue
            content_html = str(raw.get("content") or "")
            content = html_to_text(content_html)
            published_at = normalize_date(str(raw.get("published") or ""))
            summary = clean_text(str(raw.get("description") or "")) or content[:160]
            fallback = None
            if len(content) >= 300:
                fallback = RawArticle(
                    source_id=source_id,
                    url=urljoin(BASE, article_url),
                    title=title,
                    author=str(raw.get("author") or "").strip(),
                    published_at=published_at,
                    summary=summary,
                    content=content,
                    content_html=content_html,
                )
            items.append(
                RawListItem(
                    source_id=source_id,
                    url=urljoin(BASE, article_url),
                    title=title,
                    published_at=published_at,
                    summary=summary,
                    fallback=fallback,
                )
            )
        return RawPage(items=items, next_cursor=str(page + 1) if items else None)

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        if item.fallback:
            return item.fallback
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(soup, (".xx_boxsing", ".xd-nr"))
        author = ""
        box = soup.select_one(".xx_boxsing")
        if box:
            match = AUTHOR_RE.search(clean_text(box.get_text(" ")))
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
