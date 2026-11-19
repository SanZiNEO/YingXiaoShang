"""Export the Python source registry as a `news-ingest/v1` sources.json.

The ingest side refuses an unregistered `sourceId`, so the registry has to be
generated from the one place that owns the descriptors instead of being
hand-copied. Run it whenever a source is added:

    python scripts/export_registry.py --out .data/sources.json
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from news_crawler.registry import SOURCES

# news-ingest/v1 only knows five groups; the crawler keeps finer-grained ones.
GROUP_MAP = {
    "industry": "news",
    "finance": "news",
    "portal": "news",
    "company": "news",
    "case": "marketing",
    "brandnews": "marketing",
    "data": "data",
    "consulting": "data",
    "official": "official",
    "ecommerce": "vertical",
}

DEFAULT_OUT = Path(__file__).resolve().parents[1] / ".data" / "sources.json"


def export() -> dict:
    sources = []
    for source in sorted(SOURCES.values(), key=lambda item: item.id):
        sources.append(
            {
                "id": source.id,
                "name": source.name,
                "homepage": source.homepage,
                "group": GROUP_MAP[source.group],
                "section": source.group,
                "language": source.language,
                "defaultContentMode": source.capabilities.content_mode,
                "aggregator": False,
                "enabled": source.enabled,
                "note": source.note,
            }
        )
    return {"version": 1, "sources": sources}


def main() -> None:
    parser = argparse.ArgumentParser(description="导出 news-ingest/v1 来源注册表")
    parser.add_argument("--out", type=str, default=str(DEFAULT_OUT))
    args = parser.parse_args()
    payload = export()
    path = Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    enabled = sum(1 for source in payload["sources"] if source["enabled"])
    print(f"导出 {len(payload['sources'])} 个源（启用 {enabled}）→ {path.resolve()}")


if __name__ == "__main__":
    main()
