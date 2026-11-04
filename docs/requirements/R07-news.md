# R07 新闻

> 状态：MVP（本轮）
> 依赖：[R03 工具层](R03-tools.md)、[R05 上下文按需获取](R05-context-on-demand.md)、[R17 本地数据](R17-local-data.md)
> 代码：`packages/news/src/index.ts`、`packages/news/src/sources/`、`packages/news/src/normalize.ts`、`packages/agent/src/tools/read-tools.ts`、`pipeline/ingest-news.ts`
> 上位原则：`../principles/single-agent.md`

## 1. 要什么（学生可见结果）

- 学生问「最近营销圈有什么」「用最新新闻分析一下」，营小商能在本地新闻库里检索到真实文章，按相关度、再按发布时间给出候选，再读正文作答。
- 学生自己贴一条新闻链接或报一个新闻标题时，营小商能把它抓进来分析，而不是只回答「我的库里没有」。
- 引用逐字来自正文；抓不到、只抓到摘要、正文太短，都要说清楚，不拿标题补成正文。
- 学生看不到抓取日志、限速、内部来源 id；只看到「哪家媒体、什么时候、讲了什么」。

## 2. 落位（提示词 / 工具 / skill / 数据）

| 落位 | 内容 |
|---|---|
| 数据 | `news_articles` 表（SQLite）；四个抓取源；`data/normalized/news_articles.json` 为离线种子 |
| 工具 | `search_news`、`read_news`（`packages/agent/src/tools/read-tools.ts:316`、`:361`）；新增工具 `ingest_news`（见 §4.4） |
| 提示词 | `mentor.md`「取材料」：新闻先 `search_news` 再 `read_news`，引用必须来自正文 |
| 定时 | `NewsService.ensureFresh()` 每 30 分钟检查一次新鲜度，过期才抓 |

插件侧另有 `list_news`、`get_news`、`web_search`、`crawl_url`、`refresh_news`（`packages/news/src/index.ts:365-527`），属旧路径，不在单一智能体九条工具清单内；收敛见 [R03](R03-tools.md)。

`ingest_news` 是白名单内的新闻能力，不是通用抓取：只接收新闻 URL 或标题关键词，复用 `NewsService` 的抽取与正文门槛，不做任意 URL 代理；R03 的「不做任意 URL 抓取」指不提供通用 `fetch` 工具，与本条不冲突。

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
- `content_status`：`full`（正文 ≥1000 字）/ `partial`（300–999 字）/ `unavailable`（不落库）。
- `rights` 固定 `internal-research; source-link`。

### 4.2 四个源（`packages/news/src/sources/index.ts:7`）

| id | 入口 | 说明 |
|---|---|---|
| `socialbeta` | `https://socialbeta.com/` | 首页 `/article/<id>`、`/campaign/<id>` 链接 |
| `linkshop` | `http://www.linkshop.com/news/` | GB2312 页面按 GBK 解码，`/news/<id>.shtml` |
| `brandstar` | `https://www.brandstar.com.cn/` | `/in-depth/<id>`、`/news/<id>`，优先 JSON-LD |
| `wscn` | `api-one-wscn.awtmt.com/apiv1/content/articles` | API 失败时回退本地 seed 文件 |

### 4.3 抓取与限速

- 每个源独立限速：相邻请求至少 1 秒（`sources/http.ts:6`、`:18-21`）；超时 30 秒（`:7`）。
- 单源单次最多 30 条，详情并发 2（`packages/news/src/index.ts:55`、`:308`）。
- 默认 UA 声明用途与联系方式（`sources/http.ts:4`）；遇到 Cloudflare/火山验证页时回退 Playwright，仍失败则计为错误。
- 按 URL 去重；同一批内重复 URL 跳过。

### 4.4 工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `search_news` | `query?`（空 = 最新）、`limit?`（1–20，默认 8） | 标题、id、来源、日期、摘要 160 字；只含正文 ≥300 字的文章 |
| `read_news` | `id?` 或 `title?` | 标题、来源、日期、链接、正文前 4000 字；本轮重复读返回「已读过」 |
| `ingest_news`（新增） | `url?`、`title?`、`query?` | `{ articleId, title, url, contentStatus }`；复用 `NewsService.crawlAndIngest` / `searchAndIngest` |

检索排序：标题命中 4 分、摘要 2 分、正文 1 分，分数相同按 `published_at` 降序；`listNews` 本身按 `published_at DESC`（`packages/db/src/index.ts:2908-2920`）。

### 4.5 刷新与失败

