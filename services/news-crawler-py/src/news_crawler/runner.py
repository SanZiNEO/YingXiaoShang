"""Async source runner and scheduler."""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

from .models import FailureStage, RunStatus, SourceFailure, SourceRunResult
from .normalize import normalize
from .output import Sink
from .sources.base import NewsSource


@dataclass(slots=True)
class RunnerConfig:
    workers: int = 8
    detail_concurrency: int | None = None
    max_items: int | None = None
    max_pages: int | None = None
    unlimited_items: bool = False


class SourceRunner:
    def __init__(self, sources: dict[str, NewsSource], config: RunnerConfig) -> None:
        self.sources = sources
        self.config = config
        self.active_results: dict[str, SourceRunResult] = {}

    async def run_source(
        self,
        source_id: str,
        sink: Sink,
        result: SourceRunResult | None = None,
    ) -> SourceRunResult:
        source = self.sources[source_id]
        result = result or SourceRunResult(source=source_id)
        self.active_results[source_id] = result
        started = time.monotonic()
        detail_concurrency = self.config.detail_concurrency or source.descriptor.policy.detail_concurrency
        semaphore = asyncio.Semaphore(max(1, detail_concurrency))
        tasks: set[asyncio.Task] = set()
        try:

            async def process(item) -> None:
                async with semaphore:
                    try:
                        raw = await source.fetch_detail(item)
                    except asyncio.CancelledError:
                        raise
                    except Exception as error:  # noqa: BLE001
                        self._fail(result, FailureStage.DETAIL, str(error), item.url)
                        return
                    article, reason = normalize(source.descriptor, raw)
                    if article is None:
                        self._fail(result, FailureStage.NORMALIZE, reason, item.url)
                        return
                    try:
                        status = await sink.emit(article)
                    except asyncio.CancelledError:
                        raise
                    except Exception as error:  # noqa: BLE001
                        self._fail(result, FailureStage.DB, str(error), item.url)
                        return
                    if status == "inserted":
                        result.inserted += 1
                    elif status == "updated":
                        result.updated += 1
                    else:
                        result.skipped += 1

            async def collect() -> None:
                max_items, max_pages = self._limits(source)
                cursor: str | None = None
                seen: set[str] = set()
                for _page_index in range(max_pages):
                    try:
                        page = await source.list_page(cursor)
                    except asyncio.CancelledError:
                        raise
                    except Exception as error:  # noqa: BLE001
                        self._fail(result, FailureStage.LIST, str(error))
                        return
                    if page is None:
                        return
                    for item in page.items:
                        if item.url in seen:
                            continue
                        seen.add(item.url)
                        result.fetched += 1
                        task = asyncio.create_task(process(item))
                        tasks.add(task)
                        task.add_done_callback(tasks.discard)
                        if max_items is not None and result.fetched >= max_items:
                            return
                    if not page.next_cursor or page.next_cursor == cursor:
                        return
                    cursor = page.next_cursor

            list_task = asyncio.create_task(collect())
            try:
                await list_task
                if tasks:
                    await asyncio.gather(*tasks)
            except asyncio.CancelledError:
                list_task.cancel()
                for task in tasks:
                    task.cancel()
                await asyncio.gather(list_task, *tasks, return_exceptions=True)
                raise
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001
            self._fail(result, FailureStage.LIST, str(error))
        finally:
            result.duration_ms = int((time.monotonic() - started) * 1000)
            if result.status != RunStatus.EMPTY:
                stored = result.inserted + result.updated + result.skipped
                if result.errors and stored == 0:
                    result.status = RunStatus.FAILURE
                elif result.errors:
                    result.status = RunStatus.PARTIAL_FAILURE
                elif result.fetched:
                    result.status = RunStatus.SUCCESS
                else:
                    result.status = RunStatus.EMPTY
        return result

    def _limits(self, source: NewsSource) -> tuple[int | None, int]:
        policy = source.descriptor.policy
        if self.config.unlimited_items:
            max_items = None
        else:
            max_items = self.config.max_items if self.config.max_items is not None else policy.max_items
        max_pages = self.config.max_pages if self.config.max_pages is not None else policy.max_pages
        return max_items, max_pages or 1

    @staticmethod
    def _fail(result: SourceRunResult, stage: FailureStage, message: str, url: str = "") -> None:
        result.errors += 1
        if len(result.failures) < 50:
            result.failures.append(
                SourceFailure(stage=stage, message=message[:500], url=url[:300])
            )

    async def run_all(self, source_ids: list[str], sink: Sink) -> list[SourceRunResult]:
        semaphore = asyncio.Semaphore(max(1, self.config.workers))

        async def one(source_id: str) -> SourceRunResult:
            async with semaphore:
                return await self.run_source(source_id, sink)

        return list(await asyncio.gather(*(one(source_id) for source_id in source_ids)))

    async def benchmark(self, source_ids: list[str], seconds: float, sink: Sink) -> list[SourceRunResult]:
        """Run every source independently for `seconds`, without waiting for stragglers."""
        semaphore = asyncio.Semaphore(max(1, self.config.workers))

        async def one(source_id: str) -> SourceRunResult:
            async with semaphore:
                result = SourceRunResult(source=source_id)
                self.active_results[source_id] = result
                return await self.run_source(source_id, sink, result)

        tasks = {asyncio.create_task(one(source_id)): source_id for source_id in source_ids}
        done, pending = await asyncio.wait(tasks, timeout=seconds)
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        for task in done:
            if not task.cancelled():
                task.exception()
        results = []
        for source_id in source_ids:
            result = self.active_results.get(source_id)
            if result is None:
                result = SourceRunResult(source=source_id, status=RunStatus.FAILURE)
                result.failures.append(SourceFailure(FailureStage.LIST, "benchmark task missing"))
            elif result.errors and (result.inserted + result.updated + result.skipped) == 0:
                result.status = RunStatus.FAILURE
            elif result.errors:
                result.status = RunStatus.PARTIAL_FAILURE
            elif result.fetched:
                result.status = RunStatus.SUCCESS
            else:
                result.status = RunStatus.EMPTY
            results.append(result)
        return results


class SourceScheduler:
    def __init__(self, runner: SourceRunner, source_ids: list[str]) -> None:
        self.runner = runner
        self.source_ids = source_ids
        self._stop = asyncio.Event()
        self._tasks: list[asyncio.Task] = []

    async def start(self, sink: Sink) -> None:
        semaphore = asyncio.Semaphore(max(1, self.runner.config.workers))

        async def loop(source_id: str) -> None:
            source = self.runner.sources[source_id]
            while not self._stop.is_set():
                async with semaphore:
                    if self._stop.is_set():
                        return
                    await self.runner.run_source(source_id, sink)
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=source.descriptor.policy.interval_s)
                except TimeoutError:
                    continue

        self._tasks = [asyncio.create_task(loop(source_id)) for source_id in self.source_ids]
        await asyncio.gather(*self._tasks)

    async def stop(self) -> None:
        self._stop.set()
        for task in self._tasks:
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
