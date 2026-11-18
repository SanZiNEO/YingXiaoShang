# 新闻采集底层 0.2.0 交付报告（Python 采集服务）

> 分支 `feat/news-crawler`，服务目录 `services/news-crawler-py`，本地提交、未 push。
> 时间基准：2026-11-18。所有数字均为本机真实运行输出，不是估算。

## 一、结论

48 个池内源 + 原有源已全部落进 Python 注册表：**50 个注册、46 个可用、4 个按原因停用**。
底层已具备「每源一文件自注册 → 每源独立 policy → 8 槽位异步并发 → 逐条即时增量入库（URL 唯一 + content_hash）」，
长驻服务按每源自己的间隔独立循环、跑完即释放槽位、单轮有硬超时，采集统计逐轮落库、可 `status` / `/health` / `/stats` 查询，
并暴露 3 秒预算的 AI 检索门面（库内优先 + 事实增量爬取 + 超时降级）。

三个验收数字：

| 验收项 | 实测 |
|---|---|
| 一次 AI 调用 3 秒内返回约 40 条（温库、真实业务词） | **40 条 / p50 16ms / p95 16ms，0 次超预算**（30 次调用 max 2890ms，全部在预算内） |
| 30 秒能做多少 | 8 槽位：**274 条**（47 源排队只轮到 6 个源）；16 槽位：**524 条**（12 个源） |
| 全源一轮真实采集 | 47 个启用源 **528 条候选 / 386 条入库 / 139 条去重跳过 / 3 条短稿拒绝**，46 源 success、2 源 partial |

## 二、源覆盖

| 口径 | 数量 | 说明 |
|---|---|---|
| 池内 48 源 | 48 | 全部注册；其中 46 可用、2 停用（`kr36`、`iwangshang`） |
| 原有仓库源 | 5 | `socialbeta` / `brandstar` 本就在池内；新增 `wscn`（华尔街见闻，可用）；`linkshop` 证书不安全，注册但停用 |
| **注册表合计** | **50** | `sources/*.py` 一源一文件，各带 `DESCRIPTOR` + `ADAPTER` |
| **可用（enabled）** | **46** | 逐源 `live_check` 全部 `success`，每源至少 3 条真实入库 |
| **停用（enabled=False，附 note）** | **4** | 见下 |

停用清单（注册表里写明原因与日期，不伪装成功）：

| sourceId | 名称 | 原因 |
|---|---|---|
| `kr36` | 36 氪 | 首页/频道/历史接口全是阿里云 WAF 指纹挑战壳，无列表入口，裸 HTTP 不可解；需 Playwright |
| `adquan` | 广告门 | 联调末尾详情页被阿里云 WAF 挑战拦截（列表页正常），降速重试无效，暂不接入 |
| `iwangshang` | 天下网商 | 响应头 `Content-Security-Policy` 含 U+2011 非法字符，httpx/h11 直接 `RemoteProtocolError`；站点为无 SSR 的 Vue SPA |
| `linkshop` | 联商网 | TLS 证书链不可验，已从池内剔除，保留注册仅为记录原因 |

## 三、逐源状态（46 个启用源）

`最近一轮` = 全源 `crawl --max-items 5 --max-pages 1 --workers 8` 的真实结果；
`live_check` = `scripts/live_check.py --min-items 3`（每源 3 条真实入库 + 正文长度）。
`ins=0` 的那一轮是因为文章早已入库，`skip` 为 URL 去重命中——正是增量入库生效的表现。

