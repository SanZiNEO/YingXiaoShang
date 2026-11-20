# 新闻正文质量抽检 · 方法学说明

> 适用脚本：`services/news-crawler-py/scripts/quality_report.py`（离线只读 CLI，本轮由并行实现，本文不依赖其源码）。
> 口径冻结：`plans/server-client-split/B-news-quality/02-contract.md` v1；本文只解释口径与复核方式，不另设数值。
> 读者：读报告但不跑脚本的人——运维、评审、后续轮次消费方。读完本文应能说清每个指标怎么算、每条结论为什么得出、怎样回库复核。

## 1. 概述

| 项 | 说明 |
|---|---|
| 解决什么问题 | 按来源（`source`）对新闻库做一次离线正文质量体检：长度分布、正文与摘要重合、导航噪声、哈希重复、空标题与空日期，逐源给出处置建议与最差样本。 |
| 谁看 | 不运行采集与脚本的人员：判断某个源应保留、降级为只取标题摘要还是下线；后续轮次可直接消费报告 JSON。 |
| 输入 | 一份 SQLite 文件副本中的 `news_articles` 表；`source_runs` 不在本轮指标范围内。库路径由 `--db`、环境变量 `NEWS_CRAWLER_DB` 或默认路径解析，见 §2.5。 |
| 输出 | 两份产物：Markdown 报告给人读（表格 + 样本预览）；结构化 JSON 给工具消费（字段见 §9）。同一库重复运行，除 `generatedAt`、`elapsedMs` 外结果一致。 |
| 边界 | 报告只给建议，不执行下线或降级动作：不停用源、不改 `enabled`、不回写注册表、不做去重修复或打标。脚本不发起网络请求，不调用采集 runner。 |

指标维度（长度分布、导航噪声、重复、退化形态）的划分参照正文抽取质量评测的通行做法，本轮只做离线审计，不引入任何抽取器或在线服务。

## 2. 数据源与只读口径

### 2.1 读取的表与列

报告全部指标只从 `news_articles` 取数，列清单与建表 DDL 一致（`services/news-crawler-py/src/news_crawler/db.py:25-31`）：

| 列 | 用途 |
|---|---|
| `id` | 样本回溯主键；同分同长时的排序兜底键。 |
| `source` | 分组键；报告按 `source` 原值分组，不做 ID 到名称的映射。 |
| `title` | 空标题比例；样本标题展示。 |
| `url` | 样本回溯链接。 |
| `published_at` | 空日期比例；样本日期展示。 |
| `summary` | 退化判定；摘要预览。 |
| `content` | 长度分位数、退化判定、导航命中、短正文缺陷；正文预览。 |
| `content_hash` | 哈希重复率分组；哈希口径沿用入库侧 `sha256(content utf-8)` 十六进制摘要（`services/news-crawler-py/src/news_crawler/output.py:91`）。 |
| `content_status` | 样本旁证展示（`full` / `partial` / 空串），不进判据。 |

既有索引（`url` 唯一、`published_at`、`tag_content_hash`，`services/news-crawler-py/src/news_crawler/db.py:32-34`）只被只读使用，报告不新增或修改索引。`news_tags` 等下游表不假设存在。

### 2.2 只读连接方式

| 规则 | 口径 |
|---|---|
| 打开方式 | `sqlite3.connect("file:<path>?mode=ro", uri=True)`，随后执行 `PRAGMA query_only=ON`；`mode=ro` 是文件级只读，`query_only=ON` 是第二道保险。 |
| 禁止动作 | 不执行 `journal_mode`、不建表、不跑列迁移、不开写事务；连接期间不触发 checkpoint、不持有写锁。 |
| 对照现状 | 采集侧 `db.connect()` 会 `mkdir`、设 WAL/`busy_timeout`、`executescript(SCHEMA)` 并跑列迁移（`services/news-crawler-py/src/news_crawler/db.py:65-75`、`services/news-crawler-py/src/news_crawler/db.py:78-84`），带建表与补列副作用，本脚本不复用该封装，也不 import `db.py`。 |
| 主表探测 | 查 `sqlite_master` 判断 `news_articles` 是否存在；判断思路与 `services/news-crawler-py/src/news_crawler/db.py:87-91` 一致，脚本内重写一份只读版本。 |

### 2.3 副本与 WAL 快照语义

- 抽检基于一份冻结副本，不直连运行中的主库。复制库文件时，若存在 `-wal`、`-shm` 副件，必须连同主库一起复制；只拷 `.db` 在 WAL 模式下可能读到未 checkpoint 的旧帧，或打开即报错。
- 脚本读到的是连接打开时刻的已提交快照；与采集写进程并发时，读到某一帧而非最新一帧属于预期行为，在报告 `warnings` 注明，不重试加锁、不阻塞写进程。
- 副本一致性前提参照 SQLite Online Backup API 的一致性读取要求；停采状态下文件复制可用，采集进程仍在写库时应改用在线备份方式出副本。

