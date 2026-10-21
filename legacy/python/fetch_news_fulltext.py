"""Fetch full article bodies for the selected WSCN news items.

The WSCN article API was captured with veddata:
  GET https://api-one-wscn.awtmt.com/apiv1/content/articles/{id}
      ?extract=0&accept_theme=theme,premium-theme&remove_disclaimer=1

Output:
  data/marketing_news/wscn/normalized/news_articles_full.json
"""

from __future__ import annotations

import html
import json
import re
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data" / "marketing_news" / "wscn" / "normalized"
INPUT = DATA_DIR / "news_articles.json"
OUTPUT = DATA_DIR / "news_articles_full.json"

API = "https://api-one-wscn.awtmt.com/apiv1/content/articles/{id}?extract=0&accept_theme=theme,premium-theme&remove_disclaimer=1"
HEADERS = {
    "Referer": "https://wallstreetcn.com/",
    "Origin": "https://wallstreetcn.com",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
}


def html_to_text(raw: str) -> str:
    if not raw:
        return ""
    text = re.sub(r"<br\s*/?>", "\n", raw, flags=re.I)
    text = re.sub(r"</(p|h[1-6]|li|blockquote)>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = text.replace("\u3000", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return text.strip()


def fetch(article_id: str) -> dict:
    url = API.format(id=article_id)
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if payload.get("code") != 20000:
        raise RuntimeError(f"API code {payload.get('code')}: {payload.get('message')}")
    return payload.get("data", {})


def main() -> None:
    payload = json.loads(INPUT.read_text(encoding="utf-8"))
    articles = payload.get("articles", [])
    updated = []
    errors = []

    for i, article in enumerate(articles, 1):
        aid = article["article_id"].split("-")[-1]
        try:
            data = fetch(aid)
            raw_html = data.get("content", "") or ""
            full_text = html_to_text(raw_html)
            if len(full_text) >= 1000:
                status = "full"
            elif len(full_text) > 0:
                status = "partial"
            else:
                status = "unavailable"
            article = {
                **article,
                "title": data.get("title") or article.get("title"),
                "author": (data.get("author") or {}).get("display_name") or article.get("author"),
                "published_at": article.get("published_at"),
                "content_html": raw_html,
                "content_full": full_text,
                "content_length": len(full_text),
                "content_status": status,
                "content_scope": status,
                "is_paid": bool(data.get("is_paid", article.get("is_paid", False))),
                "rights": "internal-research; source-link",
                "fetch_error": "",
            }
            # Keep the original search snippet separately; use full text as content.
            if full_text:
                article["content"] = full_text
            print(f"[{i}/{len(articles)}] {aid} {status} {len(full_text)} chars | {article['title'][:40]}")
        except Exception as exc:  # noqa: BLE001
            article = {
                **article,
                "content_full": "",
                "content_length": 0,
                "content_status": "error",
                "content_scope": "snippet",
                "fetch_error": str(exc),
            }
            errors.append((aid, str(exc)))
            print(f"[{i}/{len(articles)}] {aid} ERROR {exc}")
        updated.append(article)
        time.sleep(0.35)

    out = {**payload, "articles": updated, "fulltext_fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    OUTPUT.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    status_counts = {}
    for a in updated:
        status_counts[a.get("content_status")] = status_counts.get(a.get("content_status"), 0) + 1
    print("status:", status_counts)
    print("errors:", errors)
    print("output:", OUTPUT)


if __name__ == "__main__":
    main()
