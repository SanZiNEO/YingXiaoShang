"""检索门面 query_news 的单元测试：假源 + 临时 DB，不触网。

覆盖：DB 命中、URL 去重、limit 截断、慢源超时降级、异常不抛出、budget 契约、
fresh=False 不爬取、增量入库后回库合并。
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from news_crawler import db as db_mod
from news_crawler import query as query_mod
from news_crawler.models import (
    RawArticle,
    RawListItem,
    RawPage,
    SourceCapabilities,
    SourceDescriptor,
    SourcePolicy,
)
from news_crawler.sources.base import NewsSource

SOURCE_ID = "fake"
BODY = "正" * 60


def _descriptor(source_id: str = SOURCE_ID, name: str = "假源") -> SourceDescriptor:
    return SourceDescriptor(
        id=source_id,
        name=name,
        group="test",
        homepage="https://example.com/",
        adapter="fake",
        entry="https://example.com/",
        pagination="none",
        capabilities=SourceCapabilities(),
        policy=SourcePolicy(
            interval_s=60,
            detail_concurrency=2,
            min_interval_ms=0,
            timeout_s=5.0,
            retries=0,
            max_items=12,
            max_pages=1,
        ),
        enabled=True,
        language="zh",
    )


class FakeSource(NewsSource):
    """可控假源：可配置延迟、列表/详情抛错。"""

    def __init__(
        self,
        descriptor: SourceDescriptor,
        items: list[RawListItem],
        *,
        sleep: float = 0.0,
        fail_list: bool = False,
        fail_detail: bool = False,
    ) -> None:
        self.descriptor = descriptor
        self._items = items
        self._sleep = sleep
        self._fail_list = fail_list
        self._fail_detail = fail_detail
        self.list_calls = 0

    async def list_page(self, cursor: str | None) -> RawPage:
        self.list_calls += 1
        if self._fail_list:
            raise RuntimeError("list boom")
        await asyncio.sleep(self._sleep)
        return RawPage(items=list(self._items))

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        if self._fail_detail:
            raise RuntimeError("detail boom")
        await asyncio.sleep(self._sleep)
        return RawArticle(
            source_id=item.source_id,
            url=item.url,
            title=item.title,
            content=BODY,
            published_at="2026-11-18T10:00:00Z",
        )


def _fake_items(n: int, prefix: str = "item") -> list[RawListItem]:
    return [
        RawListItem(
            source_id=f"{prefix}-{i}",
            url=f"https://example.com/{prefix}/{i}",
            title=f"{prefix} 标题 {i}",
        )
        for i in range(n)
    ]


def _seed_row(
    conn: db_mod.sqlite3.Connection,
    *,
    row_id: str,
    source: str,
    title: str,
    url: str,
    published_at: str,
    content: str = BODY,
    summary: str = "摘要",
) -> None:
    conn.execute(
        """
        INSERT INTO news_articles (
          id, source, source_id, title, url, author, published_at, summary,
          content, content_status, rights, fetched_at, content_hash
        ) VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, 'full', 'internal', ?, '')
        """,
        (row_id, source, row_id, title, url, published_at, summary, content, published_at),
    )
    conn.commit()


@pytest.fixture()
def tmp_db(tmp_path: Path) -> Path:
    return tmp_path / "test.db"


def _open(db_path: Path) -> db_mod.sqlite3.Connection:
    return db_mod.connect(db_path)


def _install_fakes(
    monkeypatch: pytest.MonkeyPatch,
    source: FakeSource,
    descriptor: SourceDescriptor,
) -> None:
    monkeypatch.setattr(
        query_mod, "_select_descriptors", lambda sources=None: ({descriptor.id: descriptor}, [descriptor.id])
    )
    monkeypatch.setattr(query_mod, "_build_http", lambda descriptors: object())
    monkeypatch.setattr(
        query_mod, "_build_source_instances", lambda http, descriptors: {descriptor.id: source}
    )


async def test_db_hit_without_crawl(monkeypatch: pytest.MonkeyPatch, tmp_db: Path) -> None:
    conn = _open(tmp_db)
    for i in range(5):
        _seed_row(
            conn,
            row_id=f"row-{i}",
            source=SOURCE_ID,
            title=f"库内标题 {i}",
            url=f"https://example.com/db/{i}",
            published_at=f"2026-11-18T09:0{i}:00Z",
        )
    conn.close()

    # 无可用源：门面不应发起爬取。
    monkeypatch.setattr(query_mod, "_select_descriptors", lambda sources=None: ({}, []))

    result = await query_mod.query_news(limit=10, db_path=tmp_db)
    assert len(result.items) == 5
    assert result.meta["dbHits"] == 5
    assert result.meta["crawledHits"] == 0
    assert result.meta["degraded"] is False


async def test_limit_truncation(monkeypatch: pytest.MonkeyPatch, tmp_db: Path) -> None:
    conn = _open(tmp_db)
    for i in range(25):
        _seed_row(
            conn,
            row_id=f"row-{i}",
            source=SOURCE_ID,
            title=f"标题 {i}",
            url=f"https://example.com/db/{i}",
            published_at=f"2026-11-18T0{i % 10}:00:00Z",
        )
    conn.close()
    monkeypatch.setattr(query_mod, "_select_descriptors", lambda sources=None: ({}, []))

    result = await query_mod.query_news(limit=10, db_path=tmp_db)
    assert len(result.items) == 10


async def test_dedup_by_canonical_url(tmp_db: Path) -> None:
    conn = _open(tmp_db)
    _seed_row(
        conn,
        row_id="row-a",
        source=SOURCE_ID,
        title="原始标题",
        url="https://example.com/article/1?utm_source=x",
        published_at="2026-11-18T09:00:00Z",
    )
    _seed_row(
        conn,
        row_id="row-b",
        source=SOURCE_ID,
        title="重复标题",
        url="https://example.com/article/1?utm_campaign=y",
        published_at="2026-11-18T09:05:00Z",
    )
    conn.close()

    result = await query_mod.query_news(limit=10, fresh=False, db_path=tmp_db)
    assert len(result.items) == 1
    assert result.items[0]["url"] == "https://example.com/article/1"


async def test_crawled_items_ingested_and_merged(
    monkeypatch: pytest.MonkeyPatch, tmp_db: Path
) -> None:
    descriptor = _descriptor()
    source = FakeSource(descriptor, _fake_items(3))
    _install_fakes(monkeypatch, source, descriptor)

    result = await query_mod.query_news(limit=10, budget_s=3.0, db_path=tmp_db)

    assert source.list_calls == 1
    assert result.meta["crawledHits"] == 3
    assert result.meta["degraded"] is False
    assert len(result.items) == 3
    urls = {item["url"] for item in result.items}
    assert urls == {f"https://example.com/item/{i}" for i in range(3)}

    # 增量入库可复核：重新打开库应能读到 3 条。
    conn = _open(tmp_db)
    count = conn.execute("SELECT COUNT(*) FROM news_articles").fetchone()[0]
    conn.close()
    assert count == 3


async def test_slow_source_degrades_without_raising(
    monkeypatch: pytest.MonkeyPatch, tmp_db: Path
) -> None:
    descriptor = _descriptor()
    source = FakeSource(descriptor, _fake_items(2), sleep=5.0)
    _install_fakes(monkeypatch, source, descriptor)

    result = await query_mod.query_news(limit=10, budget_s=0.5, db_path=tmp_db)

    assert result.meta["degraded"] is True
    assert "预算" in result.meta["reason"] or "超时" in result.meta["reason"]
    # 墙钟必须落在预算 + 收尾容差内。
    assert result.meta["elapsedMs"] < 1_200


async def test_failing_source_does_not_raise(
    monkeypatch: pytest.MonkeyPatch, tmp_db: Path
) -> None:
    descriptor = _descriptor()
    source = FakeSource(descriptor, _fake_items(2), fail_list=True)
    _install_fakes(monkeypatch, source, descriptor)

    result = await query_mod.query_news(limit=10, budget_s=2.0, db_path=tmp_db)

    # 异常被门面兜底：返回结果而不是抛出。
    assert result.meta["degraded"] is True
    assert result.items == []


async def test_fresh_false_skips_crawl(
    monkeypatch: pytest.MonkeyPatch, tmp_db: Path
) -> None:
    conn = _open(tmp_db)
    _seed_row(
        conn,
        row_id="row-1",
        source=SOURCE_ID,
        title="库内标题",
        url="https://example.com/db/1",
        published_at="2026-11-18T09:00:00Z",
    )
    conn.close()

    descriptor = _descriptor()
    source = FakeSource(descriptor, _fake_items(3))
    _install_fakes(monkeypatch, source, descriptor)

    result = await query_mod.query_news(limit=10, fresh=False, db_path=tmp_db)
    assert source.list_calls == 0
    assert result.meta["crawledHits"] == 0
    assert len(result.items) == 1


async def test_budget_contract_under_load(
    monkeypatch: pytest.MonkeyPatch, tmp_db: Path
) -> None:
    descriptor = _descriptor()
    source = FakeSource(descriptor, _fake_items(5), sleep=10.0)
    _install_fakes(monkeypatch, source, descriptor)

    result = await query_mod.query_news(limit=10, budget_s=1.0, db_path=tmp_db)
    assert result.meta["elapsedMs"] < 1_500
    assert result.meta["degraded"] is True


async def test_keyword_filter_hits_subset(tmp_db: Path) -> None:
    conn = _open(tmp_db)
    _seed_row(
        conn,
        row_id="row-finance",
        source=SOURCE_ID,
        title="财经快讯 今日行情",
        url="https://example.com/fin/1",
        published_at="2026-11-18T09:00:00Z",
    )
    _seed_row(
        conn,
        row_id="row-life",
        source=SOURCE_ID,
        title="生活方式 消费观察",
        url="https://example.com/life/1",
        published_at="2026-11-18T08:00:00Z",
    )
    conn.close()

    result = await query_mod.query_news(query="财经", fresh=False, db_path=tmp_db)
    assert result.meta["dbHits"] == 1
    assert result.items[0]["title"].startswith("财经")


def test_sync_wrapper_returns_result(tmp_db: Path) -> None:
    result = query_mod.query_news_sync(limit=10, fresh=False, db_path=tmp_db)
    assert result.items == []
    assert result.meta["degraded"] is False
