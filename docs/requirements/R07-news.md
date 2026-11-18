# R07 新闻

> 状态：MVP（本轮）
> 依赖：[R03 工具层](R03-tools.md)、[R05 上下文按需获取](R05-context-on-demand.md)、[R17 本地数据](R17-local-data.md)
> 代码：`packages/news/src/index.ts`（Python 服务客户端）、`services/news-crawler-py/`（采集与入库）、`packages/agent/src/tools/read-tools.ts`
> 上位原则：`../principles/single-agent.md`
>
> 2026-11 实现切换：TypeScript 源适配器、`normalize.ts` 与 `pipeline/ingest-news.ts` 已删除；
> 采集、解析、去重和增量入库统一由 Python 服务的 `sources/*.py` + `db.py` 负责。

## 1. 要什么（学生可见结果）

- 学生问「最近营销圈有什么」「用最新新闻分析一下」，营小商能在本地新闻库里检索到真实文章，按相关度、再按发布时间给出候选，再读正文作答。
- 学生自己贴一条新闻链接或报一个新闻标题时，营小商能把它抓进来分析，而不是只回答「我的库里没有」。
- 引用逐字来自正文；抓不到、只抓到摘要、正文太短，都要说清楚，不拿标题补成正文。
- 学生看不到抓取日志、限速、内部来源 id；只看到「哪家媒体、什么时候、讲了什么」。

## 2. 落位（提示词 / 工具 / skill / 数据）

| 落位 | 内容 |
|---|---|
| 数据 | `news_articles` 表（SQLite）；Python 注册表 50 个源、46 个启用；同库逐条增量 upsert |
| 工具 | `search_news`、`read_news`（`packages/agent/src/tools/read-tools.ts:316`、`:361`）；贴链接走 `crawl_url`（Python `/ingest`） |
| 提示词 | `mentor.md`「取材料」：新闻先 `search_news` 再 `read_news`，引用必须来自正文 |
| 定时 | Python `serve` 每源独立 `interval_s` 循环；桌面 `ensureFresh()` 只做兜底触发 |

插件侧另有 `list_news`、`get_news`、`web_search`、`crawl_url`、`refresh_news`（`packages/news/src/index.ts`），全部是 Python 控制面的客户端；`web_search` 的语义是「库内 + 3 秒事实增量」，不再在 TS 里抓网页。

`ingest_news` 是白名单内的新闻能力，不是通用抓取：只接收新闻 URL 或标题关键词，由 Python `/ingest` / `/query` 完成单篇抽取与正文门槛；R03 的「不做任意 URL 抓取」指不提供通用 `fetch` 工具，与本条不冲突。

## 3. 行为（一轮里怎么发生）

1. 学生提到新闻/最新动态：模型调 `search_news`（可带关键词），得到标题、来源、日期、摘要、id。
2. 模型自己选一条，调 `read_news` 取正文（最多 4000 字），工具写 `reads.news` 与 citation（引文 240 字）。
3. 模型基于正文分析；引用句逐字来自 `read_news` 返回。
4. 学生贴链接：模型调 `ingest_news`，抓取成功后得到新 id，再走第 2 步。
5. 抓取失败或正文不足：工具返回明确原因，模型据此说「这条只拿到标题/摘要，不能逐句引用」。

## 4. 契约（工具签名、数据结构、字段、命令）

### 4.1 新闻字段（`packages/shared/src/index.ts:124-137`）

`id`、`source`、`source_id`、`title`、`url`、`author`、`published_at`、`summary`、`content`、`content_status`、`rights`、`fetched_at`。

- `id` 形如 `<source>-<sourceId>`；`url` 唯一（`news_articles_by_url`）。
- `content_status`：`full`（正文 ≥1000 字）/ `partial`（其余可入库短稿）/ `unavailable`（不落库）。Python 入库最低正文/摘要 20 字。
- `rights` 固定 `internal-research; source-link`。

### 4.2 源注册表（`services/news-crawler-py/src/news_crawler/sources/*.py`）

一源一文件，`DESCRIPTOR` 自带入口、分页、能力与 policy；`registry.py` 自动派生，当前 50 个注册源、46 个启用，4 个停用并在 `note` 写明原因。原 TS 的 8 个源已迁入同一注册表，不再有两套爬虫。

### 4.3 抓取与限速

- 普通源不设每请求固定间隔；详情按源并发（默认至少 4），列表一次拉一批，解析一条就 upsert 一条。
- 只有 `capabilities.anti_crawler=True` 的源（NBD、梅花等）按自身 policy 保留低并发/间隔；失败才指数退避。
- 单源单轮硬超时由 `--max-run-s`（默认 90 秒）控制；超时只影响该源本轮，统计写 `failure` + 失败明细。
- 全局跨源并发由 `--workers` / `NEWS_CRAWLER_WORKERS` 控制（默认 8），槽位只在跑一轮期间持有，跑完立即让给下一个源。
- URL 唯一 + `content_hash` 判断正文变化；同 URL 重抓不变计 `skipped`，正文变化才 `updated` 并清旧草稿。

### 4.4 工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `search_news` | `query?`（空 = 最新）、`limit?`（1–20，默认 8）、`online?`（主动联网补抓） | 标题、id、来源、日期、摘要 160 字；只含正文 ≥40 字的文章；末尾附「本地库 N 条，最新 某天｜已联网/未联网」。**本地一条都没命中时会自动联网一次（上限 15 秒，由 Python 后端执行事实增量）** |
| `read_news` | `id?` 或 `title?` | 标题、来源、日期、链接、正文前 4000 字；本轮重复读返回「已读过」 |
| `ingest_news`（新增） | `url?`、`title?`、`query?` | `{ articleId, title, url, contentStatus }`；复用 `NewsService.crawlAndIngest` / `searchAndIngest` |

