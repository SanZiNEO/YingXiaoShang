"""Service-level tests with a fast fake source and a deliberately stuck one.

These prove the scheduler's core promises:

* a slow / stuck source never blocks a fast one;
* the per-round hard timeout cancels only that source's round;
* every finished round lands a statistics row in the database;
* ``run_round`` honours the requested source subset;
* ``state()`` and the HTTP control plane expose the expected shape.
"""

from __future__ import annotations

import asyncio
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

from news_crawler import db
from news_crawler.http_api import HttpControlPlane
from news_crawler.models import (
    RawArticle,
    RawListItem,
    RawPage,
    RunStatus,
    SourceCapabilities,
    SourceDescriptor,
    SourcePolicy,
    SourceRunResult,
)
from news_crawler.runner import RunnerConfig, SourceRunner
from news_crawler.service import CrawlService
from news_crawler.sources.base import NewsSource


def make_descriptor(source_id: str, interval_s: float = 60.0) -> SourceDescriptor:
    return SourceDescriptor(
        id=source_id,
        name=source_id,
        group="test",
        homepage="https://example.com",
        adapter="fake",
        entry="https://example.com",
        pagination="none",
        capabilities=SourceCapabilities(),
        policy=SourcePolicy(
            interval_s=interval_s,
            detail_concurrency=1,
            min_interval_ms=0,
            timeout_s=10.0,
            retries=0,
        ),
    )


class FakeSource(NewsSource):
    def __init__(self, descriptor: SourceDescriptor, *, delay: float = 0.01, items: int = 1):
        super().__init__(None, descriptor)
        self.delay = delay
        self.items = items

    async def list_page(self, cursor: str | None) -> RawPage:
        return RawPage(
            items=[
                RawListItem(
                    source_id=f"{self.descriptor.id}-{i}",
                    url=f"https://example.com/{self.descriptor.id}/{i}",
                    title=f"标题 {i}",
                )
                for i in range(self.items)
            ],
            next_cursor=None,
        )

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        await asyncio.sleep(self.delay)
        return RawArticle(
            source_id=item.source_id,
            url=item.url,
            title=item.title,
            content="正文内容足够长用来通过规范化门槛，" * 5,
            summary="",
        )


class RecordingSink:
    reports_dedup = False

    def __init__(self) -> None:
        self.emitted: list[object] = []

    async def emit(self, article: object) -> str:
        self.emitted.append(article)
        return "inserted"

    async def close(self) -> None:
        return None


def make_service(
    tmp_path: Path,
    sources: dict[str, NewsSource],
    *,
    workers: int = 2,
    max_run_s: float = 0.3,
) -> tuple[CrawlService, RecordingSink]:
    runner = SourceRunner(sources, RunnerConfig())
    sink = RecordingSink()
    service = CrawlService(
        runner,
        sink=sink,
        db_path=tmp_path / "news.db",
        workers=workers,
        max_run_s=max_run_s,
    )
    return service, sink


async def test_slow_source_does_not_block_fast_one(tmp_path: Path) -> None:
    fast = FakeSource(make_descriptor("fast"), delay=0.02, items=2)
    stuck = FakeSource(make_descriptor("stuck"), delay=5.0, items=1)
    service, _sink = make_service(tmp_path, {"fast": fast, "stuck": stuck})
    await service.start(schedule=False)
    try:
        started = time.perf_counter()
        results = await service.run_round(["fast", "stuck"], trigger="manual")
        elapsed = time.perf_counter() - started
    finally:
        await service.stop()

    by_source = {result.source: result for result in results}
    assert by_source["fast"].status.value == "success"
    assert by_source["fast"].inserted == 2
    assert by_source["stuck"].status.value == "failure"
    # The stuck source is cut off by the timeout; we must not wait its full 5s.
    assert elapsed < 2.0, f"慢源拖住了整轮，耗时 {elapsed:.2f}s"


async def test_timeout_round_is_recorded_as_failure(tmp_path: Path) -> None:
    stuck = FakeSource(make_descriptor("stuck"), delay=5.0, items=1)
    service, _sink = make_service(tmp_path, {"stuck": stuck}, max_run_s=0.3)
    await service.start(schedule=False)
    try:
        await service.run_round(["stuck"], trigger="manual")
        rows = db.recent_runs(service.db, source="stuck", limit=5)
    finally:
        await service.stop()

    assert len(rows) == 1
    row = rows[0]
    assert row["status"] == "failure"
    assert row["errors"] >= 1
    failures = json.loads(row["failures"])
    assert failures, "超时明细必须写进 failures 列"
    assert "超时" in failures[0]["message"]


