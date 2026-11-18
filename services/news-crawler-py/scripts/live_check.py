"""Live verification for a set of sources: fetch a few real items and print a table.

This is the acceptance tool for every adapter: it proves the source returns
real, non-empty articles with a real URL, not just that the code imports.

    python scripts/live_check.py --source stcn --source yicai --min-items 5
"""

from __future__ import annotations

import argparse
import asyncio
import statistics
import sys
from pathlib import Path

from news_crawler.http import HttpClient, HttpPolicy
from news_crawler.normalize import NormalizedArticle
from news_crawler.registry import SOURCES
from news_crawler.runner import RunnerConfig, SourceRunner
from news_crawler.sources import build_sources


class ProbeSink:
    """Collects what a real sink would have stored, without touching a database."""

    def __init__(self) -> None:
        self.items: list[NormalizedArticle] = []

    async def emit(self, article: NormalizedArticle) -> str:
        self.items.append(article)
        return "inserted"

    async def close(self) -> None:
        return None


async def probe(source_id: str, min_items: int, timeout_s: float, browser: bool) -> dict:
    descriptor = SOURCES[source_id]
    policies = {source_id: HttpPolicy.from_source(descriptor.policy)}
    http = HttpClient(policies, browser_fallback=browser)
    sources = build_sources(http, {source_id: descriptor})
    runner = SourceRunner(sources, RunnerConfig(max_items=min_items, max_pages=1))
    sink = ProbeSink()
    try:
        result = await asyncio.wait_for(runner.run_source(source_id, sink), timeout=timeout_s)
    except TimeoutError:
        return {
            "source": source_id,
            "status": "timeout",
            "fetched": 0,
            "ok": len(sink.items),
            "median": 0,
            "shortest": 0,
            "failure": f"exceeded {timeout_s:.0f}s wall clock",
        }
    finally:
        await http.close()
    lengths = [len(article.content) for article in sink.items]
    failure = ""
    if result.failures:
        first = result.failures[0]
        failure = f"[{first.stage.value}] {first.message[:110]}"
    return {
        "source": source_id,
        "status": result.status.value,
        "fetched": result.fetched,
        "ok": len(sink.items),
        "median": int(statistics.median(lengths)) if lengths else 0,
        "shortest": min(lengths) if lengths else 0,
        "failure": failure,
    }


async def main_async(args: argparse.Namespace) -> int:
    ids = args.source or [source_id for source_id, s in SOURCES.items() if s.enabled]
    unknown = [source_id for source_id in ids if source_id not in SOURCES]
    if unknown:
        print(f"未注册的 source: {', '.join(unknown)}", file=sys.stderr)
        return 2
    rows = []
    for source_id in ids:
        rows.append(await probe(source_id, args.min_items, args.timeout, args.browser))
        row = rows[-1]
        print(
            f"{row['source']:<18} {row['status']:<15} fetch={row['fetched']:<4} "
            f"ok={row['ok']:<3} median={row['median']:<5} min={row['shortest']:<5} {row['failure']}"
        )
    failed = [
        row
        for row in rows
        if row["status"] not in {"success", "partial_failure"} or row["ok"] < args.min_items
    ]
    print(
        f"\n{len(rows) - len(failed)}/{len(rows)} 源达标"
        + (f"；未达标: {', '.join(row['source'] for row in failed)}" if failed else "")
    )
    if args.report:
        import json

        path = Path(args.report)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"报告: {path.resolve()}")
    return 0 if not failed else 1


def main() -> None:
    parser = argparse.ArgumentParser(description="逐源真实抓取自检")
    parser.add_argument("--source", action="append", default=None, help="可重复；默认全部启用源")
    parser.add_argument("--min-items", type=int, default=5, help="每源至少入库条数")
    parser.add_argument("--timeout", type=float, default=120.0, help="单源整体超时（秒）")
    parser.add_argument("--browser", action="store_true", help="启用 Playwright 兜底")
    parser.add_argument("--report", type=str, default=None, help="把结果写成 JSON")
    raise SystemExit(asyncio.run(main_async(parser.parse_args())))


if __name__ == "__main__":
    main()
