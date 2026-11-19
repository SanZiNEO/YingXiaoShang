"""Command line entry point."""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

from . import db
from .http import HttpClient, HttpPolicy
from .http_api import HttpControlPlane
from .models import SourceRunResult
from .output import CompositeSink, JsonlSink, SQLiteSink
from .registry import SOURCES
from .runner import RunnerConfig, SourceRunner
from .service import CrawlService
from .sources import build_sources

DEFAULT_DB = ".data/news.db"


def build_runner(args: argparse.Namespace) -> tuple[SourceRunner, HttpClient, object]:
    descriptors = {
        source_id: descriptor for source_id, descriptor in SOURCES.items() if descriptor.enabled
    }
    policies = {
        source_id: HttpPolicy.from_source(
            descriptor.policy,
            anti_crawler=descriptor.capabilities.anti_crawler,
        )
        for source_id, descriptor in descriptors.items()
    }
    if args.fast:
        # Compatibility flag: drop the opt-in anti-crawler gap for stress runs.
        policies = {
            source_id: HttpPolicy(policy.timeout_s, policy.retries)
            for source_id, policy in policies.items()
        }
    http = HttpClient(policies, browser_fallback=args.browser)
    sources = build_sources(http, descriptors)
    config = RunnerConfig(
        workers=args.workers or 8,
        detail_concurrency=args.detail_concurrency,
        max_items=args.max_items,
        max_pages=args.max_pages,
        unlimited_items=args.unlimited,
    )
    return SourceRunner(sources, config), http, sources


def make_sink(args: argparse.Namespace) -> object | None:
    sinks = []
    if args.output:
        path = Path(args.output)
        sinks.append(JsonlSink(path, truncate=not args.append))
    if args.db:
        sinks.append(SQLiteSink(Path(args.db)))
    if not sinks:
        return None
    if len(sinks) == 1:
        return sinks[0]
    return CompositeSink(sinks)


def _record_runs(
    conn: object | None, results: list[SourceRunResult], trigger: str
) -> None:
    """Persist one statistics row per source round; no-op without a DB connection."""
    if conn is None:
        return
    for result in results:
        db.record_run(conn, db.run_from_result(result, trigger))


def select_sources(args: argparse.Namespace) -> list[str]:
    if args.source:
        unknown = [source_id for source_id in args.source if source_id not in SOURCES]
        if unknown:
            raise SystemExit(f"未注册的 source: {', '.join(unknown)}")
        return list(args.source)
    return [source_id for source_id, source in SOURCES.items() if source.enabled]


def format_result(result: SourceRunResult) -> str:
    status = result.status.value
    return (
        f"{result.source:<12} {status:<15} "
        f"fetch={result.fetched:<5} insert={result.inserted:<5} "
        f"update={result.updated:<4} skip={result.skipped:<4} "
        f"err={result.errors:<3} {result.duration_ms / 1000:.1f}s"
    )


def print_results(results: list[SourceRunResult]) -> None:
    print("\nsource       status           fetched  inserted updated skip errors time")
    for result in results:
        print(format_result(result))
    print(
        "TOTAL        "
        f"fetch={sum(r.fetched for r in results)} "
        f"insert={sum(r.inserted for r in results)} "
        f"update={sum(r.updated for r in results)} "
        f"skip={sum(r.skipped for r in results)} "
        f"err={sum(r.errors for r in results)}"
    )
    failures = [(r.source, f) for r in results for f in r.failures[:3]]
    if failures:
        print("\n前几条失败：")
        for source, failure in failures[:12]:
            print(f"  {source} [{failure.stage.value}] {failure.message}")


async def crawl(args: argparse.Namespace) -> int:
    runner, http, _sources = build_runner(args)
    sink = make_sink(args)
    if sink is None:
        print("需要 --output 或 --db 作为入库目标", file=sys.stderr)
        await http.close()
        return 2
    stats_conn = db.connect(args.db) if args.db else None
    source_ids = select_sources(args)
    try:
        results = await runner.run_all(source_ids, sink)
        print_results(results)
        _record_runs(stats_conn, results, "manual")
        return 0 if any(result.status.value != "failure" for result in results) else 1
    finally:
        if stats_conn is not None:
            stats_conn.close()
        await sink.close()
        await http.close()


