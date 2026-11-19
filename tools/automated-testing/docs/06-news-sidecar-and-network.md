# 06 · Python 采集 Sidecar 与网络面

> 归属：桌面主进程外接的 Python 采集服务（`services/news-crawler-py` + `apps/desktop/src/main/news-backend.ts` + `packages/news`）｜ 状态：已完成 ｜ 核对日期：2026-11-18
> 覆盖：sidecar 拉起位置与参数、解释器/venv 解析顺序、`NEWS_CRAWLER_*` 环境变量、端口 8788 占用与复用、健康检查、`AUTOSTART=0` 行为、崩溃重建、HTTP 路由契约、pytest 覆盖点、离线降级、网络依赖面、跨进程共用 SQLite 风险与观测点。
> 不覆盖：采集适配器逐站解析规则（见 `07-domain-services-and-determinism.md`）；新闻匹配/思政标注算法（见 `07`）；SQLite 表结构与种子库（见 `08-data-fixtures-and-isolation.md`）；LLM 提供商与密钥（见 `07` 与 `02-main-runtime-and-boot.md`）。
> 行号截至 2026-11-18，以当前工作区源码为准。

## 1. 结论摘要（TL;DR）

1. 桌面主进程在 `initServices()` 阶段通过 `startNewsBackend()` 拉起 Python sidecar；入口为 `python -m news_crawler serve`（或 venv 内 `news-crawler` 控制台脚本），长驻 `127.0.0.1:8788` `[源码]`。
2. 解释器解析顺序：`NEWS_CRAWLER_PYTHON` 显式解释器 → 根目录 `.venv`（或 `NEWS_CRAWLER_VENV`）控制台脚本 → venv `python.exe -m news_crawler`；三者都没有则只告警、不拉起 `[源码]`。
3. 桌面注入 `NEWS_CRAWLER_DB / NEWS_CRAWLER_WORKERS / NEWS_CRAWLER_PORT` 等环境变量，但 Python 侧实际只认命令行 `--db/--host/--port/--workers` 与自身读取的 `NEWS_CRAWLER_HOST/PORT/WORKERS`；`NEWS_CRAWLER_DB` 未被 Python 读取 `[源码]`。
4. 端口复用策略：先 `GET /health` 探活，健康则直接复用旧进程（即使 `db_path` 不一致也只告警不替换）；不健康或不可达才 spawn 新进程；**没有**端口占用检测与旧进程清理逻辑 `[源码]`。
5. 健康检查：桌面单次探测超时 1500ms；启动轮询每 150ms 一次、总超时 8000ms；后端 `GET /health` 永远 200（进程活着即 `ok:true`），不代表采集链路健康 `[源码]`。
6. `NEWS_CRAWLER_AUTOSTART=0`（或显式设置 `NEWS_CRAWLER_URL`）时桌面跳过 spawn，只把 URL 交给 `NewsService`；后续 refresh/query 仍会发起 HTTP 请求，不可达即失败 `[源码]`。
7. sidecar 子进程退出后**不自动重建**：exit 回调仅记录日志并置空 `child`；下一次采集请求才暴露失败，直到应用重启 `[源码]`。
8. 桌面与 sidecar 共用同一个 SQLite 文件 `<appHome>/data/learning.db`，双方均 WAL + `busy_timeout=5000`；Python 侧未开 `foreign_keys`，跨进程写竞争与锁等待是主要观测点 `[源码]`。

## 2. 结构与流程

### 2.1 进程拓扑

```text
Electron 主进程 (Node, better-sqlite3)
  │  LearningDb ── 打开 <appHome>/data/learning.db (WAL)
  │  NewsService (packages/news) ── HTTP fetch ──┐
  │  startNewsBackend() spawn(...)               │
  ▼                                              ▼
Python sidecar 进程 (news_crawler serve, :8788)
  ├─ CrawlService：每源独立 asyncio.Task，信号量限流，单轮硬超时 90s
  ├─ HttpClient (httpx)：46 个启用适配器对外站抓取
  └─ SQLiteSink ── 写同一个 learning.db (WAL)
```

### 2.2 启动时序 `[源码]`

```text
initServices()
  ├─ 打开 LearningDb（种子库复制到 appHome/data/learning.db）
  ├─ startNewsBackend({ appPath, appHome })        news-backend.ts:92
  │    ├─ 已有 NEWS_CRAWLER_URL 或 AUTOSTART=0 → 直接返回 URL，不 spawn
  │    ├─ health(url) 探活 → 健康则复用（db_path 不一致仅 warn）
  │    ├─ findServiceDir() 定位服务目录
  │    ├─ findExecutable() 定位解释器/脚本
  │    ├─ spawn(command, [serve, --db, --host, --port, --workers, --max-run-s 90])
  │    └─ waitHealthy(url, 8000) → 就绪日志 / 超时告警
  └─ new NewsService(ctx, { baseUrl: newsBaseUrl })
app.whenReady() 之后：createWindow() → startNewsAutomation()
  ├─ 定时巡检：每 LEARNING_AGENT_NEWS_REFRESH_MINUTES（默认 30）分钟 ensureFresh()
  └─ 启动 60s 后首次 ensureFresh()
```

