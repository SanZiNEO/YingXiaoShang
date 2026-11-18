"""HTML / URL / date helpers shared by the Python source adapters."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from bs4 import BeautifulSoup

CST = timezone(timedelta(hours=8))
_KEEP_QUERY = {"id", "articleid", "aid", "p", "story", "newsid"}
_BODY_DATE = re.compile(r"\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?")


def clean_text(value: str | None) -> str:
    if not value:
        return ""
    value = value.replace("\r\n", "\n").replace("\r", "\n").replace("\u00a0", " ")
    value = re.sub(r"[ \t\f\v]+", " ", value)
    value = re.sub(r" *\n *", "\n", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def html_to_text(html: str | None) -> str:
    if not html:
        return ""
    soup = BeautifulSoup(html, "lxml")
    for tag in soup(["script", "style", "noscript", "iframe", "svg", "form"]):
        tag.decompose()
    for tag in soup.find_all(["br"]):
        tag.replace_with("\n")
    for tag in soup.find_all(
        ["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "div", "section", "article"]
    ):
        tag.append("\n")
    return clean_text(soup.get_text("\n"))


def path_of(href: str, base: str) -> str | None:
    try:
        return urlparse(href, base).path
    except ValueError:
        return None


def canonical_url(value: str) -> str:
    try:
        parsed = urlparse(value)
    except ValueError:
        return value
    if not parsed.scheme or not parsed.netloc:
        return value
    query = [
        (key, val)
        for key, val in parse_qsl(parsed.query, keep_blank_values=True)
        if key.lower() in _KEEP_QUERY
    ]
    return urlunparse(
        (
            parsed.scheme,
            parsed.netloc,
            parsed.path,
            "",
            urlencode(query),
            "",
        )
    )


def normalize_date(value: str | None) -> str:
    raw = (value or "").strip()
    if not raw:
        return ""
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        return f"{raw}T00:00:00+08:00"
    if re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?", raw):
        return f"{raw.replace(' ', 'T')}+08:00"
    try:
        parsed = parsedate_to_datetime(raw)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=CST)
        return parsed.astimezone(CST).isoformat()
    except (TypeError, ValueError):
        pass
    try:
        parsed = datetime.fromisoformat(raw)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=CST)
        return parsed.astimezone(CST).isoformat()
    except ValueError:
        return raw


def page_title(soup: BeautifulSoup, fallback: str = "") -> str:
    meta = soup.select_one('meta[property="og:title"]')
    if meta and meta.get("content"):
        text = clean_text(str(meta["content"]))
        if text:
            return text
    h1 = soup.find("h1")
    if h1:
        text = clean_text(h1.get_text(" "))
        if text:
            return text
    if soup.title:
        text = clean_text(soup.title.get_text(" "))
        if text:
            return text
    return fallback


def page_summary(soup: BeautifulSoup, fallback: str = "") -> str:
    for selector in ('meta[name="description"]', 'meta[property="og:description"]'):
        meta = soup.select_one(selector)
        if meta and meta.get("content"):
            text = clean_text(str(meta["content"]))
            if text:
                return text
    return fallback


def page_date(soup: BeautifulSoup, fallback: str = "") -> str:
    for selector in (
        'meta[property="article:published_time"]',
        'meta[name="publishdate"]',
    ):
        meta = soup.select_one(selector)
        if meta and meta.get("content"):
            text = normalize_date(str(meta["content"]))
            if text:
                return text
    time_tag = soup.find("time")
    if time_tag and time_tag.get("datetime"):
        text = normalize_date(str(time_tag["datetime"]))
        if text:
            return text
    match = _BODY_DATE.search(soup.get_text(" "))
    return normalize_date(match.group(0)) if match else fallback


def first_html(soup: BeautifulSoup, selectors: tuple[str, ...]) -> str:
    for selector in selectors:
        node = soup.select_one(selector)
        if node is None:
            continue
        html = "".join(str(child) for child in node.contents)
        if clean_text(html):
            return html
    return ""
