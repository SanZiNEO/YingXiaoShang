"""Long-running crawl service.

Design goals:

* Every registered source owns an independent ``asyncio.Task`` that loops on its
  own ``descriptor.policy.interval_s``; a slow source can never push a fast one
  off its own cadence.
* A shared :class:`asyncio.Semaphore` caps how many source rounds run at the
  same time. The slot is held only while that single round is running; the
  source releases it immediately afterwards and then sleeps its own interval.
* Every round has a hard wall-clock timeout (``max_run_s``). A timed-out round
  is cancelled, recorded as a failure in the statistics, and never blocks the
  other sources.
* Each finished round is persisted to ``source_runs`` via :mod:`news_crawler.db`.

The service does not know how many sources exist: it operates on whatever the
runner's source map contains, so adapters can be added or removed without
touching this file.
"""

from __future__ import annotations

import asyncio
import os
import sqlite3
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from . import db
from .models import FailureStage, RunStatus, SourceFailure, SourceRunResult
from .output import Sink
from .runner import SourceRunner

DEFAULT_WORKERS = 8
DEFAULT_MAX_RUN_S = 90.0
ENV_WORKERS = "NEWS_CRAWLER_WORKERS"


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


@dataclass(slots=True)
class _SourceRuntime:
    """In-memory per-source view consumed by :meth:`CrawlService.state`."""

    running: bool = False
    last: dict[str, Any] | None = None
    next_run_at: str | None = None
    scheduled_task: asyncio.Task[None] | None = None


