# 营小商 Python 新闻采集服务（长驻版）

这是仓库里的 Python 后端爬虫，和 `packages/news` 的 TypeScript 版并存；Electron 前端继续用 TS/JS，这个服务只负责抓取、规范化和入库。本文档面向服务器运维：安装、命令、控制面接口、统计库结构、日志排障与已知限制。

## 1. 安装

要求 Python 3.12–3.13，依赖只有 `httpx / beautifulsoup4 / lxml`；测试与 lint 工具在 `dev` 额外组。

```powershell
cd services/news-crawler-py
uv sync --dev
# 没有 uv 时：
# & "$env:USERPROFILE\.local\bin\uv.exe" sync --dev
```

浏览器兜底（Playwright）是可选依赖，默认不启用：

```powershell
uv sync --extra browser
uv run playwright install chromium
```

验证安装：

```powershell
uv run news-crawler list-sources
# 或不经过入口脚本：
.\.venv\Scripts\python.exe -m news_crawler list-sources
```

## 2. 架构与并发模型

- **每源独立节拍**：每个已注册源一个独立 `asyncio.Task`，按自己 `descriptor.policy.interval_s` 循环；先跑完的源立刻释放槽位、睡自己的周期，不等慢源。
- **列表批量、详情并发**：列表页一次拿到一批候选地址后，详情页按源并发抓取；默认非 anti-crawler 源至少 4 个详情并发，NBD 等明确会被重置的源保留 1。解析一条立刻 `upsert` 一条，不攒批。
- **普通源不再有每请求固定间隔**：`http.py` 正常请求直接发出，只有 anti-crawler 源（`capabilities.anti_crawler=True`）才启用各自的 `min_interval_ms` 作为 opt-in 保护；失败（403/429/5xx/连接重置）才做指数退避。
- **共享并发槽位**：跨源并发数由信号量限制（默认 8）。槽位只在「跑一轮」期间持有，一轮结束立即释放，再睡自己的 interval；不存在固定分组或 `8×2` 硬编码。
- **单轮硬超时**：单源单轮超过 `--max-run-s`（默认 90s）即取消该源本轮，统计记为 `failure` 并写入失败明细，不影响其它源。
- **逐条入库**：每条抓到就立刻 upsert（不攒批）；URL 唯一，`content_hash` 变化时清掉旧草稿；短稿用摘要兜底，仍不足 40 字才拒绝。
- **统计落库**：每轮结束逐源写一行 `source_runs`，`trigger` 区分 `schedule`（周期）、`manual`（手动 / 控制面 / `crawl`）与 `bench`（压测）。
- **源数量未知**：服务按 runner 里实际加载的源驱动，新增 `sources/*.py` 适配器不需要改调度代码；新模块在进程重启后生效。

## 3. CLI 命令

入口脚本 `news-crawler`（等价于 `python -m news_crawler`）。

| 命令 | 作用 |
| --- | --- |
| `list-sources` | 列出已注册源、分组、适配器、详情并发与刷新周期 |
| `crawl` | 跑一轮指定源并退出；带 `--db` 时逐源写统计（`trigger=manual`） |
| `bench` | 限定秒数内并发压测；带 `--db` 时逐源写统计（`trigger=bench`） |
| `once` | 手动跑一轮并把统计写入数据库（`trigger=manual`） |
| `serve` | 长驻采集服务 + HTTP 控制面（7×24） |
| `schedule` | 按每源 interval 周期运行；内部委托给 `CrawlService` |
| `status` | 从数据库读取每源最近状态表 |

通用抓取参数（`crawl / bench / schedule / once / serve` 共用）：

| 参数 | 说明 |
| --- | --- |
| `--source ID` | 可重复；只跑指定源，默认全部启用源 |
| `--output PATH` | 追加/覆盖写 JSONL（`news-ingest/v1` 一行一条） |
| `--db PATH` | SQLite 路径；`serve / once / status` 默认 `.data/news.db`；`crawl / bench` 不传 `--db` 且无 `--output` 时报错退出 2，传了则文章入库并逐源落统计 |
| `--append` | JSONL 追加；默认覆盖 |
| `--workers N` | 同时运行的源数；默认 8，也可用环境变量 `NEWS_CRAWLER_WORKERS` 覆盖 |
| `--detail-concurrency N` | 覆盖单源详情并发；默认按源 policy，普通源至少 4，anti 源保留自身低值 |
| `--max-items N` | 单源单轮候选上限；`0` 为不限 |
| `--unlimited` | 不限制单源候选数 |
| `--max-pages N` | 单源单轮分页上限 |
| `--browser` | 启用 Playwright 兜底 |
| `--fast` | 兼容保留：仅去掉 anti 源 opt-in 的间隔保护，普通请求本来就不等待；压测可用 |
| `--seconds S` | 仅 `bench`：压测时长 |

