"""Tag chapters 3-5 content blocks with the controlled knowledge-point vocabulary.

This is a first-pass, rule-based annotation. It is deliberately conservative:
- primary tag comes from the section/topic heading;
- secondary tags come from a small keyword map;
- everything is marked review_status=draft / method=rule for human review.

Outputs:
  content_blocks.jsonl
  content_tags.jsonl
  structure.json
  review.csv
  stats.json
"""

from __future__ import annotations

import csv
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data" / "marketing_textbook" / "ch03-05"

KPS = json.loads((DATA_DIR / "knowledge_points.json").read_text(encoding="utf-8"))
KP_BY_ID = {k["kp_id"]: k for k in KPS}


def norm(s: str) -> str:
    s = re.sub(r"\s+", "", s or "")
    s = s.translate(str.maketrans("０１２３４５６７８９", "0123456789"))
    s = s.replace("（", "(").replace("）", ")")
    return s


SECTION_MAP = {
    "第1节市场营销环境概述": "kp_env_definition",
    "第2节宏观营销环境分析": "kp_env_macro",
    "第3节微观营销环境分析": "kp_env_micro",
    "第4节环境分析与营销对策": "kp_env_analysis",
    "第1节消费者与消费者市场": "kp_consumer_market",
    "第2节消费者行为的一般过程": "kp_consumer_behavior_process",
    "第3节消费者购买行为的影响因素及其作用机制": "kp_consumer_influences",
    "第4节消费者购买决策过程": "kp_consumer_decision",
    "第5节数智化时代的消费者购买行为": "kp_digital_consumer",
    "第1节组织市场与购买行为概述": "kp_org_market",
    "第2节生产者市场与购买行为分析": "kp_producer_market",
    "第3节非营利组织市场、政府市场及其购买行为分析": "kp_nonprofit_government",
    "第4节数智化时代的组织市场营销": "kp_digital_org_market",
}

