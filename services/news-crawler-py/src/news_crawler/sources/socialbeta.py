from __future__ import annotations

from urllib.parse import urljoin, urlparse

from ..html import clean_text, first_html, html_to_text, normalize_date, page_summary
from ..models import RawArticle, RawListItem, RawPage
from .base import NewsSource, soup_of

BASE = "https://socialbeta.com/"
LIST_PAGE = f"{BASE}campaign"


class SocialBetaSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        html = await self.http.get_text(self.id, LIST_PAGE)
        soup = soup_of(html)
        entries: dict[str, RawListItem] = {}

        def add(href: str, title: str) -> None:
            if not href:
                return
            absolute = urljoin(BASE, href)
            parsed = urlparse(absolute)
            parts = parsed.path.strip("/").split("/")
            if len(parts) != 2 or parts[0] not in {"article", "campaign"} or not parts[1].isdigit():
                return
            existing = entries.get(absolute)
            if existing:
                if not existing.title and title:
                    existing.title = title
                return
            entries[absolute] = RawListItem(
                source_id=f"{parts[0]}-{parts[1]}",
                url=absolute,
                title=title,
            )

        for node in soup.find_all("a"):
            add(str(node.get("href") or ""), clean_text(node.get_text(" ")))
        for node in soup.select("[data-href]"):
            add(str(node.get("data-href") or ""), clean_text(node.get_text(" ")))

        return RawPage(items=list(entries.values()))

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        title_node = soup.select_one(".tit_art, .tit_cam")
        title = clean_text(title_node.get_text(" ") if title_node else "")
        if not title and soup.title:
            title = clean_text(soup.title.get_text(" ")).removesuffix("｜SocialBeta")
        title = title or item.title
        info = clean_text(
            soup.select_one(".info_art, .info_cam").get_text(" ") if soup.select_one(".info_art, .info_cam") else ""
        )
        published_at = normalize_date(info[:10] if len(info) >= 10 else "")
        author = ""
        for node in soup.select('.info_art a[href*="/user/"], .info_cam a[href*="/user/"]'):
            text = clean_text(node.get_text(" "))
            if text:
                author = text
                break
        content_html = first_html(soup, (".cont_art .content", ".cont_cam .content"))
        summary = page_summary(soup, item.summary or "")
        return RawArticle(
            source_id=item.source_id,
            url=item.url,
            title=title,
            author=author,
            published_at=published_at,
            summary=summary,
            content=html_to_text(content_html),
            content_html=content_html,
        )