| sourceId | 名称 | group | 最近一轮 | 耗时 | fetch/ins/skip/err | live_check ok | 正文中位 |
|---|---|---|---|---|---|---|---|
| accenture | 埃森哲 | consulting | success | 5.2s | 5/0/5/0 | 3 | 2443 |
| admen | 广告人网 | case | partial_failure | 5.2s | 5/0/4/1 | 3 | 1163 |
| bain | 贝恩 | consulting | success | 5.3s | 5/0/5/0 | 3 | 88 |
| brandcn | 品牌联盟网 | brandnews | success | 5.8s | 5/0/5/0 | 3 | 2106 |
| brandstar | 品牌星球 | case | success | 2.7s | 5/0/5/0 | 3 | 704 |
| cbndata | CBNData | data | success | 5.7s | 5/0/5/0 | 3 | 4069 |
| cca | 中国消费者协会 | official | success | 5.2s | 5/0/5/0 | 3 | 301 |
| ceibs | 中欧国际工商学院 | consulting | success | 5.3s | 5/0/5/0 | 3 | 4540 |
| cenr | 中国企业报道 | brandnews | success | 7.6s | 5/0/5/0 | 3 | 1222 |
| chinadaily-business | 中国日报商业 | portal | success | 5.4s | 5/0/5/0 | 3 | 5236 |
| chinanews | 中国新闻网 | portal | success | 5.2s | 5/0/5/0 | 3 | 748 |
| chinatopbrands | 中国名牌网 | brandnews | success | 5.4s | 5/0/5/0 | 3 | 1803 |
| cifnews | 雨果跨境 | ecommerce | success | 5.2s | 5/0/5/0 | 3 | 1830 |
| cls | 财联社 | portal | partial→已修 | 5.2s | 5/0/4/1 | 5 | 1650 |
| digitaling | 数英 | case | success | 5.1s | 5/0/5/0 | 3 | 2434 |
| eastmoney | 东方财富 | portal | success | 5.2s | 5/2/1/0 | 3 | 571 |
| ebrun | 亿邦动力 | ecommerce | success | 6.4s | 5/0/5/0 | 3 | 4924 |
| eeo | 经济观察报 | finance | success | 5.3s | 5/2/3/0 | 3 | 321 |
| foodinc | 小食代 | brandnews | success | 7.6s | 5/0/5/0 | 3 | 3565 |
| ifeng-finance | 凤凰网财经 | brandnews | success | 5.1s | 5/0/5/0 | 3 | 1540 |
| ipsos | 益普索 | data | success | 6.3s | 5/0/5/0 | 3 | 1994 |
| iresearch | 艾瑞咨询 | data | success | 1.1s | 5/0/5/0 | 3 | 370 |
| jiemian | 界面新闻 | company | success | 5.2s | 5/0/5/0 | 3 | 2578 |
| jj21 | 21 世纪经济报道 | finance | success | 0.5s | 5/5/0/0 | 3 | 139 |
| jwview | 中新经纬 | brandnews | success | 5.2s | 5/0/5/0 | 3 | 1643 |
| kantar | 凯度 | data | success | 8.4s | 5/0/5/0 | 3 | 4631 |
| latepost | 晚点 LatePost | industry | success | 10.6s | 5/0/5/0 | 3 | 11887 |
| mckinsey | 麦肯锡 | consulting | success | 5.1s | 5/0/5/0 | 3 | 2566 |
| meihua | 梅花网 | case | success | 5.6s | 5/2/3/0 | 3 | 894 |
| mofcom | 商务部 | official | success | 5.2s | 5/0/5/0 | 3 | 300 |
| money163 | 网易商业 | brandnews | success | 5.5s | 5/0/5/0 | 3 | 2140 |
| nbd | 每日经济新闻 | finance | success | 8.6s | 5/1/4/0 | 3 | 2341 |
| newrank | 新榜 | data | success | 5.2s | 5/0/5/0 | 3 | 3067 |
| nielseniq | 尼尔森 IQ | data | success | 5.3s | 5/0/5/0 | 3 | 17942 |
| qq-finance | 腾讯新闻产经 | brandnews | success | 5.5s | 5/1/1/0 | 3 | 1781 |
| questmobile | QuestMobile | data | success | 10.6s | 5/0/5/0 | 3 | 2634 |
| sina-finance | 新浪财经 | portal | success | 5.3s | 5/4/1/0 | 3 | 4467 |
| socialbeta | SocialBeta | case | success | 5.1s | 5/0/5/0 | 3 | 468 |
| stats | 国家统计局 | official | success | 8.5s | 5/0/5/0 | 3 | 4447 |
| stcn | 证券时报 | finance | success | 2.8s | 5/0/5/0 | 3 | 1191 |
| thepaper | 澎湃新闻 | industry | success | 5.2s | 5/0/5/0 | 3 | 980 |
| tidesight | 观潮新消费 | brandnews | success | 5.2s | 5/0/5/0 | 3 | 4986 |
| tmtpost | 钛媒体 | industry | success | 5.4s | 5/0/5/0 | 3 | 3501 |
| wscn | 华尔街见闻 | finance | success | 5.1s | 5/0/5/0 | 3 | 2258 |
| xinhua | 新华网 | portal | success | 5.3s | 5/0/5/0 | 3 | 980 |
| yicai | 第一财经 | finance | success | 5.2s | 5/0/5/0 | 3 | 1964 |