TOPIC_MAP = {
    "一、市场营销环境的结构": "kp_env_structure",
    "二、市场营销环境的特征": "kp_env_features",
    "一、政治环境": "kp_env_political",
    "二、经济环境": "kp_env_economic",
    "(一)宏观经济环境": "kp_env_economic",
    "(二)收入与支出": "kp_env_income",
    "三、社会环境": "kp_env_social",
    "(一)社会文化环境": "kp_env_culture",
    "(二)人口环境": "kp_env_population",
    "四、技术环境": "kp_env_technology",
    "五、自然环境": "kp_env_natural",
    "六、法律环境": "kp_env_legal",
    "一、企业内部环境": "kp_env_internal",
    "二、供应商": "kp_env_supplier",
    "三、营销中介": "kp_env_intermediary",
    "四、顾客": "kp_env_customer",
    "五、竞争者": "kp_env_competitor",
    "六、公众": "kp_env_public",
    "一、消费者": "kp_consumer_definition",
    "二、消费者市场": "kp_consumer_market_definition",
    "(一)消费者市场的含义": "kp_consumer_market_definition",
    "(二)消费者市场的特点": "kp_consumer_market_features",
    "一、消费者行为的一般过程": "kp_consumer_behavior",
    "二、消费者购买行为": "kp_consumer_buying_behavior",
    "三、消费者购买行为模式": "kp_consumer_behavior_model",
    "一、文化因素": "kp_culture",
    "(一)文化": "kp_culture",
    "(二)亚文化": "kp_subculture",
    "(三)社会阶层": "kp_social_class",
    "二、社会因素": "kp_social",
    "(一)参照群体": "kp_reference_group",
    "(二)角色": "kp_roles",
    "(三)家庭": "kp_family",
    "三、个人因素": "kp_personal",
    "(一)经济因素": "kp_personal_economic",
    "(二)生理因素": "kp_personal_physiological",
    "(三)生活方式": "kp_lifestyle",
    "(四)个性与自我概念": "kp_personality_self",
    "四、心理因素": "kp_psychological",
    "(一)消费者的需要和动机": "kp_needs_motives",
    "(二)消费者的感觉和知觉": "kp_perception",
    "(三)消费者的学习": "kp_learning",
    "(四)消费者的情感": "kp_emotion",
    "(五)消费者的信念和态度": "kp_beliefs_attitudes",
    "五、情境因素": "kp_situational",
    "一、消费者购买决策的参与者": "kp_decision_participants",
    "二、消费者购买决策过程的主要阶段": "kp_decision_stages",
    "(一)确认需要": "kp_need_recognition",
    "(二)信息搜集": "kp_info_search",
    "(三)评估选择": "kp_evaluation",
    "(四)购买决定": "kp_purchase_decision",
    "(五)购后行为": "kp_post_purchase",
    "一、数智消费者的心理与行为特征": "kp_digital_consumer_traits",
    "二、数智消费者的购买决策过程": "kp_digital_consumer_decision",
    "一、组织购买及组织购买品": "kp_org_buying",
    "二、组织市场的概念": "kp_org_market_concept",
    "三、组织市场的购买特征": "kp_org_market_features",
    "一、生产者购买行为的主要类型": "kp_producer_buying_types",
    "二、生产者购买决策的参与者": "kp_producer_participants",
    "三、影响生产者购买决策的主要因素": "kp_producer_influences",
    "四、生产者的购买决策过程": "kp_producer_decision_process",
    "一、非营利组织市场": "kp_nonprofit_market",
    "二、非营利组织的购买特点和购买方式": "kp_nonprofit_buying",
    "(一)非营利组织的购买特点": "kp_nonprofit_buying",
    "(二)非营利组织的购买方式": "kp_nonprofit_buying",
    "三、政府市场与购买行为分析": "kp_government_market",
    "(一)政府采购的目的": "kp_government_procurement",
    "(二)影响政府采购行为的主要因素": "kp_government_procurement",
    "(三)政府的购买方式": "kp_government_procurement",
    "一、数智化时代组织市场营销的技术赋能": "kp_digital_org_tech",
    "二、数智化时代组织市场客户的需求变革": "kp_digital_org_demand",
    "三、数智化时代的组织市场营销策略": "kp_digital_org_strategy",
}

CHAPTER_SECTIONS = {
    "第3章": ["kp_env_definition", "kp_env_macro", "kp_env_micro", "kp_env_analysis"],
    "第4章": [
        "kp_consumer_market",
        "kp_consumer_behavior_process",
        "kp_consumer_influences",
        "kp_consumer_decision",
        "kp_digital_consumer",
    ],
    "第5章": ["kp_org_market", "kp_producer_market", "kp_nonprofit_government", "kp_digital_org_market"],
}

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

KEYWORDS = [
    ("政治", "kp_env_political"),
    ("经济体制", "kp_env_econ_system"),
    ("经济结构", "kp_env_econ_structure"),
    ("经济形势", "kp_env_econ_situation"),
    ("经济政策", "kp_env_econ_policy"),
    ("经济", "kp_env_economic"),
    ("文化", "kp_env_culture"),
    ("人口", "kp_env_population"),
    ("技术", "kp_env_technology"),
    ("自然", "kp_env_natural"),
    ("法律", "kp_env_legal"),
    ("供应商", "kp_env_supplier"),
    ("营销中介", "kp_env_intermediary"),
    ("竞争者", "kp_env_competitor"),
    ("公众", "kp_env_public"),
    ("参照群体", "kp_reference_group"),
    ("家庭", "kp_family"),
    ("社会阶层", "kp_social_class"),
    ("动机", "kp_needs_motives"),
    ("知觉", "kp_perception"),
    ("学习", "kp_learning"),
    ("态度", "kp_beliefs_attitudes"),
    ("情境", "kp_situational"),
    ("确认需要", "kp_need_recognition"),
    ("信息搜集", "kp_info_search"),
    ("评估选择", "kp_evaluation"),
    ("购买决定", "kp_purchase_decision"),
    ("购后", "kp_post_purchase"),
    ("直接重购", "kp_producer_buying_types"),
    ("修正重购", "kp_producer_buying_types"),
    ("新购", "kp_producer_buying_types"),
    ("机会威胁", "kp_env_opportunity_threat"),
    ("营销对策", "kp_env_response"),
    ("个人因素", "kp_personal"),
    ("政府采购", "kp_government_procurement"),
    ("政府市场", "kp_government_market"),
    ("非营利", "kp_nonprofit_market"),
    ("组织市场", "kp_org_market_concept"),
    ("生产者市场", "kp_producer_market"),
    ("直播", "kp_digital_consumer_traits"),
    ("隐私", "kp_digital_consumer_traits"),
    ("算法", "kp_digital_consumer_traits"),
]

