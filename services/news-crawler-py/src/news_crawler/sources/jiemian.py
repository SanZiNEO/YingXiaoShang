from __future__ import annotations

from urllib.parse import urljoin, urlparse

from ..html import clean_text, first_html, html_to_text, page_date, page_summary, page_title
from ..models import RawArticle, RawListItem, RawPage
from .base import NewsSource, soup_of

BASE = "https://www.jiemian.com/"
LIST_PAGE = f"{BASE}lists/2.html"


class JiemianSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        html = await self.http.get_text(self.id, LIST_PAGE)
        soup = soup_of(html)
        entries: dict[str, RawListItem] = {}
        for node in soup.find_all("a"):
            path = urlparse(urljoin(BASE, str(node.get("href") or ""))).path
            parts = path.strip("/").split("/")
            if len(parts) != 2 or parts[0] != "article" or not parts[1].removesuffix(".html").isdigit():
                continue
            if not parts[1].endswith(".html"):
                continue
            absolute = urljoin(BASE, path)
            if absolute in entries:
                continue
            entries[absolute] = RawListItem(
                source_id=parts[1].removesuffix(".html"),
                url=absolute,
                title=clean_text(node.get_text(" ")),
            )
        return RawPage(items=list(entries.values()))

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(soup, (".article-content", ".pure-article-wrapper-box"))
        author = clean_text(
            soup.select_one(".article-info, .article-author").get_text(" ") if soup.select_one(".article-info, .article-author") else ""
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