### 2.3 关键边界

- sidecar 是桌面的**可选依赖**：拉起失败不阻塞应用启动，只写 `[news]` 告警 `[源码]`（`news-backend.ts:113,118,166`）。
- 桌面定时巡检与 sidecar 自身周期调度是两套定时器；桌面只在库空/过期时追加一轮 `wait:false` 请求 `[源码]`（`index.ts:103-126`）。

## 3. 关键代码位置

| 职责 | 文件:行 | 说明 |
|---|---|---|
| 拉起入口 | `apps/desktop/src/main/news-backend.ts:92-168` | `startNewsBackend(options)` |
| URL 解析 | `news-backend.ts:9-12` | `desktopNewsCrawlerUrl()`，默认 `http://127.0.0.1:8788` |
| 健康探测 | `news-backend.ts:19-29` | `health()`，`AbortSignal.timeout(1_500)` |
| 就绪等待 | `news-backend.ts:31-38` | `waitHealthy()`，150ms 轮询，8000ms 总超时 |
| 服务目录候选 | `news-backend.ts:40-48` | `findServiceDir()`，按序找含 `pyproject.toml` 的目录 |
| 解释器解析 | `news-backend.ts:50-82` | `findExecutable()`，三档回退 |
| spawn 参数 | `news-backend.ts:121-148` | `serve --db --host --port --workers --max-run-s 90` |
| 退出回调 | `news-backend.ts:157-160` | 仅日志 + `child=undefined`，无重建 |
| 停止 | `news-backend.ts:170-174` | `stopNewsBackend()`，`app.before-quit` 调用（`main/index.ts:550`） |
| 桌面巡检 | `apps/desktop/src/main/index.ts:103-127` | `startNewsAutomation()`，30 分钟间隔 + 60s 首跑 |
| 桌面 HTTP 客户端 | `packages/news/src/index.ts:343-380` | `request()`，超时与错误翻译 |
| CLI 入口 | `services/news-crawler-py/src/news_crawler/cli.py:351-366` | `main()` → `asyncio.run(async_main())` |
| serve 命令 | `cli.py:189-206` | 构造 `CrawlService` + `HttpControlPlane` |
| 服务内核 | `services/news-crawler-py/src/news_crawler/service.py:56-353` | 调度、限流、超时、`state()` |
| HTTP 路由 | `services/news-crawler-py/src/news_crawler/http_api.py:123-156` | `do_GET / do_POST` 分发 |
| 查询门面 | `services/news-crawler-py/src/news_crawler/query.py:149-281` | 3s 预算、降级契约 |
| 通用抓取 | `services/news-crawler-py/src/news_crawler/http.py:150-259` | `HttpClient`、策略、重试退避 |
| 单篇导入 | `services/news-crawler-py/src/news_crawler/adhoc.py:103-125` | `ingest_url()` |
| 共用库连接 | `services/news-crawler-py/src/news_crawler/db.py:65-75` | `connect()` pragmas |
| Node 侧库连接 | `packages/db/src/index.ts:831-834` | `DatabaseSync` pragmas |
| 入口脚本声明 | `services/news-crawler-py/pyproject.toml:16-17` | `news-crawler = news_crawler.cli:main` |

## 4. 可测点

### 4.1 sidecar 拉起与解释器解析（EXT-01 .. EXT-03）

#### EXT-01 拉起位置与命令行参数 `[源码]`

- 拉起调用点：`apps/desktop/src/main/index.ts:86`，`initServices()` 内、领域服务构造之前。
- spawn 位置：`news-backend.ts:136-148`，`cwd = serviceDir`，`stdio: ['ignore','pipe','pipe']`，`windowsHide: true`。
- 实际参数数组（`news-backend.ts:122-135`）：

```text
[<executable.args 前置>, 'serve', '--db', <dbPath>, '--host', '127.0.0.1',
 '--port', <port>, '--workers', <workers>, '--max-run-s', '90']
```

- `dbPath = resolve(appHome, 'data', 'learning.db')`（`news-backend.ts:100`）；`port` 取自 URL，缺省 `8788`；`workers` 缺省 `8`；`max-run-s` 固定 `90`。
- 子进程 stdout/stderr 分别以 `[news]` 前缀转发到主进程日志（`news-backend.ts:149-156`）。

#### EXT-02 解释器与 venv 解析顺序 `[源码]`

`findExecutable(serviceDir)`（`news-backend.ts:50-82`）按以下顺序，命中即返回：