async def bench(args: argparse.Namespace) -> int:
    runner, http, _sources = build_runner(args)
    sink = make_sink(args)
    if sink is None:
        print("需要 --output 或 --db 作为入库目标", file=sys.stderr)
        await http.close()
        return 2
    stats_conn = db.connect(args.db) if args.db else None
    source_ids = select_sources(args)
    try:
        results = await runner.benchmark(source_ids, args.seconds, sink)
        print_results(results)
        print(f"\n{args.seconds:.0f}s 内合计入库 {sum(r.inserted for r in results)} 条")
        _record_runs(stats_conn, results, "bench")
        return 0
    finally:
        if stats_conn is not None:
            stats_conn.close()
        await sink.close()
        await http.close()


def _build_service(args: argparse.Namespace) -> CrawlService:
    runner, http, _sources = build_runner(args)
    sink = make_sink(args)
    return CrawlService(
        runner,
        http=http,
        sink=sink,
        db_path=args.db,
        workers=args.workers,
        max_run_s=getattr(args, "max_run_s", 90.0),
        source_ids=select_sources(args),
    )


async def schedule(args: argparse.Namespace) -> int:
    service = _build_service(args)
    if service.sink is None:
        print("需要 --output 或 --db 作为入库目标", file=sys.stderr)
        await service.stop()
        return 2
    print("调度已启动；Ctrl+C 停止。")
    await service.start()
    try:
        await service.wait_stopped()
    except KeyboardInterrupt:
        pass
    finally:
        await service.stop()
    return 0


async def serve(args: argparse.Namespace) -> int:
    service = _build_service(args)
    plane = HttpControlPlane(service, host=args.host, port=args.port)
    await service.start()
    try:
        plane.start()
        print(
            f"采集服务已启动：控制面 http://{args.host}:{args.port}  "
            f"DB={args.db}  workers={service.workers}  单轮超时={service.max_run_s:.0f}s  "
            f"源数={len(service.source_ids)}"
        )
        await service.wait_stopped()
    except KeyboardInterrupt:
        pass
    finally:
        plane.close()
        await service.stop()
    return 0


async def once(args: argparse.Namespace) -> int:
    service = _build_service(args)
    if service.sink is None:
        print("需要 --output 或 --db 作为入库目标", file=sys.stderr)
        await service.stop()
        return 2
    await service.start(schedule=False)
    try:
        results = await service.run_round(None, trigger="manual", wait=True)
        print_results(results)
        return 0 if any(result.status.value != "failure" for result in results) else 1
    finally:
        await service.stop()


def status_cmd(args: argparse.Namespace) -> int:
    conn = db.connect(args.db)
    rows = db.source_health(conn)
    if args.source:
        rows = [row for row in rows if row["source"] in args.source]
    if not rows:
        print("（库里还没有任何运行记录）")
        return 0
    print(
        f"{'source':<12} {'status':<17} {'started_at':<26} {'dur_ms':>7} "
        f"{'fetch':>5} {'ins':>5} {'upd':>5} {'skip':>5} {'err':>4} "
        f"{'runs':>5} {'tot_ins':>7}  last_failures"
    )
    for row in rows:
        totals = row["totals"]
        failures = row["failures"]
        failure_note = ""
        if failures:
            first = failures[0]
            failure_note = f"[{first.get('stage', '')}] {first.get('message', '')[:40]}"
        print(
            f"{row['source']:<12} {row['status']:<17} {row['started_at']:<26} "
            f"{row['duration_ms']:>7} {row['fetched']:>5} {row['inserted']:>5} "
            f"{row['updated']:>5} {row['skipped']:>5} {row['errors']:>4} "
            f"{totals['runs']:>5} {totals['inserted'] or 0:>7}  {failure_note}"
        )
    return 0