### 2.4 空值兜底与长度口径（报告口径 = AI 检索门面口径）

| 规则 | 口径 | 依据 |
|---|---|---|
| NULL 兜底 | `content` / `summary` / `title` / `published_at` 为 `NULL` 时按空串处理；`content_status` 为空串时原样保留空串。 | 与检索门面出参兜底一致，`services/news-crawler-py/src/news_crawler/query.py:99-114` |
| 长度单位 | 正文长度为库内 `content` 字符串的 Python 码点数（`len()`）；不按 UTF-8 字节算，不二次清洗、不重新抽取 HTML。 | 入库文本已由 `clean_text` 清洗归一，`services/news-crawler-py/src/news_crawler/normalize.py:35-41` |
| 状态旁证 | `contentMode` 按 300 字从库内正文反推，沿用门面既有常量；`contentStatus` 沿用入库值。 | `services/news-crawler-py/src/news_crawler/query.py:46`、`services/news-crawler-py/src/news_crawler/query.py:99-114` |

报告取数列与 `_row_to_item` 出参字段一一对应，避免报告口径与 AI 实际看到的数据各说各话。

### 2.5 库路径解析顺序

`--db` 参数 > 环境变量 `NEWS_CRAWLER_DB`（冻结合同环境变量名，`plans/server-client-split/00-master/01-frozen-contracts.md:406`）> 服务根目录 `.data/news.db`（`services/news-crawler-py/src/news_crawler/query.py:49-51`、`services/news-crawler-py/src/news_crawler/cli.py:21`）。解析后路径为空按参数错处理，见 §10.3。

## 3. 五类指标定义与公式

设某来源有 `n` 条文章，第 `i` 条正文长度 `L(i) = len(content_i)`。比例类指标除哈希重复率外分母均为 `n`；`n = 0` 时对应指标为 `null`。比例一律 `round(..., 4)`，分位数一律 `round(..., 2)`。

### 3.1 正文长度 P10 / P50 / P90

将 `L` 升序排列为 `x[0..n-1]`：

| 样本量 | 取值规则 |
|---|---|
| `n = 0` | 三个分位数均为 `null`。 |
| `n = 1` | `P10 = P50 = P90 = x[0]`。 |
| `n ≥ 2` | 对 `p ∈ {0.10, 0.50, 0.90}`，令 `h = (n - 1) * p`，`i = floor(h)`，`f = h - i`，则 `Q(p) = x[i] + f * (x[i+1] - x[i])`。 |

- 插值方法：线性插值（含端点，等价 Hyndman–Fan 方法 7 / NumPy 默认 `linear`）；在 Python 端排序后计算，不用 SQLite 窗口函数，避免不同 SQL 方言插值口径漂移。
- 分位数是全量排序精算，不使用 t-digest 一类近似结构；输出类型 `number | null`。

### 3.2 正文≈摘要比例 `degenerateRatio`

一条文章计入「退化」当且仅当同时满足以下三条：

1. `summary.strip()` 非空且 `content.strip()` 非空；
2. `len(summary) >= 0.80 * len(content)`；
3. 去空白后精确子串匹配：`summary in content` 或 `content in summary`。

`degenerateRatio = 退化条数 / n`；`n = 0` 为 `null`；`round(..., 4)`。判据含义：正文与摘要高度重叠，说明详情抽取退化成了摘要搬运。

### 3.3 导航词命中率 `navHitRatio`

冻结词表 `NAV_TERMS` 见 §8；命中规则为正文命中至少一个词即计数。`navHitRatio = 命中至少一个词的条数 / n`；`n = 0` 为 `null`；`round(..., 4)`。命中样本必须在 `defects` 与样本预览里可复核命中词。

### 3.4 `content_hash` 重复率 `duplicateHashRatio`

| 步骤 | 口径 |
|---|---|
| eligible 行 | `content_hash.strip()` 非空的行；空哈希行不参与分组，也不计入分母。 |
| 分组规则 | 按哈希精确分组；组内行数 `≥ 2` 时，该组所有成员记为重复行。 |
| 公式 | `duplicateHashRatio = 重复行数 / eligible 行数`；eligible 为 0 时为 `null`；`round(..., 4)`。 |
| 哈希口径 | 沿用入库侧 `sha256(content utf-8)` 十六进制摘要（`services/news-crawler-py/src/news_crawler/output.py:91`）；只做精确哈希分组，不做模糊匹配、MinHash 或语义相似度。 |

### 3.5 空标题比例 `emptyTitleRatio` / 空日期比例 `emptyDateRatio`

- `emptyTitleRatio = count(title.strip() == '') / n`
- `emptyDateRatio = count(published_at.strip() == '') / n`