| 顺序 | 条件 | command | args | 环境 |
|---|---|---|---|---|
| 1 | `NEWS_CRAWLER_PYTHON` 非空 | 该变量值 | `['-m', 'news_crawler']` | `PYTHONPATH=<serviceDir>/src` |
| 2 | venv 控制台脚本存在：`NEWS_CRAWLER_VENV \| \| <repoRoot>/.venv` 下 `Scripts/news-crawler.exe`（win）/ `bin/news-crawler`（其他） | 脚本路径 | `[]` | 继承，不另设 `PYTHONPATH` |
| 3 | venv 解释器存在：`Scripts/python.exe`（win）/ `bin/python`（其他） | 解释器路径 | `['-m', 'news_crawler']` | `PYTHONPATH=<serviceDir>/src` |
| 4 | 三者均无 | 返回 `undefined` → 主进程告警 `[news] no Python executable found in the repo-root .venv`，不拉起 | — | — |

服务目录候选顺序（`findServiceDir`，`news-backend.ts:41-47`）：`NEWS_CRAWLER_DIR` → `<appPath>/services/news-crawler-py` → `<appPath>/../../services/news-crawler-py` → `<cwd>/services/news-crawler-py`；以目录下存在 `pyproject.toml` 为准。

- Python 版本要求：`>=3.12,<3.14`（`pyproject.toml:5`）；运行时依赖 `httpx>=0.28.1`、`beautifulsoup4>=4.12.0`、`lxml>=5.3.0`；Playwright 为可选 `browser` extra（`pyproject.toml:13`）。
- 可测点：伪造三档候选目录/可执行文件，断言选中的 command/args/env；缺解释器时断言主进程仍启动且告警出现。

#### EXT-03 环境变量全量清单 `[源码]`

**桌面主进程读取（注入给子进程或影响拉起）**：

| 变量 | 读取位置 | 默认值 | 作用 |
|---|---|---|---|
| `NEWS_CRAWLER_URL` | `news-backend.ts:11,97`；`packages/news/src/index.ts:146` | `http://127.0.0.1:8788`（桌面）/ `:8787`（包内兜底） | 显式后端地址；设置后跳过本地 spawn |
| `NEWS_CRAWLER_AUTOSTART` | `news-backend.ts:97` | 未设即自动拉起 | 等于 `'0'` 时跳过 spawn |
| `NEWS_CRAWLER_PORT` | `news-backend.ts:10,121,143` | `8788` | 后端端口（桌面侧） |
| `NEWS_CRAWLER_DIR` | `news-backend.ts:42` | 无 | 服务目录显式指定 |
| `NEWS_CRAWLER_PYTHON` | `news-backend.ts:51` | 无 | 显式解释器路径 |
| `NEWS_CRAWLER_VENV` | `news-backend.ts:63` | `<repoRoot>/.venv` | venv 目录覆盖 |
| `NEWS_CRAWLER_WORKERS` | `news-backend.ts:132,142`；`service.py:91` | `8` | 采集并发上限 |
| `NEWS_CRAWLER_DB` | `news-backend.ts:141` | 无（仅注入子进程环境） | **Python 侧未读取**，库路径由 `--db` 命令行传入（见 R-5） |
| `LEARNING_AGENT_NEWS_REFRESH_MINUTES` | `main/index.ts:104` | `30`（分钟，下限 1） | 桌面定时巡检周期 |

**Python 侧读取**：

| 变量 | 读取位置 | 默认值 | 作用 |
|---|---|---|---|
| `NEWS_CRAWLER_HOST` | `cli.py:310` | `127.0.0.1` | 控制面监听地址 |
| `NEWS_CRAWLER_PORT` | `cli.py:314` | `8787` | 控制面端口（桌面 spawn 以 `--port 8788` 覆盖） |
| `NEWS_CRAWLER_WORKERS` | `service.py:39,91`；`cli.py:267` 帮助文本 | `8` | 并发信号量上限 |

- 未被 Python 读取的变量：`NEWS_CRAWLER_DB`、`NEWS_CRAWLER_URL`、`NEWS_CRAWLER_DIR`、`NEWS_CRAWLER_PYTHON`、`NEWS_CRAWLER_VENV`、`NEWS_CRAWLER_AUTOSTART`（grep `os.environ/getenv` 仅命中上表三项）`[源码]`。
- 可测点：分别设置 `NEWS_CRAWLER_AUTOSTART=0`、`NEWS_CRAWLER_URL`、`NEWS_CRAWLER_PORT`，断言 spawn 是否发生与实际监听端口。

### 4.2 端口、健康检查与重建策略（EXT-04 .. EXT-07）

#### EXT-04 端口占用 / 复用逻辑 `[源码]`

- 默认端口 `8788`（`news-backend.ts:5`）；Python CLI 自身默认 `8787`（`cli.py:314`、`http_api.py:39`），桌面 spawn 显式传 `8788`，避免与手工启动的 8787 实例共用库（`news-backend.ts:8` 注释）。
- 复用判断（`news-backend.ts:101-109`）：先 `health(url)`；返回 `ok:true` 即复用。若响应 `db_path` 与本桌面 `dbPath` 不一致，仅 `console.warn` 提示端口被另一库占用，**仍复用**该 URL，不杀旧进程、不换端口。
- 不可达或不健康：进入 spawn 流程；代码中**没有**检测 8788 是否被其他进程占用的步骤。若端口已被非本服务进程占用，Python `ThreadingHTTPServer` 绑定阶段报错，`waitHealthy` 8s 超时后告警返回 URL（见 R-1）。

