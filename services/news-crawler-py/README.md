# 营小商 Python 新闻采集服务

这是仓库里的 Python 后端爬虫，和 `packages/news` 的 TypeScript 版并存；Electron 前端继续用 TS/JS，这个服务只负责抓取、规范化和入库。

## 运行

```powershell
cd services/news-crawler-py
uv sync --dev
uv run news-crawler list-sources

# 单源小样本
uv run news-crawler crawl --source nbd --max-items 10 --max-pages 1 --output nbd.jsonl

# 8 源全量一轮
uv run news-crawler crawl --workers 8 --unlimited --output news.jsonl

# 直接写当前 Electron 的 SQLite（可选；默认路径是 %USERPROFILE%\.learning-agent\data\learning.db）
uv run news-crawler crawl --source yicai --max-items 20 --db "$env:USERPROFILE\.learning-agent\data\learning.db"

# 30 秒 8 源并发压测（fast 会关闭每源请求间隔，仅用于压测）
uv run news-crawler bench --seconds 30 --workers 8 --unlimited --max-pages 100 --fast --output bench.jsonl

# 常驻调度
uv run news-crawler schedule --output news.jsonl
```

`uv` 不在 PATH 时使用：

```powershell
& "$env:USERPROFILE\.local\bin\uv.exe" sync --dev
```

## 设计

- 源注册表：`src/news_crawler/registry.py`，每个源一个 `SourceDescriptor`。
- 每源策略：`SourcePolicy`（刷新周期、详情并发、请求间隔、超时、重试、单次上限）。
- 抓取层：`sources/<source>.py`，每个平台可以完全自定义；共享 `html.py` / `http.py`。
- 调度：每个源一个独立 `asyncio.Task`；源级 `Semaphore` 控制总并发；同一源内按 `detail_concurrency` 控制详情并发。
- 列表页会“边翻页边发详情任务”，不再等所有页翻完才开始抓正文。
- 单条详情失败只记 `SourceFailure`，不会中断该源，也不会影响其他源。
- 结果：`SourceRunResult`，状态为 `success / empty / partial_failure / failure`，带 fetched / inserted / updated / skipped / errors。
- 入库：`JsonlSink` 输出 `news-ingest/v1` 一行一条；`SQLiteSink` 可直接写 `news_articles`，保留 `content_hash` / `tag_content_hash` 的空值，后续仍由 Node 打标。

## 实测

2026-11-18，本机 Windows，8 源、8 个源 worker，30 秒：

| 模式 | 入库 | 说明 |
| --- | ---: | --- |
| 默认策略（每源请求间隔保留） | 280 | NBD 15、晚点 19、Yicai 19；NBD/晚点是主要瓶颈 |
| `--fast` + 100 页上限 | 1535 | NBD 仍只有 15；品牌星球 490、Yicai 302、经济观察报 270、证券时报 200 |

`--fast` 只用于压测，生产不要关闭请求间隔。Python 版和 TS 版不是完全同口径：TS 之前 fast 30 秒约 1621 条，但页面上限和每源策略不同；这里只说明 Python 已经能跑到同一数量级，NBD 仍是硬瓶颈。

## 当前边界

- `nbd` 详情并发固定为 1：直连单条能成功，但并发会被重置连接；可选用 Playwright 兜底。
- `latepost` 列表一次返回全量，详情速度是主要瓶颈。
- 短稿不直接丢弃：正文不足 40 字时用摘要兜底；仍不足 40 字才拒绝。
- 付费墙、需要登录的源没有接入。

浏览器兜底默认不启用；需要时：

```powershell
uv sync --extra browser
uv run playwright install chromium
uv run news-crawler crawl --source nbd --max-items 10 --browser --output nbd.jsonl
```