`n = 0` 为 `null`；均 `round(..., 4)`。空日期是合法可落库状态（`services/news-crawler-py/src/news_crawler/normalize.py:53`，入库时仅做 `strip()` 允许留空串），不是解析错误；空日期在检索排序中排末尾（`services/news-crawler-py/docs/QUERY-API.md:60`）。

### 3.6 样例库实测数字（`.scratch/run/B/home/news.db`，只读探测）

| 项 | 实测值 |
|---|---|
| 文章总行数 | 55 |
| 来源数 | 4：`eeo` 15 条、`jiemian` 15 条、`socialbeta` 15 条、`stcn` 10 条 |
| 空标题 | 0 条 |
| 空日期 | 15 条，全部位于 `jiemian` |
| `content_hash` | 无空值；无成员数 `≥ 2` 的哈希组 |
| `content_status` | `full` 21 条、`partial` 34 条 |

以上数字仅作为口径举例；正式报告数字以脚本对目标库的实跑结果为准。

## 4. 阈值表、判定顺序与样本护栏

### 4.1 判定顺序

结论分三档：`offline`（下线）、`downgrade`（降级为只取标题摘要）、`keep`（保留）。判定时 **offline 优先**：先核对 §4.2 四条下线判据，命中任意一条即 `offline`；未命中下线再核对 §4.3 六条降级判据；都未命中为 `keep`。样本护栏（§4.4）在阈值判定之前生效。

### 4.2 下线 `offline` 判据（命中任意一条）

| 判据 | 阈值 | 理由 |
|---|---|---|
| `emptyTitleRatio ≥ 0.20` | 空标题超过两成 | 标题是检索与展示的主键，两成以上空标题说明源详情页基本不可用。正常链路空标题会被入库清洗拦截（`services/news-crawler-py/src/news_crawler/normalize.py:42-44`），库里仍出现空标题属于历史脏数据。 |
| `duplicateHashRatio ≥ 0.30` | 哈希重复超过三成 | 三分之一以上正文与同源其他条目雷同，源内容不具备增量价值。 |
| `degenerateRatio ≥ 0.50` | 退化条目超过半数 | 半数以上正文只是摘要搬运，详情抽取失败面过大。 |
| `length.p50 < 50` | 半数正文不足 50 字 | 50 字低于摘要兜底后的基本可用长度，与 20 字入库下限相邻（`services/news-crawler-py/src/news_crawler/normalize.py:11`）。 |

### 4.3 降级 `downgrade` 判据（未命中下线，且命中任意一条）

| 判据 | 阈值 | 理由 |
|---|---|---|
| `length.p10 < 100` | 最差十分位正文不足 100 字 | 尾部条目过薄，前端只能取标题摘要。 |
| `degenerateRatio ≥ 0.20` | 退化条目 ≥ 两成 | 局部详情抽取退化，先按标题摘要源使用。 |
| `navHitRatio ≥ 0.20` | 导航/广告噪声 ≥ 两成 | 正文混入模板噪声，可读性不足。 |
| `emptyDateRatio ≥ 0.30` | 空日期 ≥ 三成 | 时间排序与新鲜度判断不可靠（空日期排末尾，`services/news-crawler-py/docs/QUERY-API.md:60`）。 |
| `duplicateHashRatio ≥ 0.10` | 哈希重复 ≥ 一成 | 存在同质化条目，需人工复核。 |
| `length.p50 < 200` | 半数正文不足 200 字 | 介于摘要兜底与 300 字 `full` 分界之间，整体偏短（`services/news-crawler-py/src/news_crawler/normalize.py:12`、`services/news-crawler-py/src/news_crawler/normalize.py:54`、`services/news-crawler-py/src/news_crawler/query.py:46`）。 |

### 4.4 样本护栏：`n < 3`

| 规则 | 口径 |
|---|---|
| 强制结论 | `n < 3` 时结论强制 `keep`（保留），不输出降级或下线建议。 |
| 越线记录 | 阈值越线情况仍记入 `verdictReasons`，但不升级为降级 / 下线。 |
| 警告文案 | 「来源 `<id>` 样本不足 3 条（n=`<n>`），结论仅供参考。」同时出现在该源 `warnings` 与顶层 `warnings`。 |

护栏依据：1–2 条样本上 P10/P90 与比例指标不稳，结论可能误判；样本量如实记录在 `sampleSize`。

### 4.5 阈值触发示例（`.scratch/run/B/thresholds.db` 夹具，信号值实测）