- 定时器间隔 `refreshMinutes`（默认 30，最小 1）；最新 `fetched_at` 距今不足 30 分钟则跳过（`packages/news/src/index.ts:56`、`:251-259`、`:356-360`）。
- 刷新是单飞：并发调用复用同一个 Promise（`:243-249`）。
- 单源失败只标记该次 ingest run 为 `partial`，已入库文章不删除；`ensureFresh` 捕获异常并告警，不抛给学生。
- 正文 <300 字不落库；标题、URL、sourceId 缺失同样拒绝，并给出原因（`normalize.ts:16-26`）。

## 5. 边界（不做什么、失败怎么表现）

- 不做新闻阅读器，不做每日推送，不做全文搜索引擎。
- 不绕过登录、付费墙、验证码；抓不到就说抓不到，不伪造正文。
- 不把新闻全文提交进仓库或产物：仓库只留元数据 + 摘要 + 链接，全文只进本地库；引用 ≤240 字。
- 正文 <300 字：不入库；`search_news` 也不会返回。
- 只拿到 `partial`：分析时必须说明「正文不完整，结论可能缺上下文」。
- 时间缺失或格式异常：按字符串排序仍返回，但不宣称「最新」；无法确定日期时明确标注。
- 网络全失败：沿用库里的旧文章，并在回复中说明「刚才是本地缓存，未更新」。

## 6. 验收（场景 → 期望）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 「根据最新消息出一道题」 | 先 `search_news` 再 `read_news`；空关键词检索按 `published_at` 降序返回最新一批，不退回旧文；若只能拿到旧文，说明库未更新；`trace.reads.news ≥ 1` |
| 2 | 学生贴一条新闻链接 | `ingest_news` 成功返回 `articleId` 与 `contentStatus`；随后能 `read_news` 读到正文并引用；正文不足 300 字时明确说抓取失败及原因 |
| 3 | 断网或源站验证拦截 | 刷新失败不删旧数据；`search_news` 仍能返回旧文章；回复说明「未更新」，不编造新事实 |
| 4 | 搜「直播电商」 | 结果按相关度、再按发布时间降序；每条带来源与日期；四个源的文章都能被检索到 |
| 5 | 正文只有 500 字 | `content_status=partial`；`read_news` 返回正文，回复明确写「正文不完整」；不把摘要当正文引用 |
| 6 | 检查仓库与导出 | `data/normalized/news_articles.json` 不再提交全文（当前仍提交，见 §7）；产物/导出只含链接、摘要、≤240 字引文 |

## 7. 现状与差距（代码事实）

- 四个源已实现：`packages/news/src/sources/socialbeta.ts`、`linkshop.ts`、`brandstar.ts`、`wscn.ts`；`NEWS_SOURCES` 在 `packages/news/src/sources/index.ts:7`。
- 限速与超时：`sources/http.ts:6-7`（1 秒 / 30 秒），`RateLimiter` 在 `:20-37`，`limiters` 按 source 分桶（`:28`）。
- 正文分级：`packages/news/src/normalize.ts:16-18` 拒绝 <300 字；`:32` 按 1000 字分 `full` / `partial`。`unavailable` 在 schema 里存在，但当前不会写入。
- 刷新：`packages/news/src/index.ts:55-56`、`:251-259`、`:356-360`；单源抓取 `:305-345`（30 条、`pLimit(2)`）；失败计 `errors` 并把 ingest run 标为 `partial`（`:333-341`）。
- 检索工具：`packages/agent/src/tools/read-tools.ts:316-358`；正文读取 `:361-396`，`MAX_BODY = 4_000` 在 `:12`。
- 排序：`packages/db/src/index.ts:2908-2920` 按 `published_at DESC`；`search_news` 同分时再按该字段降序（`read-tools.ts:344-347`）。
- 数据现状：`data/normalized/news_articles.json` 108 篇（socialbeta 27、linkshop 30、brandstar 22、wscn 29；full 72、partial 36）；`pipeline/ingest-news.ts:15` 定义输出路径，`:46-48` 把全文写进仓库。
- 合规差距：该文件含正文全文（抽样一条 8975 字），与「仓库不提交全文」冲突；`rights` 字段已在 `normalize.ts:34` 标记为 `internal-research; source-link`。
- 工具清单差距：`ingest_news` 尚不存在于 `packages/agent/src/tools/read-tools.ts`；学生贴链接目前只能走旧插件的 `crawl_url`。
- 完整度暴露差距：`read_news` 返回体没有 `content_status`，模型只能从长度猜正文是否完整。
- 时间排序风险：`published_at` 字符串混用 `+08:00` 与 `Z`（数据里同时存在），按字符串比较在跨时区同一天可能错序，待核对。
- seed 回退路径依赖的 `news_articles_all_tagged.json` 只存在于 `data/legacy/marketing_news/wscn/normalized/`，`data/marketing_news/` 下没有；`sources/wscn.ts:37-40` 的回退因此只在 legacy 目录存在时生效。

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