SKIP_SPECIALS = {"学习目标", "思考：", "基本概念", "思考题", "实践训练", "推荐阅读"}
SKIP_SPECIALS_NORM = {norm(x) for x in SKIP_SPECIALS}


def chapter_key(chapter: str) -> str:
    m = re.search(r"第\s*([３-５])\s*章", chapter or "")
    if not m:
        return chapter
    return "第" + {"３": "3", "４": "4", "５": "5"}[m.group(1)] + "章"


def primary_for(rec: dict) -> tuple[str | None, str]:
    chapter = chapter_key(rec["chapter"])
    section = norm(rec["section"])
    topic = norm(rec["topic"])
    subsection = norm(rec["subsection"])

    if rec["kind"] == "figure":
        kp = TOPIC_MAP.get(topic) or SECTION_MAP.get(section)
        return kp, "example"

    if subsection == "引例":
        sections = CHAPTER_SECTIONS.get(chapter, [])
        return (sections[0] if sections else None), "example"

    if subsection == "案例分析":
        sections = CHAPTER_SECTIONS.get(chapter, [])
        return (sections[-1] if sections else None), "example"

    if subsection.startswith("营销视角"):
        return (TOPIC_MAP.get(topic) or SECTION_MAP.get(section)), "example"

    return (TOPIC_MAP.get(topic) or SECTION_MAP.get(section)), "core"


def make_tag(block_id: str, tag_type: str, tag_key: str, tag_name: str, role: str, confidence: float, evidence: str, idx: int) -> dict:
    return {
        "tag_id": f"ct-{block_id}-{idx:02d}",
        "block_id": block_id,
        "tag_type": tag_type,
        "tag_key": tag_key,
        "tag_name": tag_name,
        "tag_role": role,
        "confidence": confidence,
        "method": "rule",
        "evidence_span": evidence[:120],
        "is_gold": False,
        "review_status": "draft",
        "version": "v0.1",
    }