class CrawlService:
    """Owns the runner, sink, HTTP client and statistics connection.

    Args:
        runner: Built :class:`~news_crawler.runner.SourceRunner`; its source map
            defines the sources this service drives.
        http: Optional shared :class:`~news_crawler.http.HttpClient`, closed on
            :meth:`stop`.
        sink: Optional ingest sink (JSONL / SQLite / composite).
        db_path: Statistics database path. When omitted, runs are not persisted.
        workers: Maximum number of source rounds allowed to run concurrently.
            Falls back to the ``NEWS_CRAWLER_WORKERS`` environment variable, then
            to :data:`DEFAULT_WORKERS`.
        max_run_s: Hard timeout for a single source round.
        source_ids: Restrict the driven sources; defaults to every source the
            runner knows about.
        trigger: Trigger label stamped on schedule-driven rounds.
    """

    def __init__(
        self,
        runner: SourceRunner,
        *,
        http: Any = None,
        sink: Sink | None = None,
        db_path: str | Path | None = None,
        workers: int | None = None,
        max_run_s: float = DEFAULT_MAX_RUN_S,
        source_ids: list[str] | None = None,
        trigger: str = "schedule",
    ) -> None:
        self.runner = runner
        self.http = http
        self.sink = sink
        self.db_path = Path(db_path) if db_path else None
        self.workers = workers or int(os.environ.get(ENV_WORKERS, str(DEFAULT_WORKERS)))
        self.max_run_s = float(max_run_s)
        self.source_ids = list(source_ids) if source_ids else list(runner.sources)
        self.trigger = trigger

        self._semaphore = asyncio.Semaphore(max(1, self.workers))
        self._stop = asyncio.Event()
        self._runtimes: dict[str, _SourceRuntime] = {
            source_id: _SourceRuntime() for source_id in self.source_ids
        }
        self._tasks: list[asyncio.Task[None]] = []
        self._conn: sqlite3.Connection | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._closing = False
        self.started_at: str | None = None

    # ------------------------------------------------------------------ lifecycle

    async def start(self, *, schedule: bool = True) -> None:
        """Open the statistics connection and (optionally) spawn per-source loops."""
        self._loop = asyncio.get_running_loop()
        if self.db_path is not None:
            self._conn = db.connect(self.db_path)
        self._stop.clear()
        self.started_at = _now_iso()
        if schedule:
            for source_id in self.source_ids:
                runtime = self._runtimes[source_id]
                runtime.scheduled_task = asyncio.create_task(
                    self._schedule_loop(source_id), name=f"crawl-{source_id}"
                )
                self._tasks.append(runtime.scheduled_task)

    async def wait_stopped(self) -> None:
        """Block until :meth:`stop` (or shutdown) has been requested."""
        await self._stop.wait()

    async def stop(self) -> None:
        """Graceful shutdown: cancel loops, finish in-flight rounds, close sink/http/db."""
        self._closing = True
        self._stop.set()
        for task in self._tasks:
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks = []
        for runtime in self._runtimes.values():
            runtime.scheduled_task = None
            runtime.running = False
        try:
            if self.sink is not None:
                await self.sink.close()
            if self.http is not None:
                await self.http.close()
        finally:
            if self._conn is not None:
                self._conn.commit()
                self._conn.close()
                self._conn = None
            self._loop = None

    @property
    def db(self) -> sqlite3.Connection | None:
        return self._conn

    @property
    def loop(self) -> asyncio.AbstractEventLoop | None:
        return self._loop

    # ------------------------------------------------------------------ scheduling

    async def _schedule_loop(self, source_id: str) -> None:
        interval = self.runner.sources[source_id].descriptor.policy.interval_s
        next_mono = time.monotonic()  # first round fires immediately on start
        while not self._stop.is_set():
            delay = next_mono - time.monotonic()
            if delay > 0:
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=delay)
                except TimeoutError:
                    pass
            if self._stop.is_set():
                return
            await self._run_one(source_id, trigger=self.trigger)
            next_mono = time.monotonic() + max(0.0, interval)
            self._runtimes[source_id].next_run_at = (
                datetime.now(UTC) + timedelta(seconds=max(0.0, interval))
            ).isoformat()

    # ------------------------------------------------------------------ rounds

    def _validate(self, source_ids: list[str] | None) -> list[str]:
        if source_ids is None:
            return list(self.source_ids)
        unknown = [source_id for source_id in source_ids if source_id not in self.runner.sources]
        if unknown:
            raise KeyError(f"未注册的新闻源: {', '.join(unknown)}")
        return list(source_ids)

    async def run_round(
        self,
        source_ids: list[str] | None = None,
        *,
        trigger: str = "manual",
        wait: bool = True,
    ) -> list[SourceRunResult]:
        """Run one round for the given sources concurrently.

        Each round independently acquires the shared concurrency slot, honours
        the per-round timeout and persists its own statistics.

        Args:
            source_ids: Sources to run; ``None`` runs every driven source.
            trigger: ``schedule`` or ``manual``, stamped on the statistics row.
            wait: When ``False`` rounds are fired in the background and the
            coroutine returns immediately with the spawned tasks.
        """
        targets = self._validate(source_ids)
        tasks = [
            asyncio.create_task(self._run_one(source_id, trigger=trigger),
                                name=f"round-{source_id}")
            for source_id in targets
        ]
        if not wait:
            return tasks  # type: ignore[return-value]
        return list(await asyncio.gather(*tasks))

    async def _run_one(self, source_id: str, *, trigger: str) -> SourceRunResult:
        runtime = self._runtimes.setdefault(source_id, _SourceRuntime())
        runtime.running = True
        started = time.monotonic()
        result: SourceRunResult
        try:
            async with self._semaphore:
                try:
                    result = await asyncio.wait_for(
                        self.runner.run_source(source_id, self.sink),
                        timeout=self.max_run_s,
                    )
                except TimeoutError:
                    result = self._timeout_result(source_id, time.monotonic() - started)
                except Exception as error:  # noqa: BLE001 - keep one source local
                    result = self._failure_result(source_id, time.monotonic() - started, error)
        except asyncio.CancelledError:
            result = self._failure_result(
                source_id, time.monotonic() - started, RuntimeError("服务退出，本轮被取消")
            )
            # Shutdown cancellation is not a source malfunction: keep it in the
            # in-memory view but do not write a failure statistics row for it.
            if not self._closing:
                self._persist(result, trigger)
            self._update_runtime(runtime, result)
            raise
        finally:
            runtime.running = False
        self._persist(result, trigger)
        self._update_runtime(runtime, result)
        return result

    def _timeout_result(self, source_id: str, elapsed: float) -> SourceRunResult:
        result = SourceRunResult(source=source_id, status=RunStatus.FAILURE)
        result.duration_ms = int(elapsed * 1000)
        result.errors += 1
        result.failures.append(
            SourceFailure(
                stage=FailureStage.LIST,
                message=f"超过单轮硬超时 {self.max_run_s:.0f}s，本轮已取消",
            )
        )
        return result

    @staticmethod
    def _failure_result(source_id: str, elapsed: float, error: Exception) -> SourceRunResult:
        result = SourceRunResult(source=source_id, status=RunStatus.FAILURE)
        result.duration_ms = int(elapsed * 1000)
        result.errors += 1
        result.failures.append(
            SourceFailure(stage=FailureStage.LIST, message=str(error)[:500])
        )
        return result

    # ------------------------------------------------------------------ persistence / state

    def _persist(self, result: SourceRunResult, trigger: str) -> None:
        if self._conn is None:
            return
        try:
            db.record_run(self._conn, db.run_from_result(result, trigger))
        except Exception as error:  # noqa: BLE001 - stats must not kill the loop
            result.errors += 1
            if len(result.failures) < 50:
                result.failures.append(
                    SourceFailure(stage=FailureStage.DB, message=f"统计落库失败: {error}"[:500])
                )

    @staticmethod
    def _result_summary(result: SourceRunResult) -> dict[str, Any]:
        return {
            "source": result.source,
            "status": result.status.value,
            "started_at": result.started_at.isoformat(),
            "finished_at": _now_iso(),
            "duration_ms": result.duration_ms,
            "fetched": result.fetched,
            "inserted": result.inserted,
            "updated": result.updated,
            "skipped": result.skipped,
            "errors": result.errors,
            "failures": [
                {"stage": failure.stage.value, "message": failure.message, "url": failure.url}
                for failure in result.failures
            ],
        }

    def _update_runtime(self, runtime: _SourceRuntime, result: SourceRunResult) -> None:
        runtime.last = self._result_summary(result)

    def state(self) -> dict[str, Any]:
        """Per-source in-memory view, merged with lifetime totals from the DB."""
        health_by_source: dict[str, dict[str, Any]] = {}
        if self._conn is not None:
            health_by_source = {row["source"]: row for row in db.source_health(self._conn)}

        sources: dict[str, Any] = {}
        for source_id, runtime in self._runtimes.items():
            descriptor = self.runner.sources[source_id].descriptor
            entry: dict[str, Any] = {
                "enabled": descriptor.enabled,
                "interval_s": descriptor.policy.interval_s,
                "running": runtime.running,
                "next_run_at": runtime.next_run_at,
                "last": runtime.last,
                "totals": {"runs": 0, "inserted": 0, "updated": 0, "errors": 0,
                           "first_run": None},
            }
            health = health_by_source.get(source_id)
            if health is not None:
                entry["totals"] = health["totals"]
                if runtime.last is None:
                    entry["last"] = {
                        "status": health["status"],
                        "started_at": health["started_at"],
                        "finished_at": health["finished_at"],
                        "duration_ms": health["duration_ms"],
                        "fetched": health["fetched"],
                        "inserted": health["inserted"],
                        "updated": health["updated"],
                        "skipped": health["skipped"],
                        "errors": health["errors"],
                        "failures": health["failures"],
                    }
            sources[source_id] = entry

        return {
            "service": "news-crawler",
            "started": self.started_at is not None,
            "started_at": self.started_at,
            "workers": self.workers,
            "max_run_s": self.max_run_s,
            "source_count": len(sources),
            "db_path": str(self.db_path) if self.db_path is not None else None,
            "sources": sources,
        }

    def reload(self) -> dict[str, list[str]]:
        """Best-effort refresh of the source set.

        Adapters are instantiated when the runner/service is built, so genuinely
        new modules only take effect after a restart. This method reports the
        registry's current view so callers can compare it with the loaded one.
        """
        from .registry import SOURCES

        loaded = set(self.runner.sources)
        registered = set(SOURCES)
        return {
            "loaded": sorted(loaded),
            "registered": sorted(registered),
            "new_unloaded": sorted(registered - loaded),
            "missing_adapter": sorted(loaded - registered),
        }