| 源 | n | 实测信号 | 对应判据 | 该夹具最终结论 |
|---|---|---|---|---|
| `alpha` | 20 | `emptyTitleRatio=1.0000`（20/20 空标题） | 下线：`emptyTitleRatio>=0.20` | `offline` |
| `beta` | 10 | `duplicateHashRatio=1.0000`（10 条落在同一哈希组） | 下线：`duplicateHashRatio>=0.30` | `offline` |
| `gamma` | 10 | `length.p50=40`（10 条正文均 40 字） | 下线：`length.p50<50` | `offline` |
| `iota` | 10 | `degenerateRatio=1.0000`（10/10 正文≈摘要） | 下线：`degenerateRatio>=0.50` | `offline` |
| `delta` | 10 | `length.p10=40` | 降级：`length.p10<100` | `offline`（叠加哈希重复后按 offline 优先） |
| `eta` | 10 | `navHitRatio=1.0000`（10/10 命中导航词） | 降级：`navHitRatio>=0.20` | `offline`（叠加哈希重复后按 offline 优先） |
| `theta` | 10 | `emptyDateRatio=0.4000`（4/10 空日期） | 降级：`emptyDateRatio>=0.30` | `offline`（叠加哈希重复后按 offline 优先） |
| `epsilon` | 2 | 样本护栏触发（`n=2<3`） | 强制 `keep`，越线只记录不升级 | `keep`（护栏强制保留） |

该夹具同源正文为同模板重复串，`content_hash = sha256(content utf-8)`（`services/news-crawler-py/src/news_crawler/output.py:91`），因此 `alpha` / `beta` / `gamma` / `iota` / `delta` / `eta` / `theta` 的 `duplicateHashRatio` 实测均为 `1.0000`（≥0.30）。叠加 §4.1 的「offline 优先」判定后，这七个源的最终结论全部为 `offline`；表中「对应判据」只是该源被设计触发的那条信号，不代表最终分级。`epsilon` 走 `n<3` 护栏，最终 `keep`。

降级与保留档的正向覆盖：验收方另建一份「正文逐行唯一」的夹具库（同源每行 `content` 不同，避免哈希重复污染），使各信号单独越线且不触发下线判据，实测可分别得到：`length.p10=40` → `downgrade`；`navHitRatio=1.0000` → `downgrade`；`emptyDateRatio=0.4000` → `downgrade`；`degenerateRatio=0.3000` → `downgrade`；`duplicateHashRatio=0.2000` → `downgrade`；全干净源与 `n=3` 干净源 → `keep`。

## 5. 长度锚点：20 / 300 / 1000 的出处与用途

三个长度数直接来自入库既有常量，报告不自造一套长度标准；区分哪些进判据、哪些只作样本旁证：

| 锚点 | 值 | 出处 | 用途 | 是否进判据 |
|---|---|---|---|---|
| `MIN_CONTENT_CHARS` | 20 | `services/news-crawler-py/src/news_crawler/normalize.py:11` | 入库正文下限：正文不足 20 字时用摘要兜底，仍不足则拒绝入库（`services/news-crawler-py/src/news_crawler/normalize.py:35-41`）；样本缺陷码 `short_body` 取 `L < 20`；下线判据 `length.p50 < 50` 与该下限相邻。 | 进判据（缺陷码阈值与相邻长度阈值）。 |
| `FULL_TEXT_CHARS` | 300 | `services/news-crawler-py/src/news_crawler/normalize.py:12`；门面反推常量 `services/news-crawler-py/src/news_crawler/query.py:46` | `contentMode` 的 `full` / `summary` 分界：正文 ≥300 字为 `full`（`services/news-crawler-py/src/news_crawler/normalize.py:54`；`services/news-crawler-py/docs/QUERY-API.md:63`）；降级判据 `length.p50 < 200` 位于摘要兜底与 300 字分界之间。 | 进判据（200 字降级阈值的参照锚点）。 |
| `content_status` 分界 | 1000 | `services/news-crawler-py/src/news_crawler/normalize.py:81` | 入库时 `content_status` 按 1000 字分 `full` / `partial`；报告样本展示该状态作为旁证。 | 不进判据，只作样本旁证。 |

比例阈值 0.10 / 0.20 / 0.30 / 0.50 为 v1 审计带，首版校准证据在验收轮次于 `.scratch` 副本库上实测回填；调整任一数值属于契约变更，见 §12。

## 6. 最差样本选取规则

### 6.1 行级缺陷码与权重

| 缺陷码 `defects` | 含义 | 权重 |
|---|---|---|
| `empty_title` | 标题为空 | 3 |
| `degenerate` | 命中 §3.2 退化判据 | 2 |
| `short_body` | `L < 20`（对齐入库下限 `MIN_CONTENT_CHARS`，`services/news-crawler-py/src/news_crawler/normalize.py:11`） | 2 |
| `dup_hash` | 命中哈希重复组 | 1 |
| `nav_hit` | 命中导航词表 | 1 |
| `empty_date` | 发布日期为空 | 1 |

样本行的 `score` 为其命中缺陷码权重之和；一条样本可同时命中多个缺陷码。

