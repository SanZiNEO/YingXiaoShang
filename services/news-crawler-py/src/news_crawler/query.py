"""AI 调用检索门面：库内已有 + 事实增量爬取的组合查询。

一次调用在 ``budget_s`` 内返回约 ``limit`` 条可被 AI 直接消费的结果：

1. 先秒开 SQLite 查询（关键词 / 来源过滤，按发布时间倒序）；
2. 库内不足 ``limit`` 且 ``fresh=True`` 时，按剩余预算选源做事实增量爬取
   （列表首屏 + 详情并发，走已有 :class:`SourceRunner` 与注册表，尊重每源 policy）；
3. 抓到的每条经 :class:`SQLiteSink` 即时增量入库（URL 唯一 upsert + content_hash 增量）；
4. 合并库内与新爬结果，按 canonical URL 去重、按发布时间倒序、截断到 ``limit``。

硬契约：单次调用墙钟时间不超过 ``budget_s``；站点慢、被风控、异常都不拖垮调用，
超时即降级返回库内结果，``meta.degraded=True`` 并在 ``meta.reason`` 写清原因；
门面本身不向调用方抛异常。

控制面（后端 / AI）惰性 import 本模块，公开签名与模块路径保持稳定：

    from news_crawler.query import query_news, query_news_sync, QueryResult
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import db
from .html import canonical_url
from .http import HttpClient, HttpPolicy
from .output import SQLiteSink
from .registry import SOURCES
from .runner import RunnerConfig, SourceRunner
from .sources import build_sources

#: 收尾余量：关闭连接、映射字段、序列化的预留时间，保证墙钟不超预算。
TAIL_MARGIN_S = 0.25
#: 剩余预算低于该值时不再发起增量爬取（列表/详情启动本身有成本）。
CRAWL_MIN_BUDGET_S = 0.2
#: 单次门面调用每源候选上限：只取列表首屏，轻量补缺口。
PER_SOURCE_CAP = 12
#: 与 normalize.FULL_TEXT_CHARS 对齐，用于从库内正文反推 contentMode。
FULL_TEXT_CHARS = 300


def _default_db_path() -> Path:
    """默认库路径：服务根目录 ``.data/news.db``（src/news_crawler/query.py 上两级）。"""
    return Path(__file__).resolve().parents[2] / ".data" / "news.db"


def _select_descriptors(
    source_ids: list[str] | None,
) -> tuple[dict[str, Any], list[str]]:
    """按显式名单过滤注册表；未指定时取全部启用源。未知源静默忽略。"""
    if source_ids:
        requested = [source_id for source_id in source_ids if source_id in SOURCES]
        descriptors = {source_id: SOURCES[source_id] for source_id in requested}
    else:
        descriptors = {
            source_id: descriptor
            for source_id, descriptor in SOURCES.items()
            if descriptor.enabled
        }
    return descriptors, list(descriptors)


def _build_http(descriptors: dict[str, Any]) -> HttpClient:
    policies = {
        source_id: HttpPolicy.from_source(descriptor.policy)
        for source_id, descriptor in descriptors.items()
    }
    return HttpClient(policies)


def _build_source_instances(
    http: HttpClient, descriptors: dict[str, Any]
) -> dict[str, Any]:
    return build_sources(http, descriptors)


def _make_sink(db_path: Path) -> SQLiteSink:
    return SQLiteSink(db_path)


def _read_db(
    conn: Any, query: str, limit: int, sources: list[str] | None
) -> list[dict[str, Any]]:
    if query.strip():
        return db.search_articles(conn, query=query, limit=limit, sources=sources)
    return db.latest_articles(conn, limit=limit, sources=sources)


def _row_to_item(row: dict[str, Any]) -> dict[str, Any]:
    descriptor = SOURCES.get(row["source"])
    content = row.get("content") or ""
    return {
        "id": row["id"],
        "source": row["source"],
        "sourceName": descriptor.name if descriptor else row["source"],
        "title": row["title"],
        "url": canonical_url(row["url"]),
        "publishedAt": row.get("published_at") or "",
        "summary": row.get("summary") or "",
        "content": content,
        "contentMode": "full" if len(content) >= FULL_TEXT_CHARS else "summary",
        "contentStatus": row.get("content_status") or "",
        "language": descriptor.language if descriptor else "zh",
    }


def _merge(items: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    """按 canonical URL 去重，按发布时间倒序（空日期排末尾），截断到 limit。"""
    seen: dict[str, dict[str, Any]] = {}
    for item in items:
        key = canonical_url(item["url"]) or item["url"]
        if key not in seen:
            seen[key] = item
    merged = list(seen.values())
    merged.sort(key=lambda item: item["publishedAt"] or "", reverse=True)
    return merged[:limit]


@dataclass(slots=True)
class QueryResult:
    """门面返回值。``items`` 为可被 AI 直接消费的字典列表；``meta`` 为调用元信息。"""

    items: list[dict[str, Any]] = field(default_factory=list)
    meta: dict[str, Any] = field(
        default_factory=lambda: {
            "elapsedMs": 0,
            "dbHits": 0,
            "crawledHits": 0,
            "sourcesUsed": [],
            "degraded": False,
            "reason": "",
        }
    )

    def to_dict(self) -> dict[str, Any]:
        return {"items": self.items, "meta": self.meta}


async def query_news(
    query: str = "",
    limit: int = 40,
    budget_s: float = 3.0,
    fresh: bool = True,
    sources: list[str] | None = None,
    db_path: str | Path | None = None,
) -> QueryResult:
    """检索门面（异步）。参数与语义见模块文档；永不向调用方抛异常。"""
    started = time.monotonic()
    meta: dict[str, Any] = {
        "elapsedMs": 0,
        "dbHits": 0,
        "crawledHits": 0,
        "sourcesUsed": [],
        "degraded": False,
        "reason": "",
    }
    items: list[dict[str, Any]] = []
    conn: Any = None
    http: HttpClient | None = None
    sink: SQLiteSink | None = None
    runner: SourceRunner | None = None

    try:
        target = Path(db_path) if db_path else _default_db_path()
        conn = db.connect(target)
        db_rows = _read_db(conn, query, limit, sources)
        meta["dbHits"] = len(db_rows)
        items = [_row_to_item(row) for row in db_rows]

        descriptors, used_ids = _select_descriptors(sources)
        meta["sourcesUsed"] = used_ids

        need_crawl = fresh and len(items) < limit and used_ids
        if not need_crawl:
            if fresh and not used_ids:
                meta["reason"] = "无可用启用源，仅返回库内结果"
        else:
            remaining = budget_s - (time.monotonic() - started) - TAIL_MARGIN_S
            if remaining < CRAWL_MIN_BUDGET_S:
                meta["degraded"] = True
                meta["reason"] = "预算余量不足，跳过增量爬取，仅返回库内结果"
            else:
                http = _build_http(descriptors)
                source_instances = _build_source_instances(http, descriptors)
                sink = _make_sink(target)
                config = RunnerConfig(
                    workers=min(len(used_ids), 8),
                    max_items=PER_SOURCE_CAP,
                    max_pages=1,
                )
                runner = SourceRunner(source_instances, config)
                try:
                    results = await asyncio.wait_for(
                        runner.run_all(used_ids, sink), timeout=remaining
                    )
                    crawled = sum(
                        result.inserted + result.updated for result in results
                    )
                    fetched = sum(result.fetched for result in results)
                    errors = sum(result.errors for result in results)
                    meta["crawledHits"] = crawled
                    # 仅当所有源都失败（无候选、有错误、零入库）才算降级；
                    # 命中重复被跳过、源返回空列表不算故障。
                    if errors > 0 and fetched == 0 and crawled == 0:
                        meta["degraded"] = True
                        meta["reason"] = "增量爬取全部失败（源异常或被风控），仅返回库内结果"
                except TimeoutError:
                    # 超时即降级：取消的子任务由 runner 内部 gather 回收；
                    # 已入库的部分保留，随后回库读取。
                    partial = runner.active_results.values()
                    meta["crawledHits"] = sum(
                        result.inserted + result.updated for result in partial
                    )
                    meta["degraded"] = True
                    meta["reason"] = (
                        f"增量爬取在 {remaining:.2f}s 预算内未完成，已按库内结果降级返回"
                    )
                except Exception as error:  # noqa: BLE001 - 门面必须兜底
                    partial = runner.active_results.values()
                    meta["crawledHits"] = sum(
                        result.inserted + result.updated for result in partial
                    )
                    meta["degraded"] = True
                    meta["reason"] = f"增量爬取异常，已按库内结果降级返回: {error!r}"

                # 回库读取：新爬条目已经即时 upsert，走统一读路径参与合并。
                fresh_rows = _read_db(conn, query, limit, sources)
                items = [_row_to_item(row) for row in fresh_rows]

    except Exception as error:  # noqa: BLE001 - 门面任何异常都不上抛
        meta["degraded"] = True
        meta["reason"] = f"查询门面异常，已返回空/部分结果: {error!r}"
    finally:
        # 收尾关闭全部走 best-effort，单步 0.1s 超时，不拖垮墙钟契约。
        for closer in (sink, http):
            if closer is None:
                continue
            try:
                await asyncio.wait_for(closer.close(), timeout=0.1)
            except Exception:  # noqa: BLE001, S110 - 关闭失败不影响已返回结果
                pass
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001, S110
                pass

    items = _merge(items, limit)
    meta["elapsedMs"] = int((time.monotonic() - started) * 1000)
    return QueryResult(items=items, meta=meta)


def query_news_sync(
    query: str = "",
    limit: int = 40,
    budget_s: float = 3.0,
    fresh: bool = True,
    sources: list[str] | None = None,
    db_path: str | Path | None = None,
) -> QueryResult:
    """同步包装：供非 async 调用方使用，内部新建事件循环运行 :func:`query_news`。"""
    return asyncio.run(
        query_news(
            query=query,
            limit=limit,
            budget_s=budget_s,
            fresh=fresh,
            sources=sources,
            db_path=db_path,
        )
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m news_crawler.query")
    parser.add_argument("--q", "--query", dest="query", default="", help="关键词（可空）")
    parser.add_argument("--limit", type=int, default=40, help="返回条数上限，默认 40")
    parser.add_argument(
        "--budget", type=float, default=3.0, help="墙钟预算秒数，默认 3.0"
    )
    parser.add_argument(
        "--no-fresh", action="store_true", help="只查库内，不做增量爬取"
    )
    parser.add_argument(
        "--source", action="append", help="限定来源 ID，可重复；默认全部启用源"
    )
    parser.add_argument("--db", default=None, help="SQLite 路径，默认 .data/news.db")
    parser.add_argument(
        "--json", action="store_true", help="输出完整 JSON（否则打印摘要）"
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    result = asyncio.run(
        query_news(
            query=args.query,
            limit=args.limit,
            budget_s=args.budget,
            fresh=not args.no_fresh,
            sources=args.source,
            db_path=args.db,
        )
    )
    if args.json:
        print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
    else:
        meta = result.meta
        print(
            f"items={len(result.items)} elapsedMs={meta['elapsedMs']} "
            f"dbHits={meta['dbHits']} crawledHits={meta['crawledHits']} "
            f"degraded={meta['degraded']} sources={','.join(meta['sourcesUsed']) or '-'}"
        )
        if meta["reason"]:
            print(f"reason: {meta['reason']}")
        for item in result.items[: args.limit]:
            print(f"- [{item['sourceName']}] {item['title']} {item['url']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
