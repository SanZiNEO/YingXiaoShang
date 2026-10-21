"""Re-tag the news dataset using full article text."""

from __future__ import annotations

import csv
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import build_news_dataset as bnd  # noqa: E402

DATA_DIR = ROOT / "data" / "marketing_news" / "wscn" / "normalized"
INPUT = DATA_DIR / "news_articles_full.json"
OUT_ARTICLES = DATA_DIR / "news_articles_full_tagged.json"
OUT_TAGS = DATA_DIR / "news_tags_full.jsonl"
OUT_REVIEW = DATA_DIR / "news_review_full.csv"
OUT_STATS = DATA_DIR / "news_stats_full.json"


def main() -> None:
    payload = json.loads(INPUT.read_text(encoding="utf-8"))
    articles = payload.get("articles", [])
    tag_rows = []

    for a in articles:
        text = a.get("content_full") or a.get("summary") or ""
        tags = bnd.tag_article(a["title"], text, a["query"])
        a["tags"] = tags
        for t in tags:
            tag_rows.append({"article_id": a["article_id"], "title": a["title"], **t})

    payload["count"] = len(articles)
    payload["tagged_at"] = __import__("time").strftime("%Y-%m-%dT%H:%M:%S%z")
    OUT_ARTICLES.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    with OUT_TAGS.open("w", encoding="utf-8") as f:
        for row in tag_rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    with OUT_REVIEW.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["article_id", "title", "query", "published_at", "content_status", "content_length", "primary_kp", "primary_role", "confidence", "tags", "url"])
        for a in articles:
            kp_tags = [t for t in a["tags"] if t["tag_type"] == "knowledge_point"]
            primary = kp_tags[0] if kp_tags else None
            writer.writerow([
                a["article_id"], a["title"], a["query"], a["published_at"],
                a.get("content_status", ""), a.get("content_length", 0),
                primary["tag_key"] if primary else "",
                primary["tag_role"] if primary else "",
                primary["confidence"] if primary else "",
                "; ".join(f"{t['tag_key']}|{t['tag_role']}|{t['confidence']}" for t in a["tags"]),
                a["url"],
            ])

    stats = {
        "articles": len(articles),
        "tags": len(tag_rows),
        "content_status": dict(Counter(a.get("content_status", "unknown") for a in articles)),
        "content_length_total": sum(a.get("content_length", 0) for a in articles),
        "tag_type_counts": dict(Counter(t["tag_type"] for t in tag_rows)),
        "tag_role_counts": dict(Counter(t["tag_role"] for t in tag_rows)),
        "query_counts": dict(Counter(a["query"] for a in articles)),
        "top_kps": Counter(t["tag_key"] for t in tag_rows if t["tag_type"] == "knowledge_point").most_common(20),
        "articles_without_kp": [a["article_id"] for a in articles if not any(t["tag_type"] == "knowledge_point" for t in a["tags"])],
    }
    OUT_STATS.write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: stats[k] for k in ["articles", "tags", "content_status", "content_length_total", "tag_type_counts"]}, ensure_ascii=False, indent=2))
    print("output:", OUT_ARTICLES)


if __name__ == "__main__":
    main()
