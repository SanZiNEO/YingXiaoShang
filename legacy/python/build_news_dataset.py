"""Normalize WSCN news search results and tag them with the chapter 3-5 vocabulary.

Input:
  data/marketing_news/wscn/awtmt_article_*.json
Output:
  data/marketing_news/wscn/normalized/news_articles.json
  data/marketing_news/wscn/normalized/news_tags.jsonl
  data/marketing_news/wscn/normalized/news_review.csv
  data/marketing_news/wscn/normalized/news_stats.json
"""

from __future__ import annotations

import csv
import glob
import html
import json
import re
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WSCN_DIR = ROOT / "data" / "marketing_news" / "wscn"
OUT_DIR = WSCN_DIR / "normalized"
OUT_DIR.mkdir(parents=True, exist_ok=True)

KPS = json.loads((ROOT / "data" / "marketing_textbook" / "ch03-05" / "knowledge_points.json").read_text(encoding="utf-8"))
KP_BY_ID = {k["kp_id"]: k for k in KPS}

COMPETENCY_IDS = {
    "市场与消费者洞察": "comp_insight",
    "营销策略与组合": "comp_strategy",
    "品牌与定位": "comp_brand",
    "数据与效果": "comp_data",
    "创意与沟通": "comp_communication",
    "伦理与可持续": "comp_ethics",
}

DECISION_IDS = {
    "环境分析": "dec_env",
    "消费者洞察": "dec_consumer",
    "组织市场": "dec_org",
    "品牌定位": "dec_brand",
}

# (keyword, kp_id, confidence)
CONSUMER_KEYWORDS = [
    ("消费者信心", "kp_consumer_behavior", 0.80),
    ("消费降级", "kp_personal_economic", 0.75),
    ("消费", "kp_consumer_market", 0.60),
    ("零售", "kp_consumer_market", 0.70),
    ("电商", "kp_digital_consumer", 0.75),
    ("直播", "kp_digital_consumer_traits", 0.70),
    ("智能体", "kp_digital_consumer_decision", 0.70),
    ("AI", "kp_env_technology", 0.65),
    ("通胀", "kp_env_economic", 0.70),
    ("油价", "kp_env_economic", 0.65),
    ("国庆", "kp_consumer_market", 0.60),
    ("假期", "kp_consumer_market", 0.55),
    ("Z世代", "kp_subculture", 0.75),
    ("情绪", "kp_emotion", 0.70),
    ("爱好", "kp_emotion", 0.65),
    ("楼市", "kp_env_economic", 0.60),
    ("品牌", "comp_brand", 0.70),
    ("营销", "comp_strategy", 0.65),
    ("广告", "comp_communication", 0.65),
    ("隐私", "kp_digital_consumer_traits", 0.70),
    ("算法", "kp_digital_consumer_decision", 0.65),
    ("推荐", "kp_digital_consumer_decision", 0.60),
    ("价格", "kp_personal_economic", 0.60),
    ("性价比", "kp_personal_economic", 0.65),
    ("复购", "kp_post_purchase", 0.70),
    ("退货", "kp_post_purchase", 0.70),
    ("决策", "kp_consumer_decision", 0.60),
    ("信息搜索", "kp_info_search", 0.65),
    ("评估", "kp_evaluation", 0.60),
    ("购后", "kp_post_purchase", 0.70),
    ("文化", "kp_env_culture", 0.60),
    ("人口", "kp_env_population", 0.65),
    ("政策", "kp_env_political", 0.60),
    ("监管", "kp_env_legal", 0.65),
]

B2B_KEYWORDS = [
    ("B2B", "kp_org_market", 0.85),
    ("采购", "kp_org_buying", 0.75),
    ("供应链", "kp_env_supplier", 0.70),
    ("企业客户", "kp_org_market_concept", 0.70),
    ("供应商", "kp_env_supplier", 0.70),
    ("生产者", "kp_producer_market", 0.70),
    ("政府采购", "kp_government_procurement", 0.85),
    ("招标", "kp_government_procurement", 0.75),
    ("非营利", "kp_nonprofit_market", 0.70),
    ("数字化", "kp_digital_org_market", 0.65),
    ("数智", "kp_digital_org_market", 0.65),
    ("电商", "kp_org_market_concept", 0.60),
    ("品牌", "comp_brand", 0.65),
    ("营销", "comp_strategy", 0.65),
    ("AI", "kp_digital_org_tech", 0.65),
]


def clean(text: str) -> str:
    text = html.unescape(text or "")
    text = re.sub(r"<[^>]+>", "", text)
    text = text.replace("\u3000", " ")
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def iso_time(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone(timedelta(hours=8))).isoformat()


def evidence(text: str, keyword: str) -> str:
    idx = text.find(keyword)
    if idx < 0:
        return text[:120]
    start = max(0, idx - 40)
    end = min(len(text), idx + 100)
    return text[start:end]


def add_tag(tags: list[dict], seen: set, tag_type: str, key: str, name: str, role: str, confidence: float, ev: str) -> None:
    if key in seen:
        return
    tags.append(
        {
            "tag_type": tag_type,
            "tag_key": key,
            "tag_name": name,
            "tag_role": role,
            "confidence": confidence,
            "method": "rule",
            "evidence_span": ev[:140],
            "is_gold": False,
            "review_status": "draft",
        }
    )
    seen.add(key)


