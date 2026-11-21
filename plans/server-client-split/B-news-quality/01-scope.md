# B · 新闻正文质量抽检 · 范围与边界

> 轮次：B · 新闻正文质量抽检
> 文档角色：01-scope
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1
> 写权：[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1
> 一句话：在宿主侧用一个只读 Python 脚本把新闻库按源体检一遍，产出 Markdown + JSON 抽检报告；不跑采集、不改库、不新增第三方依赖。

## 1 目标

1. **一个只读宿主脚本，按来源统计正文质量**。脚本 `services/news-crawler-py/scripts/quality_report.py` 直接以只读方式打开 SQLite 库，按 `source` 分组计算正文长度分位数、正文≈摘要比例、导航词命中率、`content_hash` 重复率、空标题/空日期比例。
   判断标准：对一份 `.scratch` 下的副本库跑通，JSON 报告里每个源都带齐 §3 列出的五类指标；脚本全程不产生任何 `INSERT/UPDATE/DELETE/DDL`。
2. **每源给出 3 条最差样本与一条处置结论**。样本正文截断 200 个码点；结论枚举为「保留 / 降级为只取标题摘要 / 下线」，结论必须能回溯到具体指标越线，而不是人工印象。
   判断标准：每个源的 `samples` 数组长度 ≤3，`verdictReasons` 逐条点名越线指标；报告顶层 `worstSources` 列出最差 5 个来源及证据。
3. **同一库重复运行统计一致（确定性）**。两次运行之间，除 `generatedAt`、`elapsedMs` 两个时间类字段外，JSON 字节级一致；排序全部带确定性兜底键，浮点按固定位数保留。
   判断标准：对同一副本库连跑两次，剔除两个时间类字段后 `json` 深比较相等；Markdown 报告除生成时间外逐行一致。
4. **指标口径与 AI 检索门面看到的数据一致**。长度、正文/摘要、状态字段都以库内已落库行为准，不重新抽取 HTML、不重新清洗，避免报告口径与 `news_crawler.query` 出参各说各话。
   判断标准：报告取数列与 `query.py` 的 `_row_to_item` 出参字段一一对应；`contentMode`/`contentStatus` 分界沿用入库既有常量 [R1]。
5. **零新增第三方依赖**。脚本只用 Python 标准库（`sqlite3`、`json`、`argparse`、`statistics`、`collections`、`pathlib`、`datetime` 等），不改 `pyproject.toml`、不改锁文件、不装新包。
   判断标准：在仓库根既有 `.venv` 里直接 `python scripts/quality_report.py ...` 可跑；`pyproject.toml` 的 `dependencies` 列表与本轮开工前一致。
6. **结论可追溯、可复核**。方法学、阈值与理由写进 `docs/news-source-quality.md`；一份冻结样例 `docs/quality-report.sample.json` 供契约测试与文档对照。
   判断标准：不跑脚本的人只读方法学文档 + 样例 JSON，能说清每个指标怎么算、每条结论为什么得出。

指标维度（长度分布、导航噪声、重复、退化形态）的划分参照正文抽取质量评测的通行做法 [R1]；本轮只做离线审计，不引入任何抽取器或在线服务。

## 2 非目标

| 不做 | 为什么不做 |
|---|---|
| 不跑采集、不调 `SourceRunner`/`HttpClient`/注册表网络请求 | 本轮是体检工具；采集链路归 C 轮与现有 `cli.py`，脚本一旦发起网络请求就无法在离线副本库上复跑 [R3] |
| 不改库：不 upsert、不删草稿、不改 schema、不做迁移 | 写库会改变被审计对象，且与 D 轮迁移基线、G 轮备份范围冲突；`output.py` 的写路径只供采集侧使用 [R6] |
| 不新增第三方 Python 依赖 | 写权矩阵未授权改 `pyproject.toml`；标准库的 `sqlite3` + 排序足够完成分组统计，模糊匹配/分词库一律不引 |
| 不执行「下线 / 降级」动作 | 报告只给建议；真正停用源、改 `enabled` 是运维与 C 轮的决定，脚本不回写注册表、不改源配置 |
| 不做模糊去重 / MinHash / 语义相似度 | 重复率只按 `content_hash` 精确分组；近重复识别超出本轮范围，也会引入新依赖 [R7] |
| 不改现有采集源码、现有脚本、`docs/QUERY-API.md` | 这些是只读依赖；方法学文档与样例 JSON 是 B 名下仅有的新文档 |
| 不接服务端 HTTP、不暴露 `/metrics`、不做定时任务 | B 是宿主侧一次性 CLI；长驻服务、指标、cron 分别归 A/F/C 轮 |
| 不做正文重新抽取或二次清洗 | 入库时已由 `normalize.py` + `html.py` 清洗；报告以落库行为准，重洗会让样本与 AI 实际看到的不一致 |
| 不处理 PG 库 | D 轮才做 SQLite→PG 迁移；本轮只读 SQLite 文件，方言不延伸到 PG |

## 3 真实依据（现状代码）

> 行号以 2026-11-19 工作区为准；每条写清「现在是什么 / 为什么与本轮目标相关」。

| # | 位置 | 现状是什么 | 与本轮的关系 |
|---|---|---|---|
| 1 | `services/news-crawler-py/src/news_crawler/db.py:25-31` | `news_articles` 为 `STRICT` 表，列含 `id/source/source_id/title/url/author/published_at/summary/content/content_status/rights/fetched_at/content_hash/tag_content_hash` | 报告全部指标只能从这些列取；`content/summary/title/published_at/content_hash/source` 是直接计算列，`content_status` 作辅助证据 [R4] |
| 2 | `services/news-crawler-py/src/news_crawler/db.py:32-34` | 三条索引：`url` 唯一、`published_at`、`tag_content_hash` | 报告只读索引与列，不新增索引、不改索引；URL 唯一是入库去重前提，哈希重复率另算 |
| 3 | `services/news-crawler-py/src/news_crawler/db.py:37-52` | `source_runs` 表记录每轮 `fetched/inserted/updated/skipped/errors/failures` | 采集成败统计已由 `status` 命令覆盖；B 的正文质量指标只来自 `news_articles`，不重复造运行统计表 |
| 4 | `services/news-crawler-py/src/news_crawler/normalize.py:11-12` | `MIN_CONTENT_CHARS = 20`、`FULL_TEXT_CHARS = 300` 两个既有常量 | 阈值锚点：正文过短、`full/summary` 分界都沿用这两个数，报告不自造一套长度标准 |
| 5 | `services/news-crawler-py/src/news_crawler/normalize.py:35-41` | 正文/摘要先 `clean_text`；正文不足 20 字时用摘要兜底，仍不足则拒绝入库 | 落库 `content` 已是清洗后文本；报告不再二次清洗，长度口径与入库一致 |
| 6 | `services/news-crawler-py/src/news_crawler/normalize.py:42-44` | 标题清洗后为空则拒绝入库（`missing title`） | 正常链路空标题应被拦截；库里若仍出现空标题，属于历史脏数据，正是「空标题比例」要暴露的对象 |
| 7 | `services/news-crawler-py/src/news_crawler/normalize.py:53` | `published_at = raw.published_at.strip()`，允许留空串 | 空日期是合法可落库状态；「空日期比例」是真实可测指标，不是伪命题 |
| 8 | `services/news-crawler-py/src/news_crawler/normalize.py:54`、`:81` | `content_mode` 按 300 字分 `full/summary`；`content_status` 按 1000 字分 `full/partial` | 报告样本展示这两个既有状态作为旁证；降级判据参考 300/1000 两条既有分界 |
| 9 | `services/news-crawler-py/src/news_crawler/query.py:99-114` | `_row_to_item`：`content` 兜底 `""`，`contentMode` 按 300 字反推，`contentStatus` 沿用入库值，`publishedAt` 兜底 `""` | AI 门面看到的字段形状就是报告口径；空值兜底规则必须照搬，否则报告与检索结果对不上 |
| 10 | `services/news-crawler-py/src/news_crawler/output.py:91` | `content_hash = sha256(article.content.encode("utf-8")).hexdigest()` | 哈希重复率按该列精确分组；同哈希即同正文，不做模糊比较 [R6] |
| 11 | `services/news-crawler-py/src/news_crawler/output.py:93-102` | 同 URL 且哈希相同 → 只更新 `fetched_at`，返回 `skipped` | 入库侧已按 URL 去重；报告统计的是「正文哈希在源内重复」，与 URL 去重是两件事 |
| 12 | `services/news-crawler-py/src/news_crawler/db.py:65-75` | `connect()` 会 `mkdir`、设 WAL/`busy_timeout`、`executescript(SCHEMA)`、跑列迁移 | 这个连接函数带建表/迁移副作用，B 不能复用；必须以只读 URI 打开，避免审计脚本意外建表或写 WAL |
| 13 | `services/news-crawler-py/src/news_crawler/query.py:49-51`、`services/news-crawler-py/src/news_crawler/cli.py:21` | 默认库路径为服务根目录 `.data/news.db`；`cli.py` 的 `DEFAULT_DB` 同值 | B 的 `--db` 默认值与既有口径一致，环境变量 `NEWS_CRAWLER_DB` 覆盖（冻结文件 §10.2） |
| 14 | `services/news-crawler-py/src/news_crawler/cli.py:77-83`、`:81` | `--source` 可重复；未注册源抛 `未注册的 source: ...` | 现有 CLI 对照注册表校验源；B 不 import 注册表，改为按库内实际 `source` 分组（差异见 §4） |
| 15 | `services/news-crawler-py/src/news_crawler/cli.py:119-121`、`:128`、`:351-362` | 缺入库目标退出 2；采集成败退出 0/1；`KeyboardInterrupt` 退出 130 | B 沿用「参数错 / 运行失败 / 成功」的退出码分层，但 1 的语义改为「库不可读」，不与采集失败混用；退出码分层形态参照既有 CLI 约定 [R9] |
| 16 | `services/news-crawler-py/docs/QUERY-API.md:60`、`:63-64`、`:140-142`、`:145` | 空日期排序排末尾；≥300 字为 `full`；去重键为 canonical URL；默认库不存在时自动建表 | 契约文档已固化这些口径；报告的空值处理、长度分界、去重概念与之对齐；B 不触发自动建表 [R4] |
| 17 | `services/news-crawler-py/pyproject.toml:5-10` | Python `>=3.12,<3.14`；第三方依赖仅 `httpx`、`beautifulsoup4`、`lxml` | B 脚本按 3.12 语法写；不新增依赖，也不依赖浏览器/Playwright 兜底 |
| 18 | `services/news-crawler-py/README.md:328` | 「文章去重、打标由下游流程负责，本服务只保证 URL 入库与 `content_hash` 更新」 | 边界确认：B 只出审计报告，不替下游做去重修复或打标 |
| 19 | `services/news-crawler-py/src/news_crawler/query.py:117-126` | `_merge` 按 canonical URL 去重，按 `publishedAt` 倒序、空日期排末尾，截断到 `limit` | 报告样本排序不沿用检索截断逻辑；B 按自身缺陷分打分排序，但空日期兜底规则与这里一致 |
| 20 | `services/news-crawler-py/src/news_crawler/cli.py:224-250` | `status_cmd` 只读 `source_runs` 出每源最近状态表，不碰 `news_articles` 正文 | 证明「采集健康」与「正文质量」是两套既有视角；B 补的是后者，不改造 `status` 输出 |
| 21 | `services/news-crawler-py/.scratch/acceptance-news.db`（只读抽样） | 55 行、4 个源；空日期 15 条、空标题 0 条；`content_status` 含 `full`/`partial`；`content_hash` 无空值 | 说明空日期比例是真实可测信号、空标题在历史样本中为 0 但口径仍需保留；具体数值以验收轮次在副本库上实测为准，不在本轮写死 |

这 18 条的共同判据是「报告数字必须能回溯到库内某一列、某一条既有常量」；分位数类指标在小样本上的稳定性问题由 §7 风险 2 承接 [R8]。

## 4 与现行为的差异（有意收紧 / 放宽）

| 项 | 现状 | B 轮契约 | 影响谁 |
|---|---|---|---|
| 数据库连接 | `db.connect()` 建表、跑列迁移、写 WAL（`db.py:65-75`） | B 以 `file:<path>?mode=ro` 只读 URI 打开，并设 `query_only=ON`；不执行任何 DDL/DML | 审计脚本对并发写库更安全；代价是不能用 `db.connect` 的便捷封装 |
| 源名校验 | 现有 CLI 对照 `SOURCES` 注册表拒绝未知源（`cli.py:77-83`） | B 不 import 注册表；`--source` 按库内实际 `source` 过滤，匹配不到的名字只在报告里给警告 | 离线副本库可能缺注册表元数据；B 因此不依赖注册表即可跑 |
| 统计对象 | `status` 命令只报采集轮次成败与计数（`cli.py:224-250`） | B 新增正文质量指标（长度分位、重合、导航命中、哈希重复、空标题/空日期），不改 `status` | 运维看采集健康仍走 `status`；正文质量看 B 报告 |
| 去重口径 | 入库按 URL 唯一 upsert（`output.py:105-134`） | B 审计 `content_hash` 源内重复，只报告不回写 | 下游去重流程不受 B 影响；重复率高的源进入人工复核队列 |
| 退出码 | 1 = 采集有失败；2 = 缺入库目标 / 未知命令（`cli.py:121`、`:128`） | 0 = 库可读且完成分析（含空表）；1 = 库不可读 / 缺表；2 = 参数错 | 自动化脚本按 B 的退出码分流，不与采集退出码混用 |
| 报告形态 | 现有脚本多为 stdout 表格 + 可选 JSONL（`services/news-crawler-py/scripts/live_check.py:103-109`） | B 同时产出结构化 JSON 与 Markdown 报告；JSON 供契约测试解析，Markdown 供人读 | E 轮/后续工具可消费 JSON；样例 JSON 冻结在 `docs/` |

> 差异中「只读连接、不 import 注册表」两条是并行开工的前提：B 不能因为注册表未加载、采集进程未起而阻塞 [R3]。

## 5 产物清单

> 与 [`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1 文件写权矩阵逐条对齐；下列路径之外一律只读。

| 路径 | 动作 | 作用 | 写权依据 |
|---|---|---|---|
| `services/news-crawler-py/scripts/quality_report.py` | 新建 | 只读抽检脚本：参数解析 → 只读开库 → 按源分组计算指标 → 结论判定 → 输出 JSON/Markdown；内部模块划分（参数、取数、指标、判定、渲染）在 `03-implementation.md` 落地，本文件只锁产物边界 | 写权矩阵第 15 行：`scripts/quality_report.py` owner = B |
| `services/news-crawler-py/docs/news-source-quality.md` | 新建 | 方法学说明：每个指标的定义、阈值表与理由、样本选取规则、结论枚举、复核方法与已知局限；面向读报告但不跑脚本的人 | 写权矩阵第 16 行：`services/news-crawler-py/docs/**` owner = B |
| `services/news-crawler-py/docs/quality-report.sample.json` | 新建 | 一份冻结样例输出（基于 `.scratch` 副本库生成），结构与 `02-contract.md` §3 schema 逐字段对照；供契约测试与文档引用，不含真实个人数据 | 写权矩阵第 16 行，`docs/**` 范围内 |

**明确不新增**：

- 不改 `services/news-crawler-py/pyproject.toml`、`uv.lock`、`src/**`、现有 `scripts/*.py`、现有 `docs/QUERY-API.md`。
- 不在本轮物理新建 `tests/` 用例文件；自测编号与断言映射写进 `02-contract.md` §7，落地文件由后续 `03-implementation.md` / `04-acceptance.md` 轮次安排。
- 不写 `.data/` 下任何文件；报告输出默认落 `.scratch/run/B/`，用户显式指定 `--md-out/--json-out` 时才写到给定路径。

脚本作为宿主侧运维工具、不进入采集镜像：C 轮镜像不 COPY `scripts/`，这一点已在写权矩阵 §2 的冲突表里说明（B 脚本不被打包进 `yxs-crawler:local`）。产物按「脚本 / 方法学文档 / 冻结样例」三件套拆分，与现有按源出报告的工具形态一致 [R3]。

## 6 并行边界

### 6.1 只读依赖

- 只读：`services/news-crawler-py/src/news_crawler/db.py`、`query.py`、`normalize.py`、`models.py`、`output.py`、`html.py`、`cli.py`、`docs/QUERY-API.md`、`README.md`。
- 只读输入：一份 SQLite 库副本（默认 `.data/news.db`，或 `--db` / `NEWS_CRAWLER_DB` 指定路径）；脚本不读取真实数据目录（`%APPDATA%`、`~/.learning-agent`、`<repo>/.learning-agent`）。
- 不 import 采集运行时：不引 `runner`、`http`、`registry`、`sources`、`service`；注册表缺失不影响脚本跑离线副本库。

### 6.2 写权唯一

B 名下可写路径仅限 §5 三张表内的三个新文件；其余路径（`packages/**`、`apps/desktop/**`、`docs/contracts/**`、`services/deploy/**`、其他轮次 `tools/**`）全部只读。若实现中发现必须改共享文件，按写权矩阵 §1 的约定在本文 §7 登记「需要 owner 配合的变更」，不直接改。

### 6.3 运行时资源（端口 · 卷 · 容器名 · 临时目录）

| 资源 | B 轮占用 |
|---|---|
| 端口 | 无。脚本不开 HTTP 服务，不监听任何端口，不与 A 的 8080、C 的 8787、D/G 的 PG 端口冲突 |
| 容器 / 镜像 | 无。不跑 `docker`，不起容器，不占 `yxs-data` 等数据卷 |
| 临时目录 | `.scratch/run/B/`（内含 `home/` 副本与报告产物）；不删除 `.scratch/` 下其他轮次目录 |
| 安装目录 | 复用仓库根既有 `.venv`，不新建安装目录、不跑 `pip install` |
| 进程 | 一次性 CLI，跑完即退；无后台常驻进程、无定时器 |

### 6.4 不依赖他轮产物

- 不需要 A 的 `apps/server` 或 OpenAPI 文件；B 直接读 SQLite，不经 HTTP。
- 不需要 C 的 compose 镜像与采集结果；离线副本库即可开工。
- 不需要 D 的 PG 迁移产物；方言只面向 SQLite。
- 不需要 E 的契约测试包；B 的自测编号在本包内闭环。
- 反向：其他轮次不依赖 B 的报告产物；B 晚交付不阻塞 A/C/D/E/F/G/H/I 开工。

### 6.5 冲突裁决

1. 文件被非 owner 修改：按写权矩阵 §5.1，记录外部改动并重新验证，不擅自回滚他人改动。
2. 契约口径冲突：以冻结文件 `01-frozen-contracts.md` 为准；B 只能细化不能新增错误码、不改端口与环境变量名 [R4]。
3. 库并发访问：B 只读打开，与采集写进程之间靠 SQLite WAL 隔离；若读到的是提交快照而非最新一帧，属预期行为，在报告 `warnings` 注明，不重试加锁、不阻塞写进程。
4. 阈值口径分歧：先以本计划 `02-contract.md` 阈值表为准；需要调整时升契约版本并登记，不在脚本里静默改数。

### 6.6 五条并行自证（八轮同一时刻开工不撞车）

1. **只读依赖自证**：脚本静态扫描自身 import 清单，只出现标准库模块；代码评审可逐条确认没有 `news_crawler.runner` / `news_crawler.http` / `news_crawler.registry` 引用，也没有任何网络调用。
2. **写权唯一自证**：`git status --porcelain services/news-crawler-py` 在本轮结束时只出现 §5 三个新文件；`src/`、`pyproject.toml`、`uv.lock` 无改动。
3. **运行时资源自证**：脚本不开 socket、不写镜像、不占卷；产物路径全部位于 `.scratch/run/B/` 或用户显式参数；与其他轮次无端口、目录、容器名交集（对照写权矩阵 §3 资源分配表，B 行「无端口 / `.scratch/run/B/home/` 只读 / 无容器名」）。
4. **不依赖他轮产物自证**：在一份只含 `news_articles`/`source_runs` 的最小副本库上，脚本能独立跑出完整报告；移除 `apps/server`、`tools/contract-tests`、`services/deploy` 目录后结果不变。
5. **冲突裁决自证**：B 与 C 同写 `services/news-crawler-py/` 目录，但文件路径不相交（C 写 `Dockerfile`/`.dockerignore`/`services/deploy/**`，B 写 `scripts/quality_report.py` 与 `docs/news-*`）；C 的镜像构建排除 `scripts/`，双方不读对方文件内容，靠冻结目录名解耦。

## 7 未知与风险

| # | 风险 | 怎么验证这个风险是否发生 |
|---|---|---|
| 1 | **脏读 / 半写状态**：采集进程正在 upsert 时打开库，只读连接可能读到 WAL 中已提交但未 checkpoint 的某一帧，两次跑之间数据被写入导致数字变化 | 准备一份副本库，一边用现有 `SQLiteSink` 写行、一边跑报告；对比 `.backup` 快照与报告行数。契约层面固定 `mode=ro` + `query_only=ON`，不触发 checkpoint；若出现跨帧不一致，在 `warnings` 注明「读取时刻快照」，不以两次运行必须逐字节相同为由重试加锁 [R5] |
| 2 | **样本量不足**：某源只有 1–2 条，P10/P90 与比例指标不稳，结论可能误判 | 造 `n=0/1/2/3` 四档夹具库分别跑；`n<3` 时 `sampleSize` 如实记录、结论强制「保留」并在 `warnings` 写明样本数，不输出「下线」建议；分位数在 `n=1` 时三值同取该条长度（口径见 `02-contract.md` §2.2） |
| 3 | **空表 / 缺表**：库文件存在但 `news_articles` 不存在（全新 `.data` 或错拷文件），或表内 0 行 | 分别造「缺表」「空表」「非空表」三份夹具：缺表退出 1 并报缺表消息；空表退出 0、指标全 `null`、`warnings` 提示 0 条；非空表正常出报告 |
| 4 | **长度口径歧义**：码点与字节、去除空白前后长度不一致，CJK 字符计数可能被算成字节 | 夹具含纯中文、含 `\u00a0`、含换行的样本；长度定义固定为「库内 `content` 字符串的 Python 码点数（`len()`），不二次清洗、不按 UTF-8 字节算」；对照 `html.py:17-24` 的既有清洗规则确认入库文本已归一 |
| 5 | **阈值误判**：0.20/0.30/0.50 等手工阈值把健康源打成「下线」，或放过问题源 | 在 `.scratch` 现有副本库上试跑，逐条核对被标「下线 / 降级」源的样本；阈值锚定既有 20/300/1000 常量（`normalize.py:11-12`、`:81`），其余比例阈值作为 v1 冻结值记录在方法学文档，留待积累更多库样本后校准；校准流程写进 `04-acceptance.md` |
| 6 | **只读副本漏拷 WAL/SHM**：复制运行中的库时只拷 `.db`，`-wal` 未拷导致读到旧帧或报错 | 验证步骤：复制时连同 `-wal`、`-shm` 一起拷到 `.scratch/run/B/home/`；脚本对「文件不存在 / 不是 SQLite / 缺表」三类错误分别给中文消息（见 `02-contract.md` §4），不抛英文堆栈 |
| 7 | **导航词表不全**：固定词表漏掉某源特有的模板噪声（免责声明、推广位、相关阅读），导航命中率偏低 | 词表作为脚本内冻结常量并在方法学文档公开；报告对每条命中样本记录命中词，便于复盘增补；本轮不做可配置词表（避免引入配置面与依赖） |
| 8 | **库内 `source` 与注册表不一致**：离线副本库可能含已停用源的历史行，或注册表后来改名；B 不 import 注册表，拿不到展示名 | 报告以库内 `source` 原值分组，不做 ID→名称映射；展示名缺失时原样显示 ID，并在方法学文档说明该限制；需要中文名时由消费方对照注册表补齐 |
| 9 | **阈值首版未经大样本校准**：0.10/0.20/0.30/0.50 为 v1 审计带，现有 `.scratch` 样本量有限，可能偏松或偏紧 | 验收轮次在多份副本库上试跑，逐条核对「下线 / 降级」样本；校准结论回填方法学文档并升契约版本；本轮不把阈值写成经验定论 |

风险 1 与 6 都属于「副本一致性」问题：离线审计必须基于一份冻结快照，而不是对着运行中的库反复读数，这与 SQLite 在线备份文档对一致性读取的要求一致 [R5]。

## 参考

- [R1] trafilatura — https://github.com/adbar/trafilatura — 支撑 §1 目标 1 与 §3 指标维度划分 — 借鉴「长度 / 导航噪声 / 重复」三类质量信号；不引入其 HTML 抽取器。
- [R2] python-readability — https://github.com/buriy/python-readability — 支撑 §1 目标 2 与退化形态识别 — 借鉴「正文与摘要高度重叠即抽取退化」的判据；不引入其解析库。
- [R3] newspaper — https://github.com/codelucas/newspaper — 支撑 §2 非目标与 §6.4 按源出报告的结构 — 借鉴按来源分组 + 样本展示的报告形态；不引入其抓取栈。
- [R4] SQLite STRICT tables — https://www.sqlite.org/stricttables.html — 支撑 §3 第 1 条列可空性假设与 §6.5 契约口径 — 采用 `NOT NULL DEFAULT ''` 下空串即空值的判断；不改动表结构。
- [R5] SQLite Online Backup API — https://www.sqlite.org/backup.html — 支撑 §7 风险 1/6 的一致性读取与副本要求 — 借鉴「读并发库需要一致性快照」；B 不调用备份 API，只做只读连接。
- [R6] dedupeio/dedupe — https://github.com/dedupeio/dedupe — 支撑 §2 非目标「不做模糊去重」与 §3 第 10 条精确哈希分组 — 借鉴记录去重的问题划分；不引入其模糊匹配与实体解析。
- [R7] google-research/deduplicate-text-datasets — https://github.com/google-research/deduplicate-text-datasets — 支撑 §2 非目标「不做 MinHash 近重复」 — 对照其哈希思路说明本轮只做精确 `content_hash` 分组；不引入 minhash/采样流水线。
- [R8] CamDavidsonPilon/tdigest — https://github.com/CamDavidsonPilon/tdigest — 支撑 §3 末条与 §7 风险 2 的分位数稳定性讨论 — 说明小样本不使用近似 sketch；本轮在全量样本上做精确线性插值。
- [R9] ankane/active_median — https://github.com/ankane/active_median — 支撑 §1 目标 1 的数组分位数计算形态 — 借鉴「对数组直接算 median/percentile」的简单路径；不引入 Ruby 栈或其 ORM 依赖。
