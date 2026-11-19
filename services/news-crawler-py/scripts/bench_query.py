"""query_news 门面真实验收脚本。

≥30 次真实调用（冷/热 query 混合），统计 p50/p95/max 耗时、平均条数、降级率，
并写 JSON 报告。每次调用走真实注册表与真实 SQLite；慢源/风控/异常由门面内部降级。

用法：

    python scripts/bench_query.py --calls 30 --budget 3 --limit 40
    python scripts/bench_query.py --db .data/news.db --report .data/bench_query_report.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

# 允许从源码目录直接运行（未安装包时兜底）。
SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from news_crawler.query import query_news

SERVICE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = SERVICE_ROOT / ".data" / "news.db"
DEFAULT_REPORT = SERVICE_ROOT / ".data" / "bench_query_report.json"

# 热查询：空 query（最新入库）+ 宽词，优先命中库内。
HOT_QUERIES = ["", "", "", "品牌", "财经", "消费"]
# 冷查询：库内几乎不可能命中的生僻词，强制走“库内不足 → 增量爬取”路径。
COLD_QUERIES = ["量子烘焙", "跨境冷链", "宠物殡葬", "深海采矿", "极地科考"]


def _percentile(values: list[float], pct: float) -> float:
    """线性插值百分位；空列表返回 0。"""
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * pct / 100
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def _classify(query: str) -> str:
    return "cold" if query in COLD_QUERIES else "hot"


async def run_bench(args: argparse.Namespace) -> dict:
    records: list[dict] = []
    for index in range(args.calls):
        # 约 60% 热查询、40% 冷查询，交替排布。
        query = (
            HOT_QUERIES[index % len(HOT_QUERIES)]
            if index % 5 < 3
            else COLD_QUERIES[index % len(COLD_QUERIES)]
        )
        started = time.monotonic()
        result = await query_news(
            query=query,
            limit=args.limit,
            budget_s=args.budget,
            fresh=not args.no_fresh,
            db_path=args.db,
        )
        wall_ms = (time.monotonic() - started) * 1000
        meta = result.meta
        records.append(
            {
                "index": index,
                "type": _classify(query),
                "query": query,
                "items": len(result.items),
                "elapsedMs": round(wall_ms, 1),
                "metaElapsedMs": meta["elapsedMs"],
                "dbHits": meta["dbHits"],
                "crawledHits": meta["crawledHits"],
                "degraded": meta["degraded"],
                "reason": meta["reason"],
                "sourcesUsed": meta["sourcesUsed"],
            }
        )
        print(
            f"[{index + 1:02d}/{args.calls}] {_classify(query):<4} q={query or '<latest>':<10} "
            f"items={len(result.items):<3} elapsed={wall_ms:6.0f}ms "
            f"db={meta['dbHits']:<3} crawl={meta['crawledHits']:<3} degraded={meta['degraded']}"
        )

    def summarize(rows: list[dict]) -> dict:
        elapsed = [row["elapsedMs"] for row in rows]
        return {
            "calls": len(rows),
            "p50Ms": round(_percentile(elapsed, 50), 1),
            "p95Ms": round(_percentile(elapsed, 95), 1),
            "maxMs": round(max(elapsed), 1) if elapsed else 0.0,
            "avgItems": round(statistics.fmean(row["items"] for row in rows), 2) if rows else 0,
            "avgDbHits": round(statistics.fmean(row["dbHits"] for row in rows), 2) if rows else 0,
            "avgCrawledHits": round(
                statistics.fmean(row["crawledHits"] for row in rows), 2
            )
            if rows
            else 0,
            "degradedRate": round(sum(row["degraded"] for row in rows) / len(rows), 3)
            if rows
            else 0,
        }

    by_type = {
        "hot": summarize([row for row in records if row["type"] == "hot"]),
        "cold": summarize([row for row in records if row["type"] == "cold"]),
    }
    report = {
        "generatedAt": datetime.now(UTC).isoformat(),
        "config": {
            "calls": args.calls,
            "limit": args.limit,
            "budgetS": args.budget,
            "fresh": not args.no_fresh,
            "dbPath": str(args.db),
        },
        "totals": summarize(records),
        "byType": by_type,
        "mixedPathEvidence": {
            "callsWithDbHits": sum(row["dbHits"] > 0 for row in records),
            "callsWithCrawledHits": sum(row["crawledHits"] > 0 for row in records),
            "callsWithBoth": sum(row["dbHits"] > 0 and row["crawledHits"] > 0 for row in records),
        },
        "records": records,
    }
    return report


def _print_summary(report: dict) -> None:
    totals = report["totals"]
    print("\n=== query_news 验收汇总 ===")
    print(f"调用次数: {totals['calls']}  预算: {report['config']['budgetS']}s  上限: {report['config']['limit']}")
    print(
        f"耗时 p50={totals['p50Ms']}ms p95={totals['p95Ms']}ms max={totals['maxMs']}ms"
    )
    print(
        f"平均条数={totals['avgItems']}  平均库内={totals['avgDbHits']}  平均现爬={totals['avgCrawledHits']}  "
        f"降级率={totals['degradedRate']}"
    )
    evidence = report["mixedPathEvidence"]
    print(
        f"混合路径证据: 库内命中 {evidence['callsWithDbHits']} 次, "
        f"现爬入库 {evidence['callsWithCrawledHits']} 次, 同时命中 {evidence['callsWithBoth']} 次"
    )
    for kind, summary in report["byType"].items():
        print(
            f"  {kind}: calls={summary['calls']} avgItems={summary['avgItems']} "
            f"avgDb={summary['avgDbHits']} avgCrawl={summary['avgCrawledHits']} "
            f"p50={summary['p50Ms']}ms p95={summary['p95Ms']}ms degraded={summary['degradedRate']}"
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="query_news 门面真实验收")
    parser.add_argument("--calls", type=int, default=30, help="真实调用次数，默认 30")
    parser.add_argument("--budget", type=float, default=3.0, help="单次预算秒数，默认 3.0")
    parser.add_argument("--limit", type=int, default=40, help="返回条数上限，默认 40")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="SQLite 路径")
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT, help="JSON 报告路径")
    parser.add_argument("--no-fresh", action="store_true", help="只查库内，不做增量爬取")
    args = parser.parse_args(argv)

    report = asyncio.run(run_bench(args))
    _print_summary(report)

    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\n报告: {args.report.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