### 6.2 排序键与条数上限

- 排序键（确定性，逐级兜底）：`(-score, L 升序, id 升序)`；`id` 为表内 `id` 列，保证同分同长时结果稳定。
- 每源取前 `--samples-per-source` 条，默认 3，范围 0..10；`n = 0` 时 `samples` 为空数组。

### 6.3 预览截断

| 字段 | 截断规则 | 截断标记 |
|---|---|---|
| `contentPreview` | `content` 前 200 个 Python 码点 | `truncated = len(content) > 200` |
| `summaryPreview` | `summary` 前 120 个 Python 码点 | `summaryTruncated = len(summary) > 120` |

`contentPreview` 不追加省略号字符；是否截断由布尔标记表达。样本只带预览，不在报告里贴全文。

## 7. 结论枚举与最差源排序

### 7.1 结论枚举

| JSON `verdict` | Markdown 中文展示 | 含义 |
|---|---|---|
| `keep` | 保留 | 未命中任何下线 / 降级判据；或 `n < 3` 护栏强制保留。 |
| `downgrade` | 降级为只取标题摘要 | 未命中下线，但命中 §4.3 任一条降级判据。 |
| `offline` | 下线 | 命中 §4.2 任一条下线判据。 |

### 7.2 `verdictReasons` 形态

`verdictReasons` 为越线判据清单，元素形如 `degenerateRatio>=0.20 (0.3333)`：先写判据名与阈值，括号内为该源实测比例（保留 4 位）。护栏触发时写明样本不足原因；`keep` 且无越线记录时清单为空数组。

### 7.3 `worstSources` 排序规则

1. 严重度降序：`offline=3`、`downgrade=2`、`keep=1`。
2. 同档内按 `defectRatio` 降序；`defectRatio = min(1, degenerateRatio + navHitRatio + duplicateHashRatio + emptyTitleRatio + emptyDateRatio)`，其中 `null` 按 0 计，输出 `round(..., 4)`。
3. 再同档按 `source` 字典序升序兜底。
4. `worstSources` 取前 `--top` 条，默认 5，范围 1..50；源数不足时数组相应变短，不补空项。

## 8. 导航词表 `NAV_TERMS`

### 8.1 词表全文（v1 冻结，共 17 个词）

| 序号 | 词 |
|---|---|
| 1 | 广告 |
| 2 | 点击查看 |
| 3 | 相关阅读 |
| 4 | 相关推荐 |
| 5 | 扫码下载 |
| 6 | 下载APP |
| 7 | 下载 App |
| 8 | 免责声明 |
| 9 | 版权所有 |
| 10 | 举报 |
| 11 | 微信公众号 |
| 12 | 上一篇 |
| 13 | 下一篇 |
| 14 | 返回首页 |
| 15 | 登录后查看 |
| 16 | 扫码关注 |
| 17 | 转载请注明出处 |

### 8.2 匹配方式

- 纯子串匹配：`any(term in content for term in NAV_TERMS)`，命中即计数。
- 区分大小写；不做分词、不做同义词扩展、不做正则匹配。
- 词表在脚本内以固定顺序的常量保存，保证两次运行结果一致；不在脚本外散落第二份词表。
- 命中样本在 `defects` 中标 `nav_hit`，并可在样本预览里对照命中词复盘。

### 8.3 词表维护

这是 v1 冻结词表。扩充、删除或修改词属于契约变更：需要先改 `02-contract.md` §2.2(3) 口径并登记变更记录（见 §12），再同步脚本常量与本文词表；不允许在报告配置或脚本调用侧临时加减词。

## 9. 报告形态

### 9.1 顶层 `QualityReport` 字段

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `schemaVersion` | string | 否 | 固定 `"1.0"`。 |
| `generatedAt` | string | 是 | ISO-8601 UTC，`YYYY-MM-DDTHH:MM:SS.sssZ`；确定性复跑时剔除该字段。 |
| `elapsedMs` | int | 否 | 墙钟毫秒；确定性复跑时剔除该字段。 |
| `dbPath` | string | 否 | 实际打开的库路径（解析后）。 |
| `dbReadable` | bool | 否 | 恒 `true`；库不可读退出 1 时不产出本结构。 |
| `totals` | object | 否 | `{articles: int, sources: int, sourcesWithData: int}`；`articles` 为 `news_articles` 总行数，`sources` 为出现过的 `source` 去重数，`sourcesWithData` 为有文章的源数。 |
| `global` | object | 否 | 全库汇总五类比例（`degenerateRatio` / `navHitRatio` / `duplicateHashRatio` / `emptyTitleRatio` / `emptyDateRatio`），口径同 §3，`null` 规则相同。 |
| `sources` | `SourceReport[]` | 否 | 按 `source` 字典序排列。 |
| `worstSources` | `WorstSource[]` | 否 | 排序规则见 §7.3。 |
| `warnings` | string[] | 否 | 非致命提示；空表、样本不足、未知源等。 |