**端口冲突观测与清理三步**（验收口径）：

1. **观测占用**：`netstat -ano | findstr :8788` 找 `LISTENING` 行的 PID；浏览器/curl `http://127.0.0.1:8788/health` 看是否返回 JSON。
2. **确认旧进程**：`tasklist /FI "PID eq <PID>"` 核对映像名；再对比 `/health` 响应的 `db_path` 字段（`http_api.py:351`）是否等于当前 `<appHome>/data/learning.db`；命令行应含 `news_crawler serve`。`db_path` 不一致即串到了另一实例。
3. **安全清理**：正常退出由应用 `before-quit` → `stopNewsBackend()` 统一 kill（`index.ts:550`）；手动清理先确认 PID 确属本应用拉起的 news-crawler（映像 `python.exe` / `news-crawler.exe`，命令行含服务目录与 8788），再 `taskkill /PID <PID>`；不要直接删除 `learning.db-wal` / `learning.db-shm` 文件。

#### EXT-05 健康检查路径与超时 `[源码]`

- 路径：`GET /health`（`http_api.py:127-128,174-183`）。
- 桌面探测：单次 `fetch` 超时 1500ms（`news-backend.ts:21-23`）；`waitHealthy` 每 150ms 重试，总超时 8000ms（`news-backend.ts:31-38,162`）。
- 响应载荷：`{ ok: true, host, port, service: "news-crawler", started, started_at, workers, max_run_s, source_count, db_path, sources: {<sourceId>: {enabled, interval_s, running, next_run_at, last, totals}}, elapsed_ms }`（`service.py:308-353`）。
- 注意：`/health` 只反映进程与内存调度状态，**不**探测外网可达性，也不保证最近一轮采集成功；采集失败看 `/stats` 或 `sources.<id>.last`。
- 可测点：进程存活但采集全失败时 `/health` 仍 `ok:true`；桌面 8s 内未就绪时主流程继续启动（告警不阻断）。

#### EXT-06 `NEWS_CRAWLER_AUTOSTART=0` 行为 `[源码]`

- 条件：`process.env.NEWS_CRAWLER_URL` 非空 **或** `NEWS_CRAWLER_AUTOSTART === '0'` 时，`startNewsBackend` 直接返回 URL，不探活、不 spawn（`news-backend.ts:97-99`）。
- 后果：`NewsService` 仍持有该 URL；`refresh / ensureFresh / searchAndIngest / crawlAndIngest` 照常发 HTTP 请求。后端不可达时这些调用 reject（`packages/news/src/index.ts:371-375`），桌面定时巡检在 `tick` 内 catch 并告警（`index.ts:110-112`）。
- 典型部署：服务器指向独立采集服务并置 `AUTOSTART=0`；桌面测试隔离时也可用该变量禁止本地拉起。
- 可测点：置 `AUTOSTART=0` 后进程列表无 news-crawler；`news.refresh` IPC 按预期 reject；本地 DB 读取类方法不受影响。

#### EXT-07 子进程崩溃 / 退出后的重建策略 `[源码]`

- 退出回调（`news-backend.ts:157-160`）：非零退出码写 `console.warn`，随后 `child = undefined`；**不重启、不重试 spawn**。
- 此后 `startNewsBackend` 不会被再次调用；下一次 `ensureFresh` / `refresh` / `web_search` / `crawl_url` 对死端口发 fetch 失败，错误冒泡到对应调用方。
- 进程内容错：单个源任务异常/超时只记入该源 `SourceRunResult`，不杀死服务进程；每源独立 `asyncio.Task` 与信号量（`service.py:162-248`）。
- 服务内 `reload()`（`service.py:355-371`）只对比已加载与注册表源集合，**不热加载新适配器**；新模块需重启 sidecar。
- 可测点：kill 子进程后观察主进程不退出；后续 `news.refresh` reject；应用重启后子进程重新拉起。

### 4.3 入口模块与路由契约（EXT-08）

#### EXT-08 入口模块与 HTTP 端点 `[源码]`

- 入口：`python -m news_crawler` → `__main__.py` → `cli:main`；控制台脚本 `news-crawler = news_crawler.cli:main`（`pyproject.toml:16-17`）。serve 子命令装配 `CrawlService` 与 `HttpControlPlane`（`cli.py:189-206`）。
- 服务端基于标准库 `http.server.ThreadingHTTPServer`，后台 daemon 线程；请求经 `run_coroutine_threadsafe` 桥到服务事件循环，协程超时 180s（`http_api.py:40,63-69,80-85`）。

