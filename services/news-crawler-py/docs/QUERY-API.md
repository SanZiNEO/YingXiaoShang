# QUERY-API — AI 检索门面接口契约

面向后端 / AI 调用方的 `news_crawler.query` 门面：一次调用在预算时间内返回约
`limit` 条可直接消费的新闻条目，数据来自「库内已有 + 事实增量爬取」的组合。

- 模块：`news_crawler.query`
- 异步入口：`query_news(...)`
- 同步包装：`query_news_sync(...)`
- 命令行：`python -m news_crawler.query --q "..." --limit 40 --budget 3`

> 控制面惰性 import 本模块；模块路径、函数名与参数签名如下表所示，请勿改名。

## 1. 函数签名

```python
from pathlib import Path
from news_crawler.query import query_news, query_news_sync, QueryResult

async def query_news(
    query: str = "",
    limit: int = 40,
    budget_s: float = 3.0,
    fresh: bool = True,
    sources: list[str] | None = None,
    db_path: str | Path | None = None,
) -> QueryResult: ...

def query_news_sync(
    query: str = "",
    limit: int = 40,
    budget_s: float = 3.0,
    fresh: bool = True,
    sources: list[str] | None = None,
    db_path: str | Path | None = None,
) -> QueryResult: ...
```

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `query` | `str` | `""` | 关键词；空串表示取最新入库条目。按标题 / 摘要 / 正文 LIKE 匹配。 |
| `limit` | `int` | `40` | 返回条数上限；结果按发布时间倒序截断到该值。 |
| `budget_s` | `float` | `3.0` | 单次调用墙钟预算（秒）。门面保证不超过该预算（含收尾余量）。 |
| `fresh` | `bool` | `True` | `True`：库内不足时按剩余预算做事实增量爬取；`False`：只查库内，不发起网络请求。 |
| `sources` | `list[str] \| None` | `None` | 限定来源 ID 名单；`None` 取注册表全部启用源。未知 ID 静默忽略。 |
| `db_path` | `str \| Path \| None` | `None` | SQLite 路径；默认服务根目录 `.data/news.db`。 |

## 2. 返回结构

`QueryResult` 有两个字段：`items`（条目字典列表）与 `meta`（调用元信息）。

### 2.1 `items[]` 字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `str` | 条目内部 ID（`<source>-<externalId>`）。 |
| `source` | `str` | 来源 ID（注册表 `SourceDescriptor.id`）。 |
| `sourceName` | `str` | 来源展示名（注册表 `SourceDescriptor.name`）。 |
| `title` | `str` | 标题。 |
| `url` | `str` | 规范化后的文章 URL（canonical，去除跟踪参数）。 |
| `publishedAt` | `str` | 发布时间（ISO 字符串；可能为空串，空日期在排序时排末尾）。 |
| `summary` | `str` | 摘要。 |
| `content` | `str` | 正文（短稿以摘要兜底）。 |
| `contentMode` | `"full" \| "summary"` | 正文模式；按正文长度反推：≥300 字为 `full`，否则 `summary`。 |
| `contentStatus` | `str` | 正文完整度（`full` / `partial`，沿用入库口径）。 |
| `language` | `str` | 语言代码，默认 `zh`。 |

### 2.2 `meta` 字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `elapsedMs` | `int` | 本次门面调用墙钟耗时（毫秒）。 |
| `dbHits` | `int` | 库内首次命中条数。 |
| `crawledHits` | `int` | 本次增量爬取新入库 / 更新条数（重复命中被跳过不计）。 |
| `sourcesUsed` | `list[str]` | 本次实际参与爬取的来源 ID 列表。 |
| `degraded` | `bool` | 是否降级：超时、爬取异常或全部源失败时为 `true`。 |
| `reason` | `str` | 降级 / 备注原因；未降级时为空串。 |

## 3. 处理流程

