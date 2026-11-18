from __future__ import annotations

import re
from urllib.parse import urljoin, urlparse

from ..html import clean_text, first_html, html_to_text, page_date, page_summary, page_title
from ..models import RawArticle, RawListItem, RawPage
from .base import NewsSource, soup_of

BASE = "https://www.yicai.com/"
LIST_PAGE = f"{BASE}news/"
DATE_SUFFIX = re.compile(r"\s+\d{2}-\d{2}\s+\d{2}:\d{2}\s*$")


def list_title(text: str) -> str:
    return DATE_SUFFIX.sub("", clean_text(text))


class YicaiSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        page = int(cursor or "1")
        html = await self.http.get_text(self.id, f"{LIST_PAGE}?page={page}")
        soup = soup_of(html)
        entries: dict[str, RawListItem] = {}
        for node in soup.find_all("a"):
            href = str(node.get("href") or "")
            path = urlparse(urljoin(BASE, href)).path
            parts = path.strip("/").split("/")
            if len(parts) != 2 or parts[0] != "news" or not parts[1].removesuffix(".html").isdigit():
                continue
            if not parts[1].endswith(".html"):
                continue
            absolute = urljoin(BASE, path)
            if absolute in entries:
                continue
            entries[absolute] = RawListItem(
                source_id=parts[1].removesuffix(".html"),
                url=absolute,
                title=list_title(node.get_text(" ")),
            )
        items = list(entries.values())
        return RawPage(items=items, next_cursor=str(page + 1) if items else None)

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(soup, ("#multi-text", ".m-txt"))
        author = clean_text(
            soup.select_one(".m-author, .author").get_text(" ") if soup.select_one(".m-author, .author") else ""
        )
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