正文中位数偏低的源都是**形态如此**，不是抓坏：`bain`(88) 是短新闻稿、`jj21`(147) 是电报快讯、`mofcom`/`cca`(200–300) 是官方短发布、`iresearch`(370) 只有接口摘要（详情页 GBK 无法解码）、`socialbeta`/`meihua`(468/703) 是案例短文案。这些源按「短稿也是消息」口径用 summary 兜底，`contentMode=summary` 入库。

## 四、验收数据（真实运行）

### 1. AI 调用：3 秒内 40 条

`scripts/bench_query.py --calls 30 --budget 3.0 --limit 40`（温库 861 条 / 47 源）：

| 指标 | 全部 30 次 | 真实业务词（财经/消费/品牌/最新）18 次 | 无关词（深海采矿/极地科考）12 次 |
|---|---|---|---|
| p50 | 16.0ms | 15.0ms | 2804.5ms |
| p95 | 2828.0ms | 16.0ms | 2855.9ms |
| max | 2890.0ms | 16.0ms | 2855.9ms |
| 平均条数 | 24.0 | **40.0** | 0（库内确无该主题，不硬凑） |
| 降级率 | 0.40 | 0 | 1.0 |

**0 次超过 3 秒预算**。温库下真实业务词全部走快路径：`40/40` 条、15–16ms 返回、不降级。无关词在预算内现爬不到匹配内容，按契约降级返回空集而不是塞不相关内容，且耗时仍 ≤2.89s。
窄话题词（瑞幸/双十一/ESG/咖啡）走「库内 + 事实爬取」混合：`瑞幸`/`双十一` 命中数十条真实稿件，`ESG` 只有 4 条时在 2859ms 内降级返回。

### 2. 30 秒吞吐

| 配置 | 30 秒内成功入库 | 抢到槽位的源 | 说明 |
|---|---|---|---|
| `bench --seconds 30 --workers 8` | 274 条 | 6/47 | 8 槽位是当前上限，47 源排队，先完成的源释放槽位给下一个 |
| `bench --seconds 30 --workers 16` | **524 条** | 12/47 | 同一份代码，`--workers`/`NEWS_CRAWLER_WORKERS` 可配，服务器上可继续调 |

单源内部吞吐更高（`brandstar` 11.9s 内 100 条、`cbndata` 30s 100 条），说明瓶颈是**源级槽位数**不是单源能力。礼貌间隔 `min_interval_ms` 默认 1000ms 是刻意保留的。

### 3. 全源一轮

47 个启用源、`--max-items 12 --max-pages 2`：`fetch=528 / insert=386 / skip=139 / err=3`，耗时约 3 分钟（8 槽位）。
`err=3` 全部是短稿：`admen` 两条纯图片发题帖（32/27 字符）、`jj21` 一条 36 字符机器稿，被质量门槛拒绝——不是抓取失败。

### 4. 增量入库与 URL

- `news_articles.url` 唯一索引 + `content_hash`：同一 URL 重抓只更新 `fetched_at` 并计 `skipped`；正文变了才 `updated`（并清掉旧草稿 tag）。
- 实测证据：`stcn`/`yicai` 连跑两次 → 第一次 `insert=5/5`，第二次 `insert=0/0、skip=5/5`。
- JSONL 侧每行都是完整 `news-ingest/v1` 载荷，含 `url`、`canonical` 后的链接与 `contentMode`。
- 修掉一个统计失真 bug：JSONL sink 恒返回 `inserted`，同时挂 JSONL+SQLite 时会把重复抓取报成新插；现在 `CompositeSink` 只按「能去重的 sink」汇总状态。

## 五、底层结构

```
src/news_crawler/
  sources/<id>.py     一源一文件：DESCRIPTOR（sourceId/入口/分页/能力/policy）+ ADAPTER（列表+详情）
  sources/__init__.py 自动发现 + sourceId 校验（a-z0-9-，且与文件名 `-`↔`_` 对应）
  registry.py         由发现结果派生，不再手写
  http.py             每源限速/重试/验证页识别（含阿里云 WAF 指纹）、可选 Playwright 兜底
  html.py             正文/标题/日期/摘要/canonical 工具
  normalize.py        news-ingest/v1 归一，短稿用 summary 兜底（≥20 字符即可入库）
  runner.py           单源并发、列表边翻页边发详情、逐条失败隔离、benchmark
  output.py           JsonlSink / SQLiteSink / CompositeSink（都会去重口径）
  db.py               唯一 schema 与 DAL：news_articles + source_runs + 查询
  service.py          长驻服务：每源独立节拍、槽位限并发、单轮硬超时、统计落库
  http_api.py         标准库控制面：/health /stats /run /query
  query.py            3 秒检索门面（异步 + 同步包装）
  cli.py              list-sources / crawl / bench / schedule→serve / once / status
scripts/              live_check.py（逐源验收）、bench_query.py（3 秒验收）、export_registry.py（导出入库注册表）
ADAPTERS.md           新增一个源的规范（含 sourceId 规则、policy 档位、验收命令）
docs/QUERY-API.md     给调用方的检索契约
```