async def test_each_round_is_persisted_with_counts(tmp_path: Path) -> None:
    fast = FakeSource(make_descriptor("fast"), delay=0.01, items=3)
    service, sink = make_service(tmp_path, {"fast": fast})
    await service.start(schedule=False)
    try:
        await service.run_round(["fast"], trigger="manual")
        rows = db.recent_runs(service.db, limit=10)
    finally:
        await service.stop()

    assert len(rows) == 1
    row = rows[0]
    assert row["trigger"] == "manual"
    assert row["fetched"] == 3
    assert row["inserted"] == 3
    assert len(sink.emitted) == 3


async def test_run_round_only_runs_requested_sources(tmp_path: Path) -> None:
    fast = FakeSource(make_descriptor("fast"), delay=0.01, items=1)
    other = FakeSource(make_descriptor("other"), delay=0.01, items=1)
    service, _sink = make_service(tmp_path, {"fast": fast, "other": other})
    await service.start(schedule=False)
    try:
        await service.run_round(["fast"], trigger="manual")
        rows = db.recent_runs(service.db, limit=10)
    finally:
        await service.stop()

    assert [row["source"] for row in rows] == ["fast"]


async def test_state_and_health_endpoint_shape(tmp_path: Path) -> None:
    fast = FakeSource(make_descriptor("fast"), delay=0.01, items=2)
    service, _sink = make_service(tmp_path, {"fast": fast})
    await service.start(schedule=False)
    await service.run_round(["fast"], trigger="manual")

    state = service.state()
    assert state["workers"] == 2
    assert state["max_run_s"] == 0.3
    entry = state["sources"]["fast"]
    assert entry["running"] is False
    assert entry["last"] is not None
    assert entry["last"]["status"] == "success"
    assert entry["last"]["inserted"] == 2
    assert set(entry["totals"]) >= {"runs", "inserted", "updated", "errors"}
    assert entry["totals"]["runs"] == 1
    assert entry["totals"]["inserted"] == 2

    plane = HttpControlPlane(service, host="127.0.0.1", port=0)
    plane.start()
    try:
        port = plane._server.server_address[1]  # type: ignore[union-attr]
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5) as resp:  # noqa: ASYNC210
            health = json.load(resp)
        assert health["ok"] is True
        assert health["source_count"] == 1
        assert "elapsed_ms" in health
        assert health["sources"]["fast"]["last"]["inserted"] == 2

        with urllib.request.urlopen(f"http://127.0.0.1:{port}/stats?source=fast", timeout=5) as resp:  # noqa: ASYNC210
            stats = json.load(resp)
        assert stats["ok"] is True
        assert len(stats["runs"]) == 1

        query = urllib.parse.quote("测试")
        with urllib.request.urlopen(  # noqa: ASYNC210
            f"http://127.0.0.1:{port}/query?q={query}&fresh=false", timeout=5
        ) as resp:
            queried = json.load(resp)
        assert queried["ok"] is True
        assert isinstance(queried["items"], list)
        assert set(queried["meta"]) >= {
            "elapsedMs", "dbHits", "crawledHits", "degraded", "reason",
        }
    finally:
        plane.close()
        await service.stop()


def test_record_runs_persists_triggered_rows(tmp_path: Path) -> None:
    from news_crawler.cli import _record_runs

    conn = db.connect(tmp_path / "cli-stats.db")
    results = [
        SourceRunResult(source="fast", status=RunStatus.SUCCESS, fetched=3, inserted=3),
        SourceRunResult(source="slow", status=RunStatus.FAILURE, fetched=1, errors=1),
    ]
    _record_runs(conn, results, "bench")
    # A missing connection is a silent no-op (crawl/bench without --db).
    _record_runs(None, results, "manual")

    rows = db.recent_runs(conn, limit=10)
    by_source = {row["source"]: row for row in rows}
    assert by_source["fast"]["trigger"] == "bench"
    assert by_source["fast"]["inserted"] == 3
    assert by_source["slow"]["status"] == "failure"
    assert by_source["slow"]["errors"] == 1
    conn.close()
