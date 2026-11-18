"""Command line entry point."""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from .http import HttpClient, HttpPolicy
from .models import SourceRunResult
from .output import CompositeSink, JsonlSink, SQLiteSink
from .registry import SOURCES
from .runner import RunnerConfig, SourceRunner, SourceScheduler
from .sources import build_sources


def build_runner(args: argparse.Namespace) -> tuple[SourceRunner, HttpClient, object]:
    descriptors = {
        source_id: descriptor
        for source_id, descriptor in SOURCES.items()
        if descriptor.enabled
    }
    policies = {
        source_id: HttpPolicy.from_source(descriptor.policy)
        for source_id, descriptor in descriptors.items()
    }
    if args.fast:
        policies = {
            source_id: HttpPolicy(0, policy.timeout_s, policy.retries)
            for source_id, policy in policies.items()
        }
    http = HttpClient(policies, browser_fallback=args.browser)
    sources = build_sources(http, descriptors)
    config = RunnerConfig(
        workers=args.workers,
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
    source_ids = select_sources(args)
    try:
        results = await runner.run_all(source_ids, sink)
        print_results(results)
        return 0 if any(result.status.value != "failure" for result in results) else 1
    finally:
        await sink.close()
        await http.close()


async def bench(args: argparse.Namespace) -> int:
    runner, http, _sources = build_runner(args)
    sink = make_sink(args)
    if sink is None:
        print("需要 --output 或 --db 作为入库目标", file=sys.stderr)
        await http.close()
        return 2
    source_ids = select_sources(args)
    try:
        results = await runner.benchmark(source_ids, args.seconds, sink)
        print_results(results)
        print(f"\n{args.seconds:.0f}s 内合计入库 {sum(r.inserted for r in results)} 条")
        return 0
    finally:
        await sink.close()
        await http.close()


async def schedule(args: argparse.Namespace) -> int:
    runner, http, _sources = build_runner(args)
    sink = make_sink(args)
    if sink is None:
        print("需要 --output 或 --db 作为入库目标", file=sys.stderr)
        await http.close()
        return 2
    scheduler = SourceScheduler(runner, select_sources(args))
    print("调度已启动；Ctrl+C 停止。")
    try:
        await scheduler.start(sink)
    except KeyboardInterrupt:
        pass
    finally:
        await scheduler.stop()
        await sink.close()
        await http.close()
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="news-crawler")
    subparsers = parser.add_subparsers(dest="command", required=True)

    list_parser = subparsers.add_parser("list-sources", help="列出已注册新闻源")
    list_parser.set_defaults(command="list-sources")

    for name, help_text in (
        ("crawl", "跑一轮指定源并退出"),
        ("bench", "在限定秒数内并发压测所有源"),
        ("schedule", "按每源 interval 周期运行"),
    ):
        sub = subparsers.add_parser(name, help=help_text)
        sub.add_argument("--source", action="append", choices=sorted(SOURCES), help="可重复；默认全部")
        sub.add_argument("--output", type=str, default=None, help="JSONL 输出路径")
        sub.add_argument("--db", type=str, default=None, help="SQLite 数据库路径")
        sub.add_argument("--append", action="store_true", help="追加 JSONL；默认覆盖")
        sub.add_argument("--workers", type=int, default=8, help="同时运行的源 worker 数")
        sub.add_argument("--detail-concurrency", type=int, default=None)
        sub.add_argument("--max-items", type=int, default=None, help="单源单轮候选上限；0 为不限")
        sub.add_argument("--unlimited", action="store_true", help="不限制单源候选数")
        sub.add_argument("--max-pages", type=int, default=None, help="单源单轮分页上限")
        sub.add_argument("--browser", action="store_true", help="启用 Playwright 兜底")
        sub.add_argument("--fast", action="store_true", help="压测时关闭每源请求间隔，不建议生产")
        if name == "bench":
            sub.add_argument("--seconds", type=float, default=30.0)

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
    return 2


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if getattr(args, "max_items", None) == 0:
        args.max_items = None
        args.unlimited_items = True
    if getattr(args, "max_pages", None) == 0:
        args.max_pages = None
    try:
        raise SystemExit(asyncio.run(async_main(args)))
    except KeyboardInterrupt:
        raise SystemExit(130) from None


if __name__ == "__main__":
    main()