| 方法 | 路径 | 请求体 / 查询参数 | 成功响应 | 错误语义 |
|---|---|---|---|---|
| GET | `/health` | 无 | 200，见 EXT-05 载荷 | 进程未起时桌面 fetch 超时/拒绝，不返回 JSON |
| GET | `/stats` | `source?: string`；`limit` 默认 50，夹紧 1–500 | 200 `{ ok, source, limit, runs[], elapsed_ms }`；`runs[].failures` 已 JSON 解析 | 非整数 limit → 400 `bad_request`；无 DB 连接 → 503 `no_database` |
| POST | `/run` | `{ sources?: string[], wait?: boolean }`，`wait` 默认 `true` | 200 `{ ok, wait, rounds[], accepted[], elapsed_ms }`；`rounds` 为 `_result_summary` 列表；`wait:false` 时 `rounds=[]` | 非法 JSON → 400 `bad_request`；未知源 → 400 `unknown_source`；其他异常 → 500 `internal`（带 `trace` 截断 3 帧） |
| POST | `/ingest` | `{ url: string }` | 200 `{ ok, url, article:{ id, source, sourceName, title, url, publishedAt, summary, content, contentStatus, author }, elapsed_ms }` | url 空 → 400；无 DB → 503 `no_database`；`AdhocError` → 422 `ingest_failed`；其他异常 → 502 `ingest_failed` |
| GET | `/query` | `q` 默认 `''`；`limit` 默认 40，夹紧 1–100；`fresh` 默认 `true`（`0/false/no/off` 为假） | 200 `{ ok, q, limit, fresh, items[], meta:{ elapsedMs, dbHits, crawledHits, sourcesUsed, degraded, reason }, elapsed_ms }` | `query` 模块缺失 → 503 `query_unavailable`；非整数 limit → 400；门面内部兜底不抛异常（`query.py:240-242`） |
| 任意 | 其他路径 | — | 404 `{ error: "not_found", path, elapsed_ms }` | — |

- 字段口径：`items[]` 元素含 `id, source, sourceName, title, url(canonical), publishedAt, summary, content, contentMode(full/summary), contentStatus, language`（`query.py:99-114`）。
- `/run` 的 `accepted` 为实际接受的源 ID 列表（未传 `sources` 时为全部驱动源，`http_api.py:244`）。
- 可测点：各端点状态码与载荷字段；未知源 400；`fresh=false` 不触发增量爬取；`meta.degraded=true` 时 `reason` 非空。

#### EXT-09 pytest 用例覆盖点 `[源码]`

测试目录 `services/news-crawler-py/tests/`，`asyncio_mode=auto`（`pyproject.toml:26-29`）。

| 测试文件 | 覆盖点（用例） |
|---|---|
| `test_query.py` | 库内命中不爬取（`test_db_hit_without_crawl`）；limit 截断（`test_limit_truncation`）；canonical URL 去重（`test_dedup_by_canonical_url`）；新爬条目入库并合并（`test_crawled_items_ingested_and_merged`）；慢源降级不抛（`test_slow_source_degrades_without_raising`）；失败源不抛（`test_failing_source_does_not_raise`）；`fresh=false` 跳过爬取（`test_fresh_false_skips_crawl`）；负载下预算契约（`test_budget_contract_under_load`）；关键词过滤子集（`test_keyword_filter_hits_subset`）；同步包装返回结果（`test_sync_wrapper_returns_result`）。假源 + 临时 DB，不触网 |
| `test_service.py` | 慢源不阻塞快源；超时轮次记为 failure；每轮持久化计数；`run_round` 只跑指定源；`state/health` 端点形状；`record_runs` 持久化触发记录 |
| `test_registry.py` | 基线源仍注册；每源有 entry 与 group；nbd 顺序抓取；policy 取值合法；仅 anti-crawler 源保留请求间隔；禁用源自带说明；sourceId 与模块名一致；启用源必有 adapter |
| `test_html.py` | `clean_text` 折叠空白；`html_to_text` 去 script 留段落；`canonical_url` 保留业务查询参数；日期归一化 |
| `test_normalize.py` | 全文入库；短正文回退 summary；空正文拒绝 |
| `test_adhoc.py` | 通用正文抽取；`ingest_url` 写入共享库 |

- 缺口提示：未见针对 HTTP 路由状态码（400/422/502/503/404）的端到端测试，也未见桌面侧 spawn/复用/重建策略的自动化用例；属 09 文档待补 gap。

### 4.4 离线降级面（EXT-10）

#### EXT-10 sidecar 不可达时的退化清单 `[源码]`