`serve` 专属参数：

| 参数 / 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `--host` / `NEWS_CRAWLER_HOST` | `127.0.0.1` | 控制面监听地址；对外暴露时改成内网网卡地址 |
| `--port` / `NEWS_CRAWLER_PORT` | `8787` | 控制面端口 |
| `--max-run-s` | `90` | 单源单轮硬超时（秒） |

### 3.1 启动长驻服务

```powershell
# 默认：DB=.data/news.db，控制面 127.0.0.1:8787，8 并发，单轮 90s 超时
uv run news-crawler serve

# 服务器上调到 16 并发、30s 单轮超时，绑定内网网卡
$env:NEWS_CRAWLER_WORKERS = "16"
uv run news-crawler serve --host 0.0.0.0 --port 8787 --max-run-s 30
```

停止：`Ctrl+C`（SIGINT）。服务会取消所有调度任务、关闭 sink 与 HTTP 客户端、提交并关闭数据库连接，最后一轮统计已在轮次结束时落库。

### 3.2 手动跑一轮

```powershell
# 全部启用源跑一轮并落统计
uv run news-crawler once

# 只跑两个源，小样本
uv run news-crawler once --source yicai --source stcn --max-items 20 --max-pages 1
```

### 3.3 查看每源状态表

```powershell
uv run news-crawler status
uv run news-crawler status --source yicai
```

输出列：最近状态、最近开始时间、耗时（ms）、fetched/inserted/updated/skipped/errors、累计轮数、累计入库、最近一条失败明细。

## 4. HTTP 控制面

仅用 Python 标准库实现（`http.server`），不依赖 aiohttp / FastAPI。所有响应都是 JSON，并带 `elapsed_ms`。默认只监听 `127.0.0.1`。

### 4.1 `GET /health`

进程状态 + 每源最近一次运行、是否在跑、下次触发时间、累计计数。

```powershell
curl http://127.0.0.1:8787/health
```

响应要点：

```json
{
  "ok": true,
  "service": "news-crawler",
  "started": true,
  "started_at": "2026-11-18T08:00:00.000000+00:00",
  "workers": 8,
  "max_run_s": 90.0,
  "source_count": 16,
  "sources": {
    "yicai": {
      "enabled": true,
      "interval_s": 600.0,
      "running": false,
      "next_run_at": "2026-11-18T08:10:00.000000+00:00",
      "last": {
        "status": "success",
        "started_at": "2026-11-18T08:00:00.000000+00:00",
        "finished_at": "2026-11-18T08:00:12.300000+00:00",
        "duration_ms": 12300,
        "fetched": 20,
        "inserted": 18,
        "updated": 1,
        "skipped": 1,
        "errors": 0,
        "failures": []
      },
      "totals": {"runs": 12, "inserted": 210, "updated": 15, "errors": 2, "first_run": "..."}
    }
  },
  "elapsed_ms": 3
}
```

### 4.2 `GET /stats?source=&limit=`

最近运行记录（新的在前）。`source` 可省略；`limit` 1–500，默认 50。

```powershell
curl "http://127.0.0.1:8787/stats?source=yicai&limit=10"
```

### 4.3 `POST /run`

手动触发一轮。请求体可选 JSON：

```json
{ "sources": ["yicai", "stcn"], "wait": true }
```

- `sources`：省略则跑全部启用源；传未注册源返回 400。
- `wait`：默认 `true`，等本轮结束返回每源结果；`false` 后台触发，立即返回。

```powershell
curl -X POST http://127.0.0.1:8787/run -H "Content-Type: application/json" -d "{\"sources\":[\"yicai\"],\"wait\":true}"
```

### 4.4 `GET /query?q=&limit=&fresh=`

检索门面代理入口，惰性导入模块 `news_crawler.query` 的异步 `query_news`；数据库路径用服务自己的 `--db`。门面自带 `budget_s=3.0s` 墙钟预算，库内不足时按剩余预算做增量爬取，超时/异常降级返回库内结果。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `q` | 空 | 关键词；空串返回最新文章 |
| `limit` | 40 | 返回条数上限，1–100 |
| `fresh` | `true` | `false` 只查库内、不做增量爬取 |

```powershell
curl "http://127.0.0.1:8787/query?q=消费&limit=40"
```

响应结构：`items` 为可直接消费的文章字典列表，`meta` 含 `elapsedMs / dbHits / crawledHits / sourcesUsed / degraded / reason`。

