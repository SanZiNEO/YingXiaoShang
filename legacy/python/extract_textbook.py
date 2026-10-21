"""Extract chapters 3-5 using the textbook's own layout segmentation.

Key signals:
- body continuation lines start at x0 ~= 79pt;
- a new body paragraph starts with a first-line indent at x0 ~= 100pt;
- right-column body lines start at x0 ~= 249/270pt;
- headings use larger font size or the bold HTJ font;
- "营销视角" boxes use a smaller font and a different x0, and are emitted separately.

Usage:
    uv run python scripts/extract_textbook.py
"""

from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[1]
PDF_PATH = ROOT / "市场营销学（第5版·数字教材版）.pdf"
OUT_DIR = ROOT / "data" / "marketing_textbook" / "ch03-05"
OUT_DIR.mkdir(parents=True, exist_ok=True)

START_PAGE = 63
END_PAGE = 128

HEADER_RE = re.compile(r"^第\s*[３-５]\s*章\s*市场营销")
PAGE_NO_RE = re.compile(r"^[０-９]+$")
CHAPTER_RE = re.compile(r"^第\s*[３-５]\s*章")
SECTION_RE = re.compile(r"^第\s*[０-９]+\s*节")
H2_RE = re.compile(r"^[一二三四五六七八九十]+、")
H3_RE = re.compile(r"^（[一二三四五六七八九十]+）")
H4_RE = re.compile(r"^[０-９]+[．.]?")
FIG_RE = re.compile(r"^(图|表)[０-９]+")
SPECIAL_RE = re.compile(r"^(学习目标|引例|营销视角|案例分析|本章小结|思考：|基本概念|思考题|实践训练|推荐阅读)")


def compact(text: str) -> str:
    return re.sub(r"\s+", "", text or "")


def clean_text(text: str) -> str:
    text = text.replace("\u3000", " ")
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def chapter_number(text: str) -> str:
    m = re.search(r"第\s*([３-５])\s*章", text)
    if not m:
        return ""
    return {"３": "03", "４": "04", "５": "05"}[m.group(1)]


def is_header_footer(text: str, y0: float, page_height: float) -> bool:
    if HEADER_RE.match(text) and re.search(r"[０-９]+\s*$", text):
        return True
    if PAGE_NO_RE.match(text):
        return True
    if y0 < 80 or y0 > page_height - 45:
        return True
    return False


def classify(text: str, x0: float, size: float, bold: bool) -> str:
    c = compact(text)
    if CHAPTER_RE.match(c):
        return "chapter"
    if SECTION_RE.match(c):
        return "section"
    if SPECIAL_RE.match(c):
        return "special"
    if FIG_RE.match(c):
        return "figure"
    if H2_RE.match(c) and (size >= 11.0 or bold):
        return "h2"
    if H3_RE.match(c) and (size >= 11.0 or bold):
        return "h3"
    # Numbered sub-headings are short and bold; body lines with numbers are long.
    if H4_RE.match(c) and bold and size <= 10.8 and len(c) <= 30:
        return "h4"
    if size <= 9.2 and x0 > 130:
        return "sidebar"
    return "body"


def body_left_for(x0: float) -> float:
    # Right-column body lines have continuation x0 ~= 249, first line ~= 270.
    return 249.0 if x0 >= 200 else 79.0


