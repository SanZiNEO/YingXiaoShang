"""Fetch selected Anta articles from the WSCN search result and article API."""

from __future__ import annotations

import glob
import html
import json
import re
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WSCN_DIR = ROOT / "data" / "marketing_news" / "wscn"
OUT = WSCN_DIR / "normalized" / "anta_articles_full.json"

API = "https://api-one-wscn.awtmt.com/apiv1/content/articles/{id}?extract=0&accept_theme=theme,premium-theme&remove_disclaimer=1"
HEADERS = {
    "Referer": "https://wallstreetcn.com/",
    "Origin": "https://wallstreetcn.com",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
}
SELECTED = [0, 1, 2, 3, 4, 5, 10, 14, 15, 18, 19]


def clean(text: str) -> str:
    text = html.unescape(text or "")
    text = re.sub(r"<[^>]+>", "", text)
    text = text.replace("\u3000", " ")
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def html_to_text(raw: str) -> str:
    text = re.sub(r"<br\s*/?>", "\n", raw or "", flags=re.I)
    text = re.sub(r"</(p|h[1-6]|li|blockquote)>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = text.replace("\u3000", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return text.strip()


def fetch(aid: str) -> dict:
    req = urllib.request.Request(API.format(id=aid), headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if payload.get("code") != 20000:
        raise RuntimeError(f"API code {payload.get('code')}")
    return payload.get("data", {})


def iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone(timedelta(hours=8))).isoformat()


def main() -> None:
    candidates = []
    for f in glob.glob(str(WSCN_DIR / "awtmt_article_*.json")):
        data = json.loads(Path(f).read_text(encoding="utf-8"))
        if data.get("data", {}).get("count") == 55:
            candidates.append((Path(f).stat().st_mtime, f, data))
    if not candidates:
        raise SystemExit("Anta search JSON not found")
    _, path, data = max(candidates)
    items = data["data"]["items"]
    print("source:", path)

    articles = []
    for idx in SELECTED:
        it = items[idx]
        aid = str(it["id"])
        try:
            d = fetch(aid)
            raw = d.get("content", "") or ""
            full = html_to_text(raw)
            status = "full" if len(full) >= 1000 else "partial" if full else "unavailable"
            article = {
                "article_id": f"wscn-{aid}",
                "title": clean(d.get("title") or it.get("title", "")),
                "url": it.get("uri", ""),
                "published_at": iso(it.get("display_time", 0)),
                "author": (d.get("author") or {}).get("display_name") or (it.get("author") or {}).get("display_name", ""),
                "summary": clean(it.get("content", "")),
                "content": full or clean(it.get("content", "")),
                "content_full": full,
                "content_html": raw,
                "content_length": len(full),
                "content_status": status,
                "source": "华尔街见闻",
                "query": "安踏",
                "brand": "安踏",
                "is_paid": bool(d.get("is_paid", it.get("is_paid", False))),
                "rights": "internal-research; source-link",
                "tags": [],
            }
            articles.append(article)
            print(f"[{len(articles)}] {aid} {status} {len(full)} | {article['title'][:45]}")
        except Exception as exc:  # noqa: BLE001
            print(f"[skip] {aid} ERROR {exc}")
        time.sleep(0.35)

    payload = {
        "dataset": "marketing_news_anta",
        "source": "华尔街见闻",
        "query": "安踏",
        "count": len(articles),
        "articles": articles,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print("output:", OUT)


if __name__ == "__main__":
    main()
