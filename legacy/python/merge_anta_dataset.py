"""Merge the Anta articles/questions into the main news viewer dataset."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "marketing_news" / "wscn" / "normalized"

main = json.loads((DATA / "news_articles_full_tagged.json").read_text(encoding="utf-8"))
anta = json.loads((DATA / "anta_articles_tagged.json").read_text(encoding="utf-8"))
main_q = json.loads((DATA / "news_questions.json").read_text(encoding="utf-8"))
anta_q = json.loads((DATA / "anta_questions.json").read_text(encoding="utf-8"))

articles = main["articles"] + anta["articles"]
questions = {**main_q, **anta_q}

out = {
    **main,
    "dataset": "marketing_news_all",
    "count": len(articles),
    "articles": articles,
    "brands": sorted({a.get("brand", "综合") for a in articles}),
}
(DATA / "news_articles_all_tagged.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
(DATA / "news_questions_all.json").write_text(json.dumps(questions, ensure_ascii=False, indent=2), encoding="utf-8")

print(f"articles: {len(articles)}")
print(f"questions: {sum(len(v) for v in questions.values())}")
print(f"queries: {sorted({a['query'] for a in articles})}")