| 调用面 | 方法 / 工具 | 是否依赖 sidecar | 不可达行为 |
|---|---|---|---|
| IPC `IPC-08` `news.list` | `NewsService.list()` → `learningDb.listNews` | 否，纯本地 DB | 正常返回库内条目 |
| IPC `IPC-09` `news.status` | `countNews / newestNewsFetchedAt` | 否，纯本地 DB | 正常返回库内计数 |
| IPC `IPC-11` `news.get` | `NewsService.get()` → 本地 DB | 否，纯本地 DB | 正常返回文章与本地匹配 |
| IPC `IPC-12` `news.match` | `matcher.match` → 本地 DB + 可选 LLM | 否（不经 sidecar） | 离线仍可跑确定性召回；LLM 关闭/不可用走 fallback |
| IPC `IPC-10` `news.refresh` | `NewsService.refresh('/run')` | 是 | fetch 失败 reject；错误文案含超时/HTTP 状态；`backfill(20)` 在其后执行 |
| Agent 工具 `list_news` | `news.list` | 否 | 本地库内列出 |
| Agent 工具 `get_news` | `news.get` | 否 | 本地读取 |
| Agent 工具 `web_search` | `searchAndIngest('/query')` | 是 | 5s 超时后 reject；门面侧降级仅在后端进程活着但源全挂时返回 `meta.degraded` |
| Agent 工具 `crawl_url` | `crawlAndIngest('/ingest')` | 是 | 60s 超时或后端错误 reject |
| Agent 工具 `refresh_news` | `refresh('/run')` | 是 | 失败进入工具错误/告警 |
| 桌面定时巡检 | `ensureFresh()` | 是 | 异常被 catch，仅 `[news] refresh request failed` 告警，不影响 UI（`index.ts:110-112`） |

- 离线时 UI 可观测：新闻列表/详情仍展示库内旧数据；手动刷新与对话内新闻检索失败；`meta.degraded` 原因经 `SearchIngestResult.errors` 带到工具结果（`packages/news/src/index.ts:320`）。
- 可测点：停掉 sidecar 后逐一断言上表：本地类方法正常、网络类方法 reject；恢复后端后 `web_search` 可返回增量条目。

### 4.5 网络依赖面（EXT-11）

#### EXT-11 站点、超时、重试、UA 与代理 `[源码]`

**源规模**：`sources/` 下 50 个适配器模块（`__init__.py`/`base.py` 被发现逻辑跳过），4 个禁用（`adquan`、`iwangshang`、`kr36`、`linkshop`），46 个启用；注册表自动发现，模块名与 sourceId 以下划线/连字符对应（`sources/__init__.py:28-61`）。

**已确认的访问域名**（取自各适配器 `homepage/BASE/ENTRY/LIST_PAGE/REFERER`）：

| 分组 | 域名 |
|---|---|
| 财经资讯 | `finance.sina.com.cn`、`money.163.com`、`finance.ifeng.com`、`news.qq.com`(referer)、`www.cls.cn`、`www.jiemian.com`、`www.nbd.com.cn`、`www.stcn.com`、`www.yicai.com`、`www.eeo.com.cn`、`www.21jingji.com`、`www.eastmoney.com`、`www.cbndata.com`、`www.ebrun.com`、`www.tmtpost.com`、`wallstreetcn.com`、`www.thepaper.cn`、`www.news.cn`、`www.chinanews.com.cn`、`www.chinadaily.com.cn`、`www.cenr.com.cn`、`www.cifnews.com`、`www.jwview.com` |
| 营销/品牌/广告 | `www.digitaling.com`、`socialbeta.com`、`www.meihua.info`、`www.newrank.cn`、`www.brandcn.com`、`www.brandstar.com.cn`、`www.chinatopbrands.net`、`www.admen.cn`、`www.foodinc.com.cn`、`www.tidesight.com`、`www.iresearch.com.cn`、`www.questmobile.com.cn`、`www.latepost.com`、`www.tianxiawangshang.com`/`media.tianxiawangshang.com`(iwangshang, 禁用)、`www.linkshop.com`(禁用)、`36kr.com`(kr36, 禁用)、`www.adquan.com`(禁用) |
| 咨询/调研机构 | `www.accenture.com`、`www.bain.cn`、`www.mckinsey.com.cn`、`www.ipsos.com`、`www.kantar.com`、`nielseniq.com`、`www.cca.org.cn`、`cn.ceibs.edu/`、`www.iresearch.com.cn` |
| 政府/统计 | `www.mofcom.gov.cn`、`www.stats.gov.cn` |
| 单篇导入 | 任意 `http(s)://` URL（`/ingest`，`adhoc.py:105-106`），不做站内扩散 |

补充：部分源不打主站、直连 API 子域，已核实的有 `api.21jingji.com`、`newsapi.eastmoney.com`、`api-next.cbndata.com`、`api-one-wscn.awtmt.com`（wscn）、`feed.mix.sina.com.cn`、`i.news.qq.com`、`app.eeo.com.cn`、`www.163.com`；表中列其所属主域。`purl.org` 仅为 schema 命名空间引用，不是抓取目标。

**请求策略**：

