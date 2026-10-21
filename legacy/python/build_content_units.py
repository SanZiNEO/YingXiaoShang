"""Aggregate natural paragraphs into textbook topic units (h2/h3).

Natural paragraphs stay in content_blocks.jsonl for evidence/quotes.
This script creates a coarser teaching-unit layer aligned to the textbook's
own "一、/（一）" headings.

Outputs:
  content_units.jsonl
  content_unit_tags.jsonl
  review_units.csv
  stats_units.json
"""

from __future__ import annotations

import csv
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import tag_textbook as tt  # noqa: E402

DATA_DIR = ROOT / "data" / "marketing_textbook" / "ch03-05"
RAW = DATA_DIR / "raw_blocks.jsonl"


def main() -> None:
    rows = [json.loads(line) for line in RAW.read_text(encoding="utf-8").splitlines() if line.strip()]

    units: list[dict] = []
    current: dict | None = None

    def flush() -> None:
        nonlocal current
        if current and current["text_parts"]:
            current["text"] = "\n".join(current["text_parts"]).strip()
            units.append(current)
        current = None

    for r in rows:
        kind = r["kind"]
        if kind == "chapter":
            flush()
            continue
        if kind == "section":
            flush()
            continue
        if kind in {"h2", "h3"}:
            flush()
            current = {
                "unit_id": "",
                "unit_type": "topic",
                "chapter": r["chapter"],
                "section": r["section"],
                "topic": r["text"],
                "subsections": [],
                "paragraph_ids": [],
                "figure_ids": [],
                "page_start": r["page"],
                "page_end": r["page"],
                "text_parts": [r["text"]],
            }
            continue
        if current is None:
            continue
        if kind == "h4":
            current["subsections"].append(r["text"])
            current["text_parts"].append("\n## " + r["text"])
            current["page_end"] = r["page"]
        elif kind == "paragraph":
            current["paragraph_ids"].append(r["block_id"])
            current["text_parts"].append(r["text"])
            current["page_end"] = r["page"]
        elif kind == "figure":
            current["figure_ids"].append(r["block_id"])
            current["text_parts"].append("（图）" + r["text"])
            current["page_end"] = r["page"]

    flush()

    # Stable unit IDs.
    for i, u in enumerate(units, 1):
        prefix = tt.chapter_key(u["chapter"]).replace("第", "ch").replace("章", "")
        u["unit_id"] = f"unit-{prefix}-{i:04d}"
        del u["text_parts"]

    with (DATA_DIR / "content_units.jsonl").open("w", encoding="utf-8") as f:
        for u in units:
            f.write(json.dumps(u, ensure_ascii=False) + "\n")

    # Tag units with the same controlled vocabulary.
    tag_rows = []
    for u in units:
        primary, role = tt.primary_for({
            "kind": "paragraph",
            "chapter": u["chapter"],
            "section": u["section"],
            "topic": u["topic"],
            "subsection": u["topic"],
        })
        tags = []
        seen = set()
        if primary and primary in tt.KP_BY_ID:
            kp = tt.KP_BY_ID[primary]
            tags.append(tt.make_tag(u["unit_id"], "knowledge_point", primary, kp["name"], "core", 0.95, u["text"], len(tags) + 1))
            seen.add(primary)
            for comp in kp.get("competencies", [])[:1]:
                comp_id = tt.COMPETENCY_IDS.get(comp)
                if comp_id:
                    tags.append(tt.make_tag(u["unit_id"], "competency", comp_id, comp, "core", 0.85, u["text"], len(tags) + 1))
            for dec in kp.get("decisions", [])[:1]:
                dec_id = tt.DECISION_IDS.get(dec)
                if dec_id:
                    tags.append(tt.make_tag(u["unit_id"], "decision", dec_id, dec, "core", 0.75, u["text"], len(tags) + 1))

        for keyword, kp_id in tt.KEYWORDS:
            if len([t for t in tags if t["tag_type"] == "knowledge_point"]) >= 3:
                break
            if kp_id in seen or kp_id == primary:
                continue
            if keyword in u["text"]:
                kp = tt.KP_BY_ID.get(kp_id)
                if kp:
                    tags.append(tt.make_tag(u["unit_id"], "knowledge_point", kp_id, kp["name"], "mention", 0.55, u["text"], len(tags) + 1))
                    seen.add(kp_id)
        tag_rows.extend(tags)

    with (DATA_DIR / "content_unit_tags.jsonl").open("w", encoding="utf-8") as f:
        for t in tag_rows:
            f.write(json.dumps(t, ensure_ascii=False) + "\n")

    by_unit: dict[str, list[dict]] = {}
    for t in tag_rows:
        by_unit.setdefault(t["block_id"], []).append(t)

    with (DATA_DIR / "review_units.csv").open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["unit_id", "chapter", "section", "topic", "page_start", "page_end", "paragraphs", "primary_kp", "tags", "text"])
        for u in units:
            tags = by_unit.get(u["unit_id"], [])
            primary = next((t for t in tags if t["tag_type"] == "knowledge_point"), None)
            writer.writerow([
                u["unit_id"], u["chapter"], u["section"], u["topic"],
                u["page_start"], u["page_end"], len(u["paragraph_ids"]),
                primary["tag_key"] if primary else "",
                "; ".join(f"{t['tag_key']}|{t['tag_role']}|{t['confidence']}" for t in tags),
                u["text"][:1200],
            ])

    stats = {
        "units": len(units),
        "tags": len(tag_rows),
        "paragraphs_total": sum(len(u["paragraph_ids"]) for u in units),
        "units_without_paragraphs": [u["unit_id"] for u in units if not u["paragraph_ids"]],
        "tag_type_counts": dict(Counter(t["tag_type"] for t in tag_rows)),
        "tag_role_counts": dict(Counter(t["tag_role"] for t in tag_rows)),
        "chapter_units": dict(Counter(u["chapter"] for u in units)),
        "top_kps": Counter(t["tag_key"] for t in tag_rows if t["tag_type"] == "knowledge_point").most_common(15),
    }
    (DATA_DIR / "stats_units.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: stats[k] for k in ["units", "tags", "paragraphs_total", "tag_type_counts"]}, ensure_ascii=False, indent=2))
    print("output:", DATA_DIR / "content_units.jsonl")


if __name__ == "__main__":
    main()