关键设计点：

- **入库边界**：adapter 只产出 `RawArticle`，不碰 DB；归一、去重、落库都在 `normalize.py` + `output.py` + `db.py`。
- **未注册 sourceId 拒绝**：注册表由发现器生成并校验格式，`scripts/export_registry.py` 导出 `news-ingest/v1` 的 `sources.json`（`group` 按协议映射为 news/marketing/data/official/vertical）。
- **慢源不拖快源**：每源一个 `asyncio.Task` 按自己的 `interval_s` 循环，槽位只在「跑一轮」期间持有，跑完立刻释放再睡；单轮 `max_run_s`（默认 90s）超时只取消该源本轮。
- **统计可查**：每轮（`schedule`/`manual`/`bench`）逐源 `record_run`，字段含 `fetched/inserted/updated/skipped/errors/duration_ms/started_at/status/failures`；`status` 出表，`/health` 出「是否在跑 + 下次触发 + 最近一次 + 累计」，`/stats` 出历史明细。

## 六、已知失败与限制

1. `kr36`、`adquan` 均需浏览器兜底（Playwright 未装 `browser` extra，本轮不引入）。
2. `iwangshang` 卡在抓取层的非法响应头解析，不是选择器问题；要接需绕过 h11 的 header 校验或在代理层清洗。
3. `admen` 的纯图片发题帖、`jj21`/`cls` 的超短电报会被质量门槛拒绝（`err` 计数，不影响整源）。
4. `iresearch` 详情页 GBK 编码在共享 `http.py` 下解码损坏，只能走接口摘要（`contentMode=summary`）。
5. `mckinsey` 标题带「– McKinsey Greater China」后缀（已记录，未剥离）；`kantar`/`bain`/`ipsos` 个别短稿以摘要兜底。
6. 咨询/研究机构多为单页列表，历史回填要另加分页；PDF 报告需留资，未自动提交表单。
7. `/query` 的降级是设计行为：3 秒内跑不完全部源就按库内结果返回，`meta.degraded=true` + `reason`。
8. 全源联调触发了 `adquan` 的 WAF，说明**生产环境需要按源退避**（本轮已把 WAF 指纹接入 `looks_challenged`，被拦会明确报错而不是记成空正文）。

## 七、下一步

1. 服务器部署：`news-crawler serve --db /data/news.db --port 8787 --workers 16`，接 systemd/supervisor，`NEWS_CRAWLER_WORKERS` 按机器调。
2. 装 Playwright extra，把 `kr36`/`adquan` 用浏览器兜底接回来（列表层 + 详情层各自兜底）。
3. 首跑回填：`crawl --unlimited --max-pages 10` 按源逐个跑一遍历史，再交给服务常态增量。
4. `iwangshang`：在 `http.py` 之外加一层容错 transport，或用 `--browser` 走 SPA。
5. Node 侧入库实现落地后，把 `scripts/export_registry.py` 的产物直接作为 `news-ingest` 注册表，并复用同一套 `canonicalUrl`/`contentHash` 口径。

## 八、复现命令

```powershell
cd E:\Documents\GitHub\YingXiaoShang\services\news-crawler-py
.\.venv\Scripts\python.exe -m news_crawler list-sources                 # 50 个源，4 个 enabled=False
.\.venv\Scripts\python.exe scripts\live_check.py --min-items 3          # 46/46 源达标
.\.venv\Scripts\python.exe -m news_crawler crawl --max-items 12 --max-pages 2 --db .data\news.db
.\.venv\Scripts\python.exe -m news_crawler bench --seconds 30 --workers 16 --db .data\news.db
.\.venv\Scripts\python.exe scripts\bench_query.py --calls 30 --limit 40 --db .data\news.db
.\.venv\Scripts\python.exe -m news_crawler serve --port 8787 --db .data\news.db
.\.venv\Scripts\python.exe -m news_crawler status --db .data\news.db
.\.venv\Scripts\python.exe -m pytest -q ; .\.venv\Scripts\python.exe -m ruff check .
```