def _add_crawl_flags(
    sub: argparse.ArgumentParser, *, with_seconds: bool = False, db_default: str | None = None
) -> None:
    sub.add_argument(
        "--source", action="append", choices=sorted(SOURCES), help="可重复；默认全部"
    )
    sub.add_argument("--output", type=str, default=None, help="JSONL 输出路径")
    sub.add_argument(
        "--db", type=str, default=db_default,
        help=f"SQLite 路径；默认 {db_default or '不写库'}",
    )
    sub.add_argument("--append", action="store_true", help="追加 JSONL；默认覆盖")
    sub.add_argument(
        "--workers", type=int, default=None,
        help="同时运行的源数；默认 8，可用 NEWS_CRAWLER_WORKERS 覆盖",
    )
    sub.add_argument(
        "--detail-concurrency",
        type=int,
        default=None,
        help="覆盖单源详情并发；默认按源 policy，普通源至少 4，anti 源保留自身低值",
    )
    sub.add_argument("--max-items", type=int, default=None, help="单源单轮候选上限；0 为不限")
    sub.add_argument("--unlimited", action="store_true", help="不限制单源候选数")
    sub.add_argument("--max-pages", type=int, default=None, help="单源单轮分页上限")
    sub.add_argument("--browser", action="store_true", help="启用 Playwright 兜底")
    sub.add_argument(
        "--fast",
        action="store_true",
        help="压测兼容参数：仅去掉 anti 源 opt-in 间隔；普通请求本来就不等待",
    )
    if with_seconds:
        sub.add_argument("--seconds", type=float, default=30.0)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="news-crawler")
    subparsers = parser.add_subparsers(dest="command", required=True)

    list_parser = subparsers.add_parser("list-sources", help="列出已注册新闻源")
    list_parser.set_defaults(command="list-sources")

    for name, help_text in (
        ("crawl", "跑一轮指定源并退出"),
        ("bench", "在限定秒数内并发压测所有源"),
        ("schedule", "按每源 interval 周期运行（委托长驻服务）"),
        ("once", "手动跑一轮并落统计"),
        ("serve", "长驻采集服务 + HTTP 控制面"),
    ):
        sub = subparsers.add_parser(name, help=help_text)
        db_default = DEFAULT_DB if name in ("once", "serve") else None
        _add_crawl_flags(
            sub, with_seconds=(name == "bench"), db_default=db_default
        )
        if name == "serve":
            sub.add_argument(
                "--host", type=str,
                default=os.environ.get("NEWS_CRAWLER_HOST", "127.0.0.1"),
            )
            sub.add_argument(
                "--port", type=int,
                default=int(os.environ.get("NEWS_CRAWLER_PORT", "8787")),
            )
            sub.add_argument("--max-run-s", type=float, default=90.0, help="单源单轮硬超时（秒）")

    status_parser = subparsers.add_parser("status", help="从数据库读取每源最近状态表")
    status_parser.add_argument("--source", action="append", choices=sorted(SOURCES))
    status_parser.add_argument("--db", type=str, default=DEFAULT_DB)

    return parser


async def async_main(args: argparse.Namespace) -> int:
    if args.command == "list-sources":
        for source in SOURCES.values():
            policy = source.policy
            print(
                f"{source.id:<12} {source.name:<14} group={source.group:<10} "
                f"adapter={source.adapter:<10} pagination={source.pagination:<8} "
                f"detail={policy.detail_concurrency} interval={policy.interval_s:.0f}s "
                f"enabled={source.enabled}"
            )
        return 0
    if args.command == "crawl":
        return await crawl(args)
    if args.command == "bench":
        return await bench(args)
    if args.command == "schedule":
        return await schedule(args)
    if args.command == "serve":
        return await serve(args)
    if args.command == "once":
        return await once(args)
    if args.command == "status":
        return status_cmd(args)
    return 2


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if getattr(args, "max_items", None) == 0:
        args.max_items = None
        args.unlimited = True
    if getattr(args, "max_pages", None) == 0:
        args.max_pages = None
    try:
        raise SystemExit(asyncio.run(async_main(args)))
    except KeyboardInterrupt:
        raise SystemExit(130) from None


if __name__ == "__main__":
    main()
