"""Tag the selected Anta articles with the existing marketing vocabulary."""

from __future__ import annotations

import csv
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "marketing_news" / "wscn" / "normalized"
INPUT = DATA / "anta_articles_full.json"
OUT_ARTICLES = DATA / "anta_articles_tagged.json"
OUT_TAGS = DATA / "anta_tags.jsonl"
OUT_REVIEW = DATA / "anta_review.csv"
OUT_STATS = DATA / "anta_stats.json"

KPS = json.loads((ROOT / "data" / "marketing_textbook" / "ch03-05" / "knowledge_points.json").read_text(encoding="utf-8"))
KP_BY_ID = {k["kp_id"]: k for k in KPS}

COMP = {
    "市场与消费者洞察": "comp_insight",
    "营销策略与组合": "comp_strategy",
    "品牌与定位": "comp_brand",
    "数据与效果": "comp_data",
    "创意与沟通": "comp_communication",
    "伦理与可持续": "comp_ethics",
}

# (keyword, tag_type, tag_key, confidence)
KEYWORDS = [
    ("安踏", "competency", "comp_brand", 0.85),
    ("主品牌", "competency", "comp_brand", 0.80),
    ("多品牌", "competency", "comp_strategy", 0.80),
    ("品牌", "competency", "comp_brand", 0.65),
    ("换帅", "competency", "comp_strategy", 0.70),
    ("CEO", "competency", "comp_strategy", 0.65),
    ("零售", "knowledge_point", "kp_consumer_market", 0.70),
    ("门店", "knowledge_point", "kp_consumer_market", 0.65),
    ("消费者", "knowledge_point", "kp_consumer_behavior", 0.65),
    ("户外", "knowledge_point", "kp_lifestyle", 0.70),
    ("年轻", "knowledge_point", "kp_subculture", 0.65),
    ("Z世代", "knowledge_point", "kp_subculture", 0.75),
    ("国潮", "knowledge_point", "kp_env_culture", 0.70),
    ("奥运", "competency", "comp_brand", 0.80),
    ("国家队", "competency", "comp_brand", 0.75),
    ("ESG", "knowledge_point", "kp_env_natural", 0.80),
    ("可持续", "knowledge_point", "kp_env_natural", 0.80),
    ("碳中和", "knowledge_point", "kp_env_natural", 0.85),
    ("环保", "knowledge_point", "kp_env_natural", 0.70),
    ("收购", "competency", "comp_strategy", 0.80),
    ("并购", "competency", "comp_strategy", 0.80),
    ("彪马", "competency", "comp_strategy", 0.80),
    ("PUMA", "competency", "comp_strategy", 0.80),
    ("狼爪", "competency", "comp_strategy", 0.80),
    ("Jack Wolfskin", "competency", "comp_strategy", 0.80),
    ("亚玛芬", "competency", "comp_strategy", 0.75),
    ("营收", "competency", "comp_data", 0.70),
    ("增长", "competency", "comp_data", 0.65),
    ("利润", "competency", "comp_data", 0.70),
    ("业绩", "competency", "comp_data", 0.70),
    ("竞争", "knowledge_point", "kp_env_competitor", 0.70),
    ("李宁", "knowledge_point", "kp_env_competitor", 0.75),
    ("耐克", "knowledge_point", "kp_env_competitor", 0.75),
    ("阿迪", "knowledge_point", "kp_env_competitor", 0.70),
    ("营销", "competency", "comp_communication", 0.65),
    ("广告", "competency", "comp_communication", 0.65),
    ("传播", "competency", "comp_communication", 0.65),
    ("产品", "competency", "comp_strategy", 0.60),
    ("爆款", "competency", "comp_strategy", 0.70),
    ("供应链", "knowledge_point", "kp_env_supplier", 0.65),
    ("库存", "knowledge_point", "kp_env_supplier", 0.65),
    ("高端", "knowledge_point", "kp_personal_economic", 0.60),
    ("大众", "knowledge_point", "kp_personal_economic", 0.60),
]


def add(tags, seen, tag_type, key, name, conf, evidence):
    if key in seen:
        return
    tags.append({
        "tag_type": tag_type,
        "tag_key": key,
        "tag_name": name,
        "tag_role": "example",
        "confidence": conf,
        "method": "rule",
        "evidence_span": evidence[:140],
        "is_gold": False,
        "review_status": "draft",
    })
    seen.add(key)


def main() -> None:
    payload = json.loads(INPUT.read_text(encoding="utf-8"))
    articles = payload.get("articles", [])
    rows = []

    for a in articles:
        text = f"{a['title']} {a.get('content_full') or a.get('summary','')}"
        tags = []
        seen = set()
        for keyword, tag_type, key, conf in KEYWORDS:
            if keyword not in text:
                continue
            if tag_type == "knowledge_point":
                kp = KP_BY_ID.get(key)
                if not kp:
                    continue
                add(tags, seen, tag_type, key, kp["name"], conf, text)
            else:
                name = next((k for k, v in COMP.items() if v == key), key)
                add(tags, seen, tag_type, key, name, conf, text)
            if len([t for t in tags if t["tag_type"] == "knowledge_point"]) >= 3:
                break

        if not any(t["tag_type"] == "knowledge_point" for t in tags):
            add(tags, seen, "knowledge_point", "kp_consumer_market", KP_BY_ID["kp_consumer_market"]["name"], 0.55, text)

        # Ensure at least one strategy/brand competency.
        if not any(t["tag_type"] == "competency" for t in tags):
            add(tags, seen, "competency", "comp_strategy", "营销策略与组合", 0.60, text)

        a["tags"] = tags
        for t in tags:
            rows.append({"article_id": a["article_id"], "title": a["title"], **t})

    payload["count"] = len(articles)
    OUT_ARTICLES.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    with OUT_TAGS.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    with OUT_REVIEW.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["article_id", "title", "published_at", "content_status", "content_length", "primary_kp", "tags", "url"])
        for a in articles:
            kp = [t for t in a["tags"] if t["tag_type"] == "knowledge_point"]
            writer.writerow([
                a["article_id"], a["title"], a["published_at"], a.get("content_status", ""),
                a.get("content_length", 0),
                kp[0]["tag_key"] if kp else "",
                "; ".join(f"{t['tag_key']}|{t['tag_role']}|{t['confidence']}" for t in a["tags"]),
                a["url"],
            ])

    stats = {
        "articles": len(articles),
        "tags": len(rows),
        "tag_type_counts": dict(Counter(t["tag_type"] for t in rows)),
        "top_kps": Counter(t["tag_key"] for t in rows if t["tag_type"] == "knowledge_point").most_common(15),
        "articles_without_kp": [a["article_id"] for a in articles if not any(t["tag_type"] == "knowledge_point" for t in a["tags"])],
    }
    OUT_STATS.write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(stats, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