### 9.2 `SourceReport` 字段

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `source` | string | 否 | 表内 `source` 列原值。 |
| `sampleSize` | int | 否 | 该源文章条数 `n`。 |
| `length` | object | 否 | `{p10: number\|null, p50: number\|null, p90: number\|null}`。 |
| `degenerateRatio` | number\|null | 是 | §3.2。 |
| `navHitRatio` | number\|null | 是 | §3.3。 |
| `duplicateHashRatio` | number\|null | 是 | §3.4。 |
| `emptyTitleRatio` | number\|null | 是 | §3.5。 |
| `emptyDateRatio` | number\|null | 是 | §3.5。 |
| `verdict` | string | 否 | `keep` / `downgrade` / `offline`；Markdown 展示见 §7.1。 |
| `verdictReasons` | string[] | 否 | 越线判据清单，元素形如 `degenerateRatio>=0.20 (0.3333)`；护栏触发时写明样本不足原因。 |
| `warnings` | string[] | 否 | 该源专属警告（如样本不足、缺 `content_hash` 列）。 |
| `samples` | `Sample[]` | 否 | ≤ `--samples-per-source`；`n=0` 时为空数组。 |

### 9.3 `Sample` 字段

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | 否 | 表内 `id`。 |
| `source` | string | 否 | 表内 `source`。 |
| `title` | string | 否 | `title`，空串允许。 |
| `url` | string | 否 | `url`。 |
| `publishedAt` | string | 否 | `published_at`，空串允许。 |
| `contentStatus` | string | 否 | `content_status` 原值（`full` / `partial` / 空串）。 |
| `contentPreview` | string | 否 | `content` 前 200 个码点；不追加省略号字符。 |
| `truncated` | bool | 否 | `len(content) > 200`。 |
| `summaryPreview` | string | 否 | `summary` 前 120 个码点。 |
| `summaryTruncated` | bool | 否 | `len(summary) > 120`。 |
| `defects` | string[] | 否 | 命中的缺陷码，取值见 §6.1 表。 |

### 9.4 `WorstSource` 字段

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `rank` | int | 否 | 1 起序号，与数组下标一致。 |
| `source` | string | 否 | 源 ID。 |
| `verdict` | string | 否 | 同 §9.2。 |
| `sampleSize` | int | 否 | 该源条数。 |
| `defectRatio` | number | 否 | §7.3 计算值，`round(..., 4)`。 |
| `reasons` | string[] | 否 | 复制自 `verdictReasons`。 |

### 9.5 口径范围：全库口径与过滤口径

| 区块 | 口径范围 |
|---|---|
| `totals`、`global` | 全库口径，不受 `--source` 过滤影响。 |
| `sources`、`worstSources` | 受 `--source` 过滤；`--source` 可重复，库内不存在的名字不报错，写入警告「未在库内找到来源：`<id>`。」 |

### 9.6 Markdown 报告骨架

报告顺序固定为四段：

1. **头部摘要**：生成时间、数据库路径、文章总数、来源数。
2. **最差 `<N>` 个来源表**：排名 / 来源 / 结论 / 样本数 / P50 正文 / 重合率 / 导航命中 / 哈希重复 / 空标题 / 空日期 / 主要问题；表格列顺序固定，比例为空时显示 `—`。
3. **各源明细**：逐源小节，列样本数、P10/P50/P90、五类比例、主要问题，以及样本列表（标题、URL、日期、状态、正文预览）。
4. **口径摘要**：引用本文阈值表；Markdown 是人读产物，字段以 JSON 契约为准。

### 9.7 确定性规则

- SQL 取数带 `ORDER BY`；所有 Python 排序都有 §6.2 / §7.3 的显式兜底键，不依赖字典插入序。
- 比例 `round(..., 4)`；分位数 `round(..., 2)`；长度为整数。
- JSON 序列化：`json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True)`，键名顺序固定为字典序。
- 唯一允许两次运行不同的字段：`generatedAt`、`elapsedMs`。
- 脚本内不使用随机数、不读当前进程号、不写带 PID 的临时文件名。
- 运行环境：Python `>=3.12,<3.14`（`services/news-crawler-py/pyproject.toml:5`），仅使用标准库，不新增第三方依赖。

## 10. 复核方法

### 10.1 复跑命令（PowerShell 7，仓库根 `<仓库根>`）

```powershell
cd <仓库根>

# 最简：库路径走环境变量或默认 .data/news.db，Markdown 打到 stdout
.\.venv\Scripts\python.exe services\news-crawler-py\scripts\quality_report.py

# 指定副本库，Markdown 与 JSON 双产物落盘
.\.venv\Scripts\python.exe services\news-crawler-py\scripts\quality_report.py `
  --db .scratch\run\B\home\news.db `
  --md-out .scratch\run\B\report.md `
  --json-out .scratch\run\B\report.json