def tag_article(title: str, content: str, query: str) -> list[dict]:
    text = f"{title} {content}"
    keywords = CONSUMER_KEYWORDS if query == "消费" else B2B_KEYWORDS
    tags: list[dict] = []
    seen: set[str] = set()

    for keyword, key, conf in keywords:
        if keyword not in text:
            continue
        if key.startswith("comp_"):
            comp_name = next((k for k, v in COMPETENCY_IDS.items() if v == key), key)
            add_tag(tags, seen, "competency", key, comp_name, "core", conf, evidence(text, keyword))
        else:
            kp = KP_BY_ID.get(key)
            if not kp:
                continue
            add_tag(tags, seen, "knowledge_point", key, kp["name"], "example", conf, evidence(text, keyword))

        if len([t for t in tags if t["tag_type"] == "knowledge_point"]) >= 4:
            break

    # Fallback so every article has at least one knowledge-point tag.
    if not any(t["tag_type"] == "knowledge_point" for t in tags):
        fallback = "kp_consumer_market" if query == "消费" else "kp_org_market"
        kp = KP_BY_ID[fallback]
        add_tag(tags, seen, "knowledge_point", fallback, kp["name"], "example", 0.55, text[:120])

    # Add competency/decision tags from the first knowledge point.
    primary = next((t for t in tags if t["tag_type"] == "knowledge_point"), None)
    if primary:
        kp = KP_BY_ID.get(primary["tag_key"])
        if kp:
            for comp in kp.get("competencies", [])[:1]:
                comp_id = COMPETENCY_IDS.get(comp)
                if comp_id:
                    add_tag(tags, seen, "competency", comp_id, comp, "core", 0.75, primary["evidence_span"])
            for dec in kp.get("decisions", [])[:1]:
                dec_id = DECISION_IDS.get(dec)
                if dec_id:
                    add_tag(tags, seen, "decision", dec_id, dec, "core", 0.65, primary["evidence_span"])

    return tags


def main() -> None:
    files = glob.glob(str(WSCN_DIR / "awtmt_article_*.json"))
    all_items: list[dict] = []
    for f in files:
        data = json.loads(Path(f).read_text(encoding="utf-8"))
        count = data.get("data", {}).get("count")
        query = "消费" if count and count > 100 else "B2B"
        for it in data.get("data", {}).get("items", []):
            all_items.append({**it, "_query": query, "_source_file": Path(f).name})

    # Select a mix: 12 consumer + all 8 B2B.
    consumer = [x for x in all_items if x["_query"] == "消费"]
    b2b = [x for x in all_items if x["_query"] == "B2B"]
    consumer_idx = [0, 1, 2, 3, 4, 5, 8, 12, 13, 15, 18, 19]
    selected = [consumer[i] for i in consumer_idx if i < len(consumer)] + b2b

    articles = []
    tag_rows = []
    for it in selected:
        title = clean(it.get("title", ""))
        content = clean(it.get("content", ""))
        article_id = f"wscn-{it.get('id')}"
        tags = tag_article(title, content, it["_query"])
        article = {
            "article_id": article_id,
            "title": title,
            "url": it.get("uri", ""),
            "published_at": iso_time(it.get("display_time", 0)),
            "author": (it.get("author") or {}).get("display_name", ""),
            "summary": content,
            "content": content,
            "source": "华尔街见闻",
            "query": it["_query"],
            "is_paid": bool(it.get("is_paid", False)),
            "rights": "link+snippet",
            "tags": tags,
        }
        articles.append(article)
        for t in tags:
            tag_rows.append({"article_id": article_id, "title": title, **t})

    payload = {
        "dataset": "marketing_news_wscn",
        "source": "华尔街见闻",
        "fetched_at": datetime.now(timezone(timedelta(hours=8))).isoformat(),
        "queries": ["消费", "B2B"],
        "count": len(articles),
        "articles": articles,
    }
    (OUT_DIR / "news_articles.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    with (OUT_DIR / "news_tags.jsonl").open("w", encoding="utf-8") as f:
        for row in tag_rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    with (OUT_DIR / "news_review.csv").open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["article_id", "title", "query", "published_at", "primary_kp", "primary_role", "confidence", "tags", "url"])
        for a in articles:
            kp_tags = [t for t in a["tags"] if t["tag_type"] == "knowledge_point"]
            primary = kp_tags[0] if kp_tags else None
            writer.writerow([
                a["article_id"],
                a["title"],
                a["query"],
                a["published_at"],
                primary["tag_key"] if primary else "",
                primary["tag_role"] if primary else "",
                primary["confidence"] if primary else "",
                "; ".join(f"{t['tag_key']}|{t['tag_role']}|{t['confidence']}" for t in a["tags"]),
                a["url"],
            ])

    stats = {
        "articles": len(articles),
        "tags": len(tag_rows),
        "tag_type_counts": dict(Counter(t["tag_type"] for t in tag_rows)),
        "tag_role_counts": dict(Counter(t["tag_role"] for t in tag_rows)),
        "query_counts": dict(Counter(a["query"] for a in articles)),
        "top_kps": Counter(t["tag_key"] for t in tag_rows if t["tag_type"] == "knowledge_point").most_common(15),
        "articles_without_kp": [a["article_id"] for a in articles if not any(t["tag_type"] == "knowledge_point" for t in a["tags"])],
    }
    (OUT_DIR / "news_stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")

    print(json.dumps({k: stats[k] for k in ["articles", "tags", "tag_type_counts", "query_counts"]}, ensure_ascii=False, indent=2))
    print("output:", OUT_DIR)


if __name__ == "__main__":
    main()