检索排序（命中后才加新鲜度分）：标题 6 分、摘要 2 分、正文 1 分，分数相同按 `published_at` 降序；`listNews` 本身按 `published_at DESC`（`packages/db/src/index.ts:2908-2920`）。

### 4.5 刷新与失败

- Python 长驻服务按每源 `interval_s` 调度；桌面 `ensureFresh()` 在库为空/过期时用 `wait=false` 触发一轮，不阻塞 UI。
- 手动 `refresh_news` 默认后台触发并返回 `{queued, accepted}`；需要等结果时显式传 `wait=true`。
- 单源失败只影响该源本轮统计，已入库文章不删除；`failures` 明确写 stage/url/message。
- 正文和摘要都不足 20 字才拒绝入库；短稿可以 `partial` 入库，`search_news` 本地门槛为 40 字，文案要说清正文不完整。

## 5. 边界（不做什么、失败怎么表现）

- 不做新闻阅读器，不做每日推送，不做全文搜索引擎。
- 不绕过登录、付费墙、验证码；抓不到就说抓不到，不伪造正文。
- 不把新闻全文提交进仓库或产物：仓库只留元数据 + 摘要 + 链接，全文只进本地库；引用 ≤240 字。
- 正文 <20 字（且摘要也 <20 字）：不入库；`search_news` 本地检索门槛 40 字。
- 只拿到 `partial`：分析时必须说明「正文不完整，结论可能缺上下文」。
- 时间缺失或格式异常：按字符串排序仍返回，但不宣称「最新」；无法确定日期时明确标注。
- 网络全失败：沿用库里的旧文章，并在回复中说明「刚才是本地缓存，未更新」。

## 6. 验收（场景 → 期望）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 「根据最新消息出一道题」 | 先 `search_news` 再 `read_news`；空关键词检索按 `published_at` 降序返回最新一批，不退回旧文；若只能拿到旧文，说明库未更新；`trace.reads.news ≥ 1` |
| 2 | 学生贴一条新闻链接 | `crawl_url` / `ingest_news` 成功返回 `articleId` 与 `contentStatus`；随后能 `read_news` 读到正文并引用；正文和摘要都不足 20 字时明确说抓取失败及原因 |
| 3 | 断网或源站验证拦截 | Python 刷新失败不删旧数据；`search_news` 仍能返回旧文章；回复说明「未更新」，不编造新事实 |
| 4 | 搜「直播电商」 | 结果按相关度、再按发布时间降序；每条带来源与日期；46 个启用源的文章都能被检索到 |
| 5 | 正文只有 500 字 | `content_status=partial`；`read_news` 返回正文，回复明确写「正文不完整」；不把摘要当正文引用 |
| 6 | 检查仓库与导出 | `data/normalized/news_articles.json` 不再提交全文（当前仍提交，见 §7）；产物/导出只含链接、摘要、≤240 字引文 |

## 7. 现状与差距（代码事实）

- 采集与入库已全部在 `services/news-crawler-py`：50 个注册源、46 个启用；`sources/*.py` 自注册，`db.py` 是唯一 schema/DAL。
- 原 TS 的 `packages/news/src/sources/`、`normalize.ts`、`pool.ts` 和 `pipeline/ingest-news.ts` 已删除；`packages/news/src/index.ts` 只剩 HTTP 客户端与 Cordis 工具。
- 控制面：`GET /health`、`GET /stats`、`POST /run`（`wait=false` 后台触发）、`POST /ingest`（单篇 URL）、`GET /query`（3 秒门面）。
- 入库：`news_articles.url` 唯一 + `content_hash`；逐条即时 upsert，每轮统计写 `source_runs`。
- 检索工具：`packages/agent/src/tools/read-tools.ts`；本地门槛 40 字，正文读取 `MAX_BODY=4_000`。
- 桌面：`apps/desktop/src/main/news-backend.ts` 自动拉起本地服务（默认 8788、`<appHome>/data/learning.db`）；外部服务器用 `NEWS_CRAWLER_URL` + `NEWS_CRAWLER_AUTOSTART=0`。
- 已知限制：`kr36`/`adquan` 详情被阿里云 WAF 拦截，`linkshop` TLS 证书不可验，均已在注册表停用；`iresearch` 详情 GBK 解码仍需单独适配。

## 8. MVP 范围与后续

**MVP 做到哪**

- 四个源可抓取、可限速、可去重；正文 ≥300 字才入库；`full` / `partial` 两级。
- `search_news` → `read_news` 主路径可用；引用逐字、有出处；重复读不重复占上下文。
- 定时刷新 30 分钟，失败保留旧数据；学生报链接通过 `ingest_news` 入库；该工具需在 [R03](R03-tools.md) 清单同步加一条声明（只加声明，不改调度）。
- 仓库改为只提交元数据 + 摘要 + 链接；全文只在本机 `LEARNING_AGENT_HOME`。

**后续**

- `read_news` / `search_news` 暴露 `content_status`，部分正文明确提示。
- 时间统一为带时区的 ISO 并归一化排序；缺失日期单列。
- 事件簇与多源去重（同一事件不同媒体报道合并），为案例卡服务。
- 更多源与来源权重；抓取失败的重试队列与可视状态。

**不做**

- 不做新闻阅读器、不做推送、不做站内搜索代理。
- 不绕过验证码/付费墙，不抓取需登录内容。
- 不把全文写进 git、产物或导出文件。
- 不做多租户抓取调度与教师端源管理。