# 只看指定来源（--source 可重复）；调整样本条数与最差源条数
.\.venv\Scripts\python.exe services\news-crawler-py\scripts\quality_report.py `
  --db .scratch\run\B\home\news.db `
  --source jiemian --source socialbeta `
  --samples-per-source 5 --top 10 --json-out .scratch\run\B\report.json
```

### 10.2 逐条复核步骤

1. **换参数复跑**：用 `--samples-per-source`、`--top`、`--source` 调整样本条数、最差源条数与来源范围，确认报告随参数变化的部分符合 §6、§7 规则，`totals` 与 `global` 不随 `--source` 变化（§9.5）。
2. **回库重算长度**：取 `samples[].id`，在只读连接下回库查原始 `content`，用 Python `len(content)` 重算码点长度，与报告中的长度分位数、`truncated` / `summaryTruncated` 标记对账。
3. **对照缺陷与权重**：按 §6.1 表核对每条样本的 `defects`：空标题、退化、短正文（`L < 20`）、哈希重复、导航命中、空日期是否判对；`score` 为命中权重之和，样本排序应符合 `(-score, L 升序, id 升序)`。
4. **JSON 与 Markdown 交叉核对**：`worstSources` 的源名单与顺序应与 Markdown 头部最差源表一致；严重度、`defectRatio`、`source` 兜底三级排序符合 §7.3。
5. **确定性复跑**：同一副本连跑两次，剔除顶层 `generatedAt`、`elapsedMs` 后做 JSON 深比较，必须完全相等；Markdown 剔除生成时间行后逐行一致（§9.7）。

### 10.3 退出码与中文消息

中文消息是产品契约，逐字匹配；英文异常堆栈只进内部记录，不上屏、不写进报告 JSON。

| 退出码 | 类别 | 中文消息（逐字） | 触发条件 |
|---|---|---|---|
| 2 | 参数错 | `--top 必须是 1 到 50 的整数。` | `--top` 非整数或越界（1..50）。 |
| 2 | 参数错 | `--samples-per-source 必须是 0 到 10 的整数。` | `--samples-per-source` 非整数或越界（0..10）。 |
| 2 | 参数错 | `数据库路径不能为空。` | `--db` 与 `NEWS_CRAWLER_DB` 解析后均为空。 |
| 2 | 参数错 | `未识别的参数：<arg>。` | 传入脚本未声明的 CLI 参数。 |
| 1 | 库不可读 | `数据库打不开：<path>，请检查文件是否存在且为 SQLite 库。` | 文件不存在、不可读、不是 SQLite 文件，或 `--db` 指向一个目录。 |
| 1 | 库不可读 | `数据库里没有 news_articles 表，无法统计。` | 连接成功但缺表；不执行建表 DDL。 |
| 1 | 库不可读 | `数据库读取失败：<error>。` | 查询 / 分组过程中抛出的其他数据库异常；`<error>` 取异常类名。 |
| 0 | 警告（非错误） | `库内新闻文章为 0 条，报告指标全部为空。` | 表存在但 0 行；报告照常产出，指标为 `null`。 |
| 0 | 警告（非错误） | `来源 <id> 样本不足 3 条（n=<n>），结论仅供参考。` | 该源 `n < 3`；结论按护栏强制保留。 |
| 0 | 警告（非错误） | `未在库内找到来源：<id>。` | `--source` 名字在库内无匹配。 |

退出码语义：0 = 库可读且完成分析（含空表）；1 = 库不可读 / 缺表；2 = 参数错；`KeyboardInterrupt` 沿用现状退出 130（`services/news-crawler-py/src/news_crawler/cli.py:362`）。内容质量不达标不导致非零退出：非零只代表脚本没跑成；B 的 1 只表示库不可读，与采集 CLI 的 1（采集有失败，`services/news-crawler-py/src/news_crawler/cli.py:128`）不混用。

## 11. 已知局限与验证方法