| 项 | 值 / 位置 |
|---|---|
| User-Agent | Chrome/131.0.0.0（Windows NT 10.0; Win64; x64），`http.py:16-20` |
| Accept-Language | `zh-CN,zh;q=0.9`（`http.py:21`） |
| 全局客户端超时 | 总 60s、连接 15s（`http.py:163`）；单请求被 `policy.timeout_s` 覆盖（`http.py:197`） |
| 连接池 | 最大 128 连接、keepalive 32（`http.py:164`） |
| 重定向 | `follow_redirects=True`（`http.py:162`） |
| 重试 | 每源 `policy.retries`；状态 `403/429/502/503/504/>=500` 退避 `min(8, 0.5·2^n)+jitter`；连接/读取/协议/超时类 `min(5, 0.2·2^n)+jitter`；其他 `0.15~0.3s`（`http.py:79-95,214-227`） |
| 请求间隔 | 仅 anti-crawler 源保留 `min_interval_ms` 闸门；普通源固定间隔已废弃（`http.py:55-61,189-190`；`models.py:33-35` 注释） |
| 挑战页识别 | CF/阿里云 WAF/中文验证关键词命中即判 challenge（`http.py:24-40,199-202`） |
| 浏览器兜底 | Playwright 仅在 `--browser` 启用时懒加载；桌面 spawn 参数未带 `--browser`，默认关闭（`cli.py:278`；`http.py:103-147`） |
| 查询门面预算 | 单次墙钟 3.0s；收尾余量 0.65s；剩余 <0.2s 不再发起增量；每源候选上限 12、单页（`query.py:40-44,188-205`） |
| 单轮硬超时 | sidecar 每源单轮 `max_run_s=90`（桌面 spawn 固定；`service.py:226-231`） |
| 桌面客户端超时 | query 5000ms；refresh `wait:false` 5000ms、`wait:true` 120000ms；ingest 60000ms（`packages/news/src/index.ts:141-142,272,334`） |
| 代理变量 | 代码未显式配置 `proxy=`/`trust_env`；httpx 默认 `trust_env=True` 时会读取 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY`，实际是否生效 `[待验证]`（`http.py:160-165`） |

- 外部 LLM 端点（`DEEPSEEK_BASE_URL`，默认 `https://api.deepseek.com`）属另一条网络面，不在 sidecar 范围内，详见 `07-domain-services-and-determinism.md`。
- 可测点：mock/拦截本地 8788 与外部站点，验证超时分级、重试退避与降级 `degraded` 标记；代理变量生效性见第 6 节。

### 4.6 共用 SQLite 的并发风险与观测点（EXT-12）

#### EXT-12 跨进程共享库 `[源码]`

- 同一文件：Node 侧 `<appHome>/data/learning.db`（`index.ts:71`）；sidecar 经 `--db` 收到同一路径（`news-backend.ts:100,125-126`）。
- 连接参数对比：

| 项 | Node（better-sqlite3 `DatabaseSync`） | Python（`sqlite3`） |
|---|---|---|
| WAL | `PRAGMA journal_mode = WAL`（`db/index.ts:833`） | `PRAGMA journal_mode=WAL`（`db.py:71`） |
| 忙等待 | `busy_timeout=5000`（`db/index.ts:834`） | `busy_timeout=5000`（`db.py:72`） |
| 外键 | `foreign_keys = ON`（`db/index.ts:832`） | 未设置（默认 OFF） |
| 线程模型 | 同步调用，主进程单线程 | `check_same_thread=False`，服务内多任务共享连接（`db.py:69`） |

- 写方分工：Node 写匹配、思政标注、证据、记忆、会话/turn、快照等；Python `SQLiteSink` upsert `news_articles`，`record_run` 写 `source_runs`（`service.py:274-284`）。
- 风险：WAL 同一时刻只允许一个写者；两侧并发写在 5s 忙等待后仍可能 `SQLITE_BUSY`。Python 未开外键约束，与 Node 侧约束口径不一致；schema 增补列 `content_hash/tag_content_hash` 由 Python `_ensure_columns` 补齐（`db.py:59-84`）。
- 观测点：
  1. `learning.db-wal` / `learning.db-shm` 文件存在与体积增长；
  2. `source_runs` 表每源最近一轮 `status/errors/failures`；`/health` 的 `sources.<id>.last` 与 `totals`；
  3. 主进程日志 `[news]` 前缀告警；sidecar stderr 转发行；
  4. 复现写竞争：压测期同时跑 Node 侧 matcher backfill 与 Python 增量入库，观察是否出现锁超时报错；
  5. 用隔离 `LEARNING_AGENT_HOME` 起两套实例时，确认各自库文件路径不串（见 EXT-04 的 `db_path` 比对）。

## 5. 风险与坑

