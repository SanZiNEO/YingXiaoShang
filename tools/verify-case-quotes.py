#!/usr/bin/env python3
"""校验案例精讲文档里的引文是否真的能回到新闻原文。

用法：
    python tools/verify-case-quotes.py docs/cases/anta-stpb-2025-03-24.md --news-id wscn-3743764

规则（对应 case-playbook 第四步「证据可回原文」）：
    文档中每一行 `> 「……」` 视为一条引文，
    必须在 data/normalized/news_articles.json 对应新闻的 content 里
    以**严格子串**形式存在，否则判为二次概括（不合格）。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NEWS = ROOT / "data" / "normalized" / "news_articles.json"
QUOTE_RE = re.compile(r"^> 「(.+?)」$", re.M)


def load_article(news_id: str) -> dict:
    items = json.loads(NEWS.read_text(encoding="utf-8"))
    for item in items:
        if item.get("id") == news_id:
            return item
    raise SystemExit(f"找不到新闻 id={news_id}，可用 id 示例：{items[0].get('id')}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("md")
    ap.add_argument("--news-id", required=True)
    args = ap.parse_args()

    article = load_article(args.news_id)
    content = article.get("content") or ""
    md = Path(args.md).read_text(encoding="utf-8")
    quotes = QUOTE_RE.findall(md)

    print(f"新闻：{article.get('title')}")
    print(f"原文：{article.get('url')}（{len(content)} 字）")
    print(f"引文：{len(quotes)} 条\n")

    misses = []
    for index, quote in enumerate(quotes, 1):
        hit = quote in content
        print(f"  {'PASS' if hit else 'FAIL'}  {index:02d}  {quote[:52]}")
        if not hit:
            misses.append(quote)

    print(f"\n结果：{len(quotes) - len(misses)}/{len(quotes)} 通过")
    if misses:
        print("\n以下引文在原文中找不到，属于二次概括，必须改写或删除：")
        for quote in misses:
            print("  -", quote)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