```json
{
  "ok": true,
  "q": "消费",
  "limit": 40,
  "fresh": true,
  "items": [{ "id": "...", "source": "yicai", "title": "...", "url": "..." }],
  "meta": {
    "elapsedMs": 1820,
    "dbHits": 12,
    "crawledHits": 8,
    "sourcesUsed": ["yicai", "stcn"],
    "degraded": false,
    "reason": ""
  },
  "elapsed_ms": 1825
}
```

模块缺失时返回 `503` 和明确原因，不会让服务崩溃：

```json
{
  "ok": false,
  "error": "query_unavailable",
  "message": "查询模块 news_crawler.query 未安装",
  "reason": "No module named 'news_crawler.query'",
  "elapsed_ms": 1
}
```

## 5. 数据库与统计表

### 5.1 位置

- 默认路径：`.data/news.db`（相对启动目录；`.data/` 已在 `.gitignore`）。
- 用 `--db` 或 `--db PATH` 覆盖；WAL 模式，`busy_timeout=5000`。
- 表结构与 DAL 全部在 `src/news_crawler/db.py`，sink 与控制面共用同一套 schema。

### 5.2 `source_runs` 字段

| 列 | 含义 |
| --- | --- |
| `id` | 自增主键 |
| `source` | 源 ID |
| `trigger` | `schedule`（周期）/ `manual`（手动、控制面、`crawl`）/ `bench`（压测） |
| `status` | `success / empty / partial_failure / failure` |
| `started_at` / `finished_at` | ISO-8601 UTC 时间 |
| `duration_ms` | 本轮耗时（毫秒） |
| `fetched` | 列表页抓到的候选条数 |
| `inserted` / `updated` / `skipped` | 入库 / 更新 / 内容未变跳过 |
| `errors` | 失败条目数（列表 / 详情 / 规范化 / 入库） |
| `failures` | JSON 数组：`[{stage, message, url}]`，最多保留 50 条 |

### 5.3 常用查询

```sql
-- 每源最近一次运行
SELECT source, status, started_at, duration_ms, fetched, inserted, updated, skipped, errors
FROM source_runs r
JOIN (SELECT source, MAX(id) AS max_id FROM source_runs GROUP BY source) latest
  ON latest.max_id = r.id
ORDER BY source;

-- 某源最近 20 轮
SELECT source, trigger, status, started_at, duration_ms, inserted, errors, failures
FROM source_runs WHERE source = 'yicai' ORDER BY id DESC LIMIT 20;

-- 累计入库
SELECT source, COUNT(*) AS runs, SUM(inserted) AS inserted, SUM(errors) AS errors
FROM source_runs GROUP BY source ORDER BY inserted DESC;
```

文章表 `news_articles` 以 `url` 唯一；`content_hash` 用于判断正文是否变化。

## 6. 日志与排障

- 服务启动时在标准输出打印监听地址、DB 路径、并发数、单轮超时与源数；控制面默认不打访问日志。
- 单条详情失败只记进该源的 `failures`，不中断该源，更不影响其它源。
- 某源连续 `failure`：先 `GET /health` 看 `last.failures`，再 `GET /stats?source=<id>` 看历史；常见原因是命中验证页、列表结构改版、详情超时。
- 单轮被硬超时砍掉：`failures[0].message` 含「超过单轮硬超时」；可调大 `--max-run-s`，或检查该源详情并发与网络。
- 控制面连不上：确认 `--host` 绑定地址（默认只回环）、`--port` 未被占用；防火墙只放行内网。
- 数据库被锁：WAL 下多连接读写通常安全；若出现 `busy`，检查是否有其它进程长期持有写事务。

## 7. 测试与 lint

```powershell
uv run pytest -q
uv run ruff check .
```

`tests/test_service.py` 用一个快源和一个故意卡住的假源验证：慢源不阻塞快源、硬超时生效、统计确实落库、`run_round` 只跑指定源、`state()` 与 `/health` 结构正确。

## 8. 已知限制

- `/query` 走 `news_crawler.query` 门面，单次墙钟预算 3s；库内不足才增量爬取，超时或源异常时 `meta.degraded=true` 并返回库内结果。
- 新增适配器模块需要重启进程才会被加载（`reload()` 只做注册表比对提示）。
- 浏览器兜底默认关闭；`nbd` 这类反爬源在直连受限时需要 `--browser`。
- 付费墙 / 登录墙源未接入；停用源在注册表 `note` 中说明原因。
- 统计口径以 `source_runs` 为准；文章去重、打标由下游流程负责，本服务只保证 URL 入库与 `content_hash` 更新。
- 不在本机跑全源长跑压测：源集合仍在增加，全量联调留到最后统一进行。