- **R-1 端口复用不校验进程身份，可能串到旧/他人实例** `[源码]`：`health` 健康即复用，`db_path` 不一致只 warn（`news-backend.ts:103-107`）。测试环境若残留上一轮 8788 实例，新应用会把新闻读写指向旧库；用例必须按 EXT-04 三步核对 PID 与 `db_path`，不要只断言端口可达。
- **R-2 sidecar 退出后不自动重建** `[源码]`：exit 回调仅置空 `child`（`news-backend.ts:157-160`）。进程中途死亡后，应用看起来正常，但所有网络类新闻调用持续失败；自动化要区分「sidecar 未拉起」与「sidecar 已死」两种状态。
- **R-3 跨进程写竞争与外键口径不一致** `[源码]`：WAL 单写者 + 双侧 5s busy_timeout；Python 连接未开 `foreign_keys`。高并发入库时可能出现锁等待或 Node 侧外键约束与 Python 侧行为不一致；观测口径见 EXT-12。
- **R-4 `AUTOSTART=0` 不隔离请求** `[源码]`：跳过 spawn 后 `NewsService` 仍发 HTTP；把它误当成「关闭新闻功能」会误判为后端故障。离线测试应同时拦截/断开 8788。
- **R-5 `NEWS_CRAWLER_DB` 环境变量名不副实** `[源码]`：桌面注入该变量（`news-backend.ts:141`），但 Python 只从 `--db` 读库路径（`cli.py:58-59,165`）；若未来 Python 改为读 env 而桌面参数漏传，会静默写到默认 `.data/news.db`，需在回归中核对 `/health` 的 `db_path`。
- **R-6 新适配器不热加载** `[源码]`：服务启动时实例化源集合；`reload()` 只对比 `loaded/registered` 差异并报告 `new_unloaded`（`service.py:355-371`），新增/修改适配器必须重启 sidecar 生效。
- **R-7 代理与挑战页行为依赖运行环境** `[源码]` + `[待验证]`：代理是否走环境变量未显式配置；多个源带 WAF/验证页识别，真实可达性与风控阈值在当前网络未实测。企业内网代理下的抓取成功率需在批准环境复测。
- **R-8 `/health` 不代表采集健康** `[源码]`：进程存活即 `ok:true`；源全失败、被风控、库未更新时健康检查仍通过。断言「后端正常」不能只看 `/health`，要结合 `/stats` 或最近 `fetched_at`。

## 6. 未覆盖与待验证

1. **代理环境变量生效性** `[待验证]`：httpx `trust_env` 默认值随版本变化；验证方法：设置 `HTTPS_PROXY` 指向本地抓包代理，发起一次源抓取，确认请求经过代理；不生效则需在 `HttpClient` 显式传 `proxy=` 或文档注明不支持。
2. **端口被非应用进程占用时的 spawn 失败表现** `[源码]`（代码未做占用检测）+ `[待验证]`（实际报错形态）：验证方法：先占用 8788 起一个普通 HTTP 服务，再启动桌面，观察 Python 绑定报错日志、`waitHealthy` 8s 超时告警与主进程是否仍正常起窗。
3. **跨进程 `SQLITE_BUSY` 复现路径** `[待验证]`：验证方法：隔离 home 下并发触发 `matcher.backfill` 与 sidecar 增量入库，统计 `source_runs` 与主进程日志中的锁错误；确认 5s busy_timeout 是否足够。
4. **46 个启用源的真实可达性与风控** `[待验证]`：本文件只记录源码策略；各源当前是否可抓、命中哪类挑战页，需在批准联网环境按 `11-scenario-catalog.md` 场景跑一轮后回填。
5. **浏览器兜底路径在桌面是否可用** `[源码]`：spawn 未传 `--browser`，Playwright 未随默认依赖安装；验证方法：确认 `uv sync --extra browser` 后桌面启动参数是否启用兜底，以及 `BrowserFetcher` 懒加载在 sidecar 进程内的启动成本。
6. **HTTP 错误载荷在 renderer 侧的最终形态** `[待验证]`：`/run`、`/ingest`、`/query` 的错误经 `NewsService.request` 翻译为 `Error(message)`（`packages/news/src/index.ts:366-368`），再经 IPC 到渲染层；错误码/`error` 字段是否保留需按 `03-ipc-and-preload-contract.md` 第 4.2 节探针实测。
7. **Python 测试未覆盖的路由分支** `[待验证]`：400/404/422/502/503 状态码与 `trace` 截断未见用例；验证方法：对 `/run` 未知源、`/ingest` 非法 URL、`/query` 缺失模块构造请求断言状态码。

## 7. 交叉引用

- IPC 通道与 `news.refresh / news.list / news.get / news.match` 契约：`03-ipc-and-preload-contract.md#4-可测点`（`IPC-08`..`IPC-12`、`CH-01`）
- 启动装配、`initServices` 顺序与 `startNewsAutomation` 定时器：`02-main-runtime-and-boot.md#2-结构与流程`
- 采集适配器、匹配/标注算法与确定性分级：`07-domain-services-and-determinism.md#4-可测点`
- 共用 SQLite 表结构、种子库与 `LEARNING_AGENT_HOME` 隔离：`08-data-fixtures-and-isolation.md#4-可测点data-xx`
- 网络离线 / 降级 / 风控场景目录：`11-scenario-catalog.md`（待建）
- 既有脚本与测试缺口：`09-existing-verification-and-gaps.md#4-可测点既有资产清单覆盖矩阵与缺口`