1. **秒开库内查询**：打开 SQLite，按 `query` / `sources` 过滤，按发布时间倒序取前
   `limit` 条；记录 `dbHits`。
2. **增量爬取（仅当 `fresh=True` 且库内不足 `limit`）**：按剩余预算选源（默认全部启用
   源），走已有 `SourceRunner` 与注册表；列表首屏 + 详情并发，尊重每源
   `SourcePolicy`（请求间隔、详情并发、超时、重试、候选上限）。
3. **即时入库**：抓到的每条经规范化后由 `SQLiteSink` 即时 upsert（URL 唯一索引 +
   `content_hash` 增量；正文变化时清草稿），不攒批。
4. **合并返回**：回库读取新入库条目，与库内结果合并；按 canonical URL 去重，按
   `publishedAt` 倒序（空日期排末尾），截断到 `limit`。

## 4. 预算与降级语义

- **墙钟契约**：单次调用 ≤ `budget_s`。门面在预算内预留收尾余量（关闭连接、字段映射、
  序列化）；爬取阶段用 `asyncio.wait_for` 按剩余预算硬截止，超时即取消在途任务。
- **降级触发**（`degraded=True`）：
  1. 增量爬取在预算内未完成（超时取消）；
  2. 爬取过程抛出未预期异常；
  3. 全部源失败（无候选、有错误、零入库，站点异常 / 被风控）。
  其余情况不视为故障：源返回空列表、条目重复被跳过、库内已足够，均不标记降级。
- **不抛异常**：门面内部兜底所有异常，始终返回 `QueryResult`；降级时 `items` 为库内
  已有结果（可能为空），`reason` 写明原因。调用方应检查 `meta.degraded` 并在
  `reason` 非空时记录日志。
- **`fresh=False`**：不发起任何网络请求，只返回库内结果；此时 `crawledHits=0`。

## 5. 调用示例

### 5.1 异步

```python
from news_crawler.query import query_news

result = await query_news(query="品牌", limit=40, budget_s=3.0)
for item in result.items:
    print(item["sourceName"], item["title"], item["url"])

if result.meta["degraded"]:
    logger.warning("query degraded: %s", result.meta["reason"])
```

### 5.2 同步

```python
from news_crawler.query import query_news_sync

result = query_news_sync(query="财经", limit=40, budget_s=3.0)
```

### 5.3 命令行

```powershell
# 最新 40 条，3 秒预算
python -m news_crawler.query --limit 40 --budget 3

# 关键词检索，限定来源，输出完整 JSON
python -m news_crawler.query --q "品牌" --source socialbeta --source brandstar --json
```

## 6. 口径与约束

- **去重键**：canonical URL（scheme/host/path + 白名单查询参数，去除 `utm_*` 等
  跟踪参数）；同 URL 只保留首条。
- **排序**：`publishedAt` 倒序；时间为空的条目排末尾。
- **来源动态选择**：门面不写死源数量；`sources` 未指定时读取注册表当前全部启用源，
  注册表后续扩源自动生效。
- **默认库**：`<服务根目录>/.data/news.db`；库不存在时自动建表。
- **入库边界**：条目以 `news-ingest/v1` 口径入库；URL 必须保留，供去重与回溯。

## 7. 当前缺口（2026-11-18 实测）

- 源数量随注册表动态增长，门面不写死源数；3 秒预算内只能完成有限的详情抓取，单次平均
  条数低于 40，冷词检索主要依赖库内已有内容。
- 增量爬取一轮（多源首屏 + 详情）在 3 秒预算内无法全部完成；到点后门面取消在途任务、
  按库内结果降级返回（`degraded=true`，`reason` 记录切片超时）。站点慢、风控、付费墙
  等由该降级路径兜底，不会超时失败；降级时条目数相应减少。
- 待全部源接入、库内积累足够条目后，按 `scripts/bench_query.py` 复测本契约。
  最近一次实测报告：`.data/bench_query_report.json`。