def extract() -> tuple[list[dict], dict]:
    doc = pymupdf.open(PDF_PATH)
    records: list[dict] = []
    chapter = ""
    chapter_no = ""
    section = ""
    topic = ""
    subsection = ""
    current: dict | None = None
    sidebar_records: list[dict] = []
    sizes: Counter[float] = Counter()

    def flush() -> None:
        nonlocal current
        if current and current["text"].strip():
            current["page_end"] = current["page_end"]
            records.append(current)
        current = None

    def start_para(page_no: int, text: str) -> None:
        nonlocal current
        current = {
            "kind": "paragraph",
            "chapter": chapter,
            "section": section,
            "topic": topic,
            "subsection": subsection,
            "page": page_no,
            "page_end": page_no,
            "text": text,
        }

    for page_index in range(START_PAGE - 1, END_PAGE):
        page = doc[page_index]
        page_no = page_index + 1
        page_height = page.rect.height
        lines: list[dict] = []
        sidebar_lines: list[str] = []
        sidebar_heading = ""

        for block in page.get_text("dict")["blocks"]:
            if block.get("type") != 0:
                continue
            for line in block["lines"]:
                spans = line["spans"]
                text = clean_text("".join(s["text"] for s in spans))
                if not text:
                    continue
                x0, y0, x1, y1 = line["bbox"]
                if is_header_footer(text, y0, page_height):
                    continue
                size = max(round(s["size"], 1) for s in spans)
                any_bold = any("HTJ" in s["font"] for s in spans)
                kind = classify(text, x0, size, any_bold)
                if kind == "body":
                    sizes[size] += 1
                if kind == "sidebar":
                    sidebar_lines.append(text)
                    continue
                if kind == "special" and compact(text).startswith("营销视角"):
                    sidebar_heading = text
                lines.append({"text": text, "x0": x0, "y0": y0, "size": size, "kind": kind})

        lines.sort(key=lambda r: (r["y0"], r["x0"]))

        for line in lines:
            text = line["text"]
            kind = line["kind"]

            if kind == "chapter":
                flush()
                chapter = text
                chapter_no = chapter_number(text)
                section = topic = subsection = ""
                records.append({
                    "kind": "chapter", "chapter": chapter, "section": section,
                    "topic": topic, "subsection": subsection,
                    "page": page_no, "page_end": page_no, "text": text,
                })
            elif kind == "section":
                flush()
                section = text
                topic = subsection = ""
                records.append({
                    "kind": "section", "chapter": chapter, "section": section,
                    "topic": topic, "subsection": subsection,
                    "page": page_no, "page_end": page_no, "text": text,
                })
            elif kind in {"h2", "h3"}:
                flush()
                topic = text
                subsection = text
                records.append({
                    "kind": kind, "chapter": chapter, "section": section,
                    "topic": topic, "subsection": subsection,
                    "page": page_no, "page_end": page_no, "text": text,
                })
            elif kind == "h4":
                flush()
                subsection = text
                records.append({
                    "kind": "h4", "chapter": chapter, "section": section,
                    "topic": topic, "subsection": subsection,
                    "page": page_no, "page_end": page_no, "text": text,
                })
            elif kind == "special":
                flush()
                subsection = text
                records.append({
                    "kind": "special", "chapter": chapter, "section": section,
                    "topic": topic, "subsection": subsection,
                    "page": page_no, "page_end": page_no, "text": text,
                })
            elif kind == "figure":
                flush()
                records.append({
                    "kind": "figure",
                    "chapter": chapter,
                    "section": section,
                    "topic": topic,
                    "subsection": subsection,
                    "page": page_no,
                    "page_end": page_no,
                    "text": text,
                })
            elif kind == "body":
                if current is None:
                    start_para(page_no, text)
                else:
                    indented = line["x0"] > body_left_for(line["x0"]) + 10
                    same_context = (
                        current["chapter"] == chapter
                        and current["section"] == section
                        and current["topic"] == topic
                        and current["subsection"] == subsection
                    )
                    if indented or not same_context:
                        flush()
                        start_para(page_no, text)
                    else:
                        current["text"] += text
                        current["page_end"] = page_no

        # Emit a "营销视角" box as a separate paragraph-like block.
        if sidebar_lines:
            text = sidebar_heading + " " + "".join(sidebar_lines) if sidebar_heading else "".join(sidebar_lines)
            sidebar_records.append({
                "kind": "paragraph",
                "chapter": chapter,
                "section": section,
                "topic": topic,
                "subsection": "营销视角",
                "page": page_no,
                "page_end": page_no,
                "text": text.strip(),
            })

    flush()
    records.extend(sidebar_records)

    # Stable IDs after the full sequence is known.
    for i, r in enumerate(records, 1):
        prefix = chapter_number(r["chapter"]) or "xx"
        r["block_id"] = f"ch{prefix}-{i:05d}"
        r["chapter_no"] = chapter_number(r["chapter"])

    meta = {
        "body_size_mode": sizes.most_common(1)[0][0] if sizes else None,
        "pages": [START_PAGE, END_PAGE],
        "records": len(records),
        "kinds": dict(Counter(r["kind"] for r in records)),
    }
    return records, meta


def main() -> None:
    records, meta = extract()
    with (OUT_DIR / "raw_blocks.jsonl").open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    with (OUT_DIR / "raw_blocks.txt").open("w", encoding="utf-8") as f:
        for r in records:
            f.write(f"[{r['block_id']}] p{r['page']} {r['kind']} | {r['section']} | {r['topic']} | {r['subsection']}\n")
            f.write(r["text"] + "\n\n")

    (OUT_DIR / "extract_meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(meta, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