def main() -> None:
    raw = [json.loads(line) for line in (DATA_DIR / "raw_blocks.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]

    content_blocks = []
    content_tags = []
    structure = []

    for rec in raw:
        if rec["kind"] in {"chapter", "section", "h2", "h3", "special"}:
            structure.append(
                {
                    "block_id": rec["block_id"],
                    "kind": rec["kind"],
                    "chapter": rec["chapter"],
                    "section": rec["section"],
                    "topic": rec["topic"],
                    "page": rec["page"],
                    "text": rec["text"],
                }
            )
            continue

        if rec["kind"] not in {"paragraph", "figure"}:
            continue

        if norm(rec["subsection"]) in SKIP_SPECIALS_NORM:
            continue

        block = {
            "block_id": rec["block_id"],
            "chapter": rec["chapter"],
            "section": rec["section"],
            "topic": rec["topic"],
            "page": rec["page"],
            "block_type": rec["kind"],
            "text": rec["text"],
            "source": "市场营销学（第5版·数字教材版）",
            "rights": "institution-licensed",
            "review_status": "auto",
        }
        content_blocks.append(block)

        primary, role = primary_for(rec)
        tags = []
        if primary and primary in KP_BY_ID:
            kp = KP_BY_ID[primary]
            tags.append(make_tag(block["block_id"], "knowledge_point", primary, kp["name"], role, 0.90 if role == "core" else 0.75, block["text"], len(tags) + 1))

            for comp in kp.get("competencies", [])[:1]:
                comp_id = COMPETENCY_IDS.get(comp)
                if comp_id:
                    tags.append(make_tag(block["block_id"], "competency", comp_id, comp, "core", 0.80, block["text"], len(tags) + 1))

            for dec in kp.get("decisions", [])[:1]:
                dec_id = DECISION_IDS.get(dec)
                if dec_id:
                    tags.append(make_tag(block["block_id"], "decision", dec_id, dec, "core", 0.70, block["text"], len(tags) + 1))

        seen = {t["tag_key"] for t in tags}
        for keyword, kp_id in KEYWORDS:
            if len([t for t in tags if t["tag_type"] == "knowledge_point"]) >= 3:
                break
            if kp_id in seen or kp_id == primary:
                continue
            if keyword in block["text"]:
                kp = KP_BY_ID.get(kp_id)
                if kp:
                    tags.append(make_tag(block["block_id"], "knowledge_point", kp_id, kp["name"], "mention", 0.55, block["text"], len(tags) + 1))
                    seen.add(kp_id)

        content_tags.extend(tags)

    # Write content blocks
    with (DATA_DIR / "content_blocks.jsonl").open("w", encoding="utf-8") as f:
        for b in content_blocks:
            f.write(json.dumps(b, ensure_ascii=False) + "\n")

    # Write tags
    with (DATA_DIR / "content_tags.jsonl").open("w", encoding="utf-8") as f:
        for t in content_tags:
            f.write(json.dumps(t, ensure_ascii=False) + "\n")

    # Write structure
    (DATA_DIR / "structure.json").write_text(json.dumps(structure, ensure_ascii=False, indent=2), encoding="utf-8")

    # Review CSV
    by_block: dict[str, list[dict]] = {}
    for t in content_tags:
        by_block.setdefault(t["block_id"], []).append(t)

    with (DATA_DIR / "review_natural.csv").open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["block_id", "chapter", "section", "topic", "page", "block_type", "text", "primary_kp_id", "primary_kp_name", "tag_role", "confidence", "tags", "review_status"])
        for b in content_blocks:
            tags = by_block.get(b["block_id"], [])
            primary = next((t for t in tags if t["tag_type"] == "knowledge_point"), None)
            tag_str = "; ".join(f"{t['tag_key']}|{t['tag_role']}|{t['confidence']}" for t in tags)
            writer.writerow([
                b["block_id"],
                b["chapter"],
                b["section"],
                b["topic"],
                b["page"],
                b["block_type"],
                b["text"],
                primary["tag_key"] if primary else "",
                primary["tag_name"] if primary else "",
                primary["tag_role"] if primary else "",
                primary["confidence"] if primary else "",
                tag_str,
                "draft",
            ])

    # Stats
    kp_counts = Counter(t["tag_key"] for t in content_tags if t["tag_type"] == "knowledge_point")
    covered = {k for k, v in kp_counts.items() if v > 0}
    stats = {
        "content_blocks": len(content_blocks),
        "content_tags": len(content_tags),
        "blocks_with_tags": len(by_block),
        "knowledge_points": len(KPS),
        "knowledge_points_covered": len(covered),
        "knowledge_points_uncovered": sorted(set(KP_BY_ID) - covered),
        "chapter_blocks": dict(Counter(b["chapter"] for b in content_blocks)),
        "tag_type_counts": dict(Counter(t["tag_type"] for t in content_tags)),
        "tag_role_counts": dict(Counter(t["tag_role"] for t in content_tags)),
        "top_kps": kp_counts.most_common(15),
    }
    (DATA_DIR / "stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")

    print(json.dumps({k: stats[k] for k in ["content_blocks", "content_tags", "blocks_with_tags", "knowledge_points", "knowledge_points_covered"]}, ensure_ascii=False, indent=2))
    print("uncovered:", stats["knowledge_points_uncovered"])


if __name__ == "__main__":
    main()