| # | 局限 | 为什么发生 | 验证方法 |
|---|---|---|---|
| 1 | **小样本不稳**：`n < 3` 的源分位数与比例指标波动大；即使 `n` 稍大于 3，P10/P90 在短列表上也可能偏移。 | 线性插值在短样本上对单条极端值敏感；护栏只强制 `keep`，不修正指标数值。 | 用 `n=0/1/2/3` 四档夹具库分别跑报告：`n=0` 指标全 `null`；`n=1` 三个分位数同取该条长度；`n<3` 结论强制 `keep` 且带样本不足警告；对同一小源手工重算 P50 与报告对账。 |
| 2 | **导航词表不全**：固定 17 词可能漏掉某源特有的模板噪声（其他免责声明样式、推广位、相关阅读模块变体），导航命中率偏低。 | v1 不做可配置词表，不做分词或同义词扩展；词表是脚本内冻结常量。 | 抽 `nav_hit` 命中样本看 `contentPreview` 与 `defects`；再抽查未命中样本正文，记录漏网模板措辞；增补走 §8.3 契约变更流程，不在调用侧临时加词。 |
| 3 | **源 ID 无中文名映射**：报告以库内 `source` 原值分组，不 import 注册表，拿不到 `SourceDescriptor.name`；展示名缺失时原样显示 ID。 | 离线副本库可能缺注册表元数据，或注册表后来改名；脚本不依赖注册表即可跑（对照现有 CLI 对照注册表校验源的做法，`services/news-crawler-py/src/news_crawler/cli.py:77-83`）。 | 对照注册表把报告里的源 ID 翻译成中文名核对；若库内含已停用源的历史行，报告同样按 ID 列出，需要中文名时由消费方对照注册表补齐。 |
| 4 | **WAL 快照读**：读到的是打开时刻的提交快照，可能不是最新一帧；副本漏拷 `-wal` / `-shm` 会读到旧状态。 | SQLite WAL 下主库与 WAL 副件分离；脚本只读打开，不触发 checkpoint、不加锁。 | 复制时连同 `-wal`、`-shm` 一起拷到隔离目录；比对 `.backup` 快照与报告行数；两次运行之间库被写入导致数字变化时，在 `warnings` 注明读取时刻快照，不以逐字节相同为由重试加锁。 |
| 5 | **阈值 v1 未大样本校准**：0.10 / 0.20 / 0.30 / 0.50 与 50 / 100 / 200 字长度阈值为首版审计带，现有样本量有限，可能偏松或偏紧。 | 阈值锚定既有 20 / 300 / 1000 常量，比例阈值属人工经验值；尚未在多份大样本库上回归。 | 在多份副本库上试跑，逐条核对被标下线 / 降级源的样本；校准结论回填本文并升契约版本；本轮不把阈值写成经验定论。 |
| 6 | **旧库缺 `content_hash` 列**：旧库未跑列迁移时，该源 `duplicateHashRatio` 返回 `null`，并在该源 `warnings` 注明，不报错退出。 | 列迁移归采集侧（`services/news-crawler-py/src/news_crawler/db.py:59-62`、`services/news-crawler-py/src/news_crawler/db.py:78-84`），B 不执行迁移。实例：`.scratch/run/B/legacy.db` 含 3 行 `news_articles`，列清单中无 `content_hash`。 | 用 `PRAGMA table_info(news_articles)` 核对旧库列；对缺列库跑报告，确认 `duplicateHashRatio` 为 `null`、源警告已注明、其余指标正常产出。 |

## 12. 版本与变更登记

- `schemaVersion` 固定 `"1.0"`；消费方解析 JSON 时必须容忍未知额外字段，不得因多字段报错。
- 新增 JSON 字段一律可选，允许向后兼容地增加字段。
- 删除字段、改字段类型、调整阈值数值、修改 `NAV_TERMS` 词表，视为破坏性变更：必须升 `schemaVersion`，在本文与 `02-contract.md` 登记变更内容、日期与理由，不在脚本里静默改数。
- 本文与样例 JSON（`services/news-crawler-py/docs/quality-report.sample.json`）随脚本一起交付；样例结构与 §9 字段表逐字段对照。

## 参考

- trafilatura — https://github.com/adbar/trafilatura — 长度 / 导航噪声 / 重复三类质量信号划分；不引入其 HTML 抽取器。
- python-readability — https://github.com/buriy/python-readability — 正文≈摘要即抽取失败的退化判据；不引入解析库。
- newspaper — https://github.com/codelucas/newspaper — 按源聚合 + 样本回溯的报告形态；不引入抓取栈。
- SQLite STRICT tables — https://www.sqlite.org/stricttables.html — `NOT NULL DEFAULT ''` 下空串即空值的假设；不改表结构。
- SQLite Online Backup API — https://www.sqlite.org/backup.html — 一致性快照读取与副本要求；B 不调用备份 API。
- dedupeio/dedupe — https://github.com/dedupeio/dedupe — 精确哈希分组边界；不引入实体解析。
- google-research/deduplicate-text-datasets — https://github.com/google-research/deduplicate-text-datasets — 只做精确 `content_hash` 分组；不引入 MinHash 流水线。
- CamDavidsonPilon/tdigest — https://github.com/CamDavidsonPilon/tdigest — 小样本不用近似 sketch，全量线性插值。
- ankane/active_median — https://github.com/ankane/active_median — 对数组直接算分位数的实现形态；不引入其 ORM 与 Ruby 栈。
