# B · 新闻正文质量抽检 · 契约

> 轮次：B · 新闻正文质量抽检
> 文档角色：02-contract
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1（本文件只细化，不新增冻结错误码、不改端口与环境变量名）
> 写权：[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1
> 一句话：指标怎么算、阈值是多少、JSON 长什么样、CLI 怎么调、出错退什么码，全部在这份文件里钉死；实现者不允许自创口径。

## 1 契约总览

| 层 | 冻结 / 现状 | 本轮细化 |
|---|---|---|
| 数据源 | `news_articles` 表结构（`db.py:25-31`）、默认库 `.data/news.db`（`query.py:49-51`） | 只读 URI 打开方式、分组键、空值兜底规则（§2.1） |
| 指标口径 | 入库既有常量 20 / 300 / 1000（`normalize.py:11-12`、`:54`、`:81`） | 五类指标的精确公式、分位数插值方法、保留位数（§2.2） |
| 结论枚举 | README 原始口径：保留 / 降级为只取标题摘要 / 下线 | 三档阈值表、判据顺序、样本选取键（§2.3、§2.4） |
| 输出形态 | README 原始口径：Markdown 报告 + JSON；最差 5 源；同库复跑一致 | JSON schema 逐字段、Markdown 骨架、确定性规则（§3、§2.5、§2.7） |
| 退出码 | 现有 CLI 0/1/2/130 分层（`cli.py:121`、`:128`、`:362`） | B 语义：0 有数据 / 1 库不可读 / 2 参数错（§4） |
| 依赖 | 第三方仅 `httpx/beautifulsoup4/lxml`（`pyproject.toml:6-10`） | 脚本只用标准库，不新增依赖（§6.3） |

**契约稳定性**：本文件的字段名、指标名、阈值数值、退出码、中文消息视为 v1 冻结。新增 JSON 字段允许（消费方必须容忍未知字段）；删改字段或调整阈值需要升 `schemaVersion` 并登记变更。指标分组借鉴正文抽取质量评测的三类信号（长度、噪声、重复）[R1]；B 不引入抽取器本身。

## 2 指标定义与阈值

### 2.1 读取作用域与空值兜底

- 数据源：SQLite 文件中的 `news_articles` 表；`source_runs` 不在本轮指标范围内。
- 分组键：`source` 列；SQL 侧 `GROUP BY source`，行级取数 `ORDER BY id`，保证取数顺序确定。
- 只读连接：`sqlite3.connect("file:<path>?mode=ro", uri=True)`，随后 `PRAGMA query_only=ON`；不执行 `journal_mode`、不建表、不跑列迁移（对照带副作用的 `db.connect()`，`db.py:65-75`）。
- 空值兜底（与 `query.py:99-114` 出参一致）：`content`/`summary`/`title`/`published_at` 为 `NULL` 时按空串处理；`content_status` 为空串时报告原样保留空串。
- 长度单位：Python 码点数（`len()`），不按 UTF-8 字节、不二次清洗；入库文本已由 `normalize.py:35-41` 清洗归一。

### 2.2 五类指标（逐源，公式钉死）

设某源有 `n` 条文章，第 `i` 条正文长度 `L(i) = len(content_i)`。

**(1) 正文长度 P10 / P50 / P90**

- 将 `L` 升序排列为 `x[0..n-1]`。
- `n = 0`：三个分位数均为 `null`。
- `n = 1`：`P10 = P50 = P90 = x[0]`。
- `n ≥ 2`：对 `p ∈ {0.10, 0.50, 0.90}`，令 `h = (n - 1) * p`，`i = floor(h)`，`f = h - i`，则
  `Q(p) = x[i] + f * (x[i+1] - x[i])`。
- 插值方法：线性插值（含端点，等价 Hyndman–Fan 方法 7 / NumPy 默认 `linear`）；在 Python 端排序后计算，不用 SQLite 窗口函数，避免不同 SQL 方言插值口径漂移 [R8]。
- 输出：`round(Q(p), 2)`，类型 `number | null`。

**(2) 正文≈摘要比例 `degenerateRatio`**

一条文章计入「退化」当且仅当同时满足：

1. `summary.strip()` 非空且 `content.strip()` 非空；
2. `len(summary) >= 0.80 * len(content)`；
3. `summary in content` 或 `content in summary`（去空白后精确子串匹配）。

`degenerateRatio = 退化条数 / n`；`n = 0` 为 `null`；`round(..., 4)`。
判据来源：正文与摘要高度重叠说明详情抽取退化成了摘要搬运 [R2]。

**(3) 导航词命中率 `navHitRatio`**

冻结词表 `NAV_TERMS`（脚本内常量，纯子串匹配，区分大小写，不做分词）：

```text
广告, 点击查看, 相关阅读, 相关推荐, 扫码下载, 下载APP, 下载 App, 免责声明,
版权所有, 举报, 微信公众号, 上一篇, 下一篇, 返回首页, 登录后查看, 扫码关注, 转载请注明出处
```

`navHitRatio = 命中至少一个词的条数 / n`；`n = 0` 为 `null`；`round(..., 4)`。命中样本必须在 `defects` 与样本预览里可复核命中词。

**(4) `content_hash` 重复率 `duplicateHashRatio`**

-  eligible 行：`content_hash.strip()` 非空的行；空哈希行不参与分组，也不计入分母。
- 按哈希分组；组内行数 `≥ 2` 时，该组所有成员记为重复行。
- `duplicateHashRatio = 重复行数 / eligible 行数`；eligible 为 0 时为 `null`；`round(..., 4)`。
- 哈希口径沿用入库侧：`sha256(content utf-8)` 十六进制摘要（`output.py:91`）；只做精确哈希分组，不做模糊匹配或 MinHash [R6][R7]。

**(5) 空标题比例 `emptyTitleRatio` / 空日期比例 `emptyDateRatio`**

- `emptyTitleRatio = count(title.strip() == '') / n`。
- `emptyDateRatio = count(published_at.strip() == '') / n`。
- `n = 0` 为 `null`；均 `round(..., 4)`。空日期是合法可落库状态（`normalize.py:53`），不是解析错误。

### 2.3 最差样本选取（每源 ≤3 条）

行级缺陷码与权重：

| 缺陷码 | 含义 | 权重 |
|---|---|---|
| `empty_title` | 标题为空 | 3 |
| `degenerate` | 命中 §2.2(2) 退化判据 | 2 |
| `short_body` | `L < 20`（对齐入库下限 `MIN_CONTENT_CHARS`，`normalize.py:11`、`:40-41`） | 2 |
| `dup_hash` | 命中哈希重复组 | 1 |
| `nav_hit` | 命中导航词表 | 1 |
| `empty_date` | 发布日期为空 | 1 |

排序键（确定性，逐级兜底）：`(-score, L 升序, id 升序)`；取前 `--samples-per-source` 条（默认 3，范围 0..10）。`id` 为表内 `id` 列，保证同分同长时结果稳定。

### 2.4 结论阈值表（保留 / 降级 / 下线）

**样本护栏**：`n < 3` 时，结论强制 `keep`（保留），并写入警告「样本不足 3 条（n=<n>），结论仅供参考。」；阈值越线情况仍记入 `verdictReasons`，但不升级为降级 / 下线。

**下线 `offline`**（命中任意一条）：

| 判据 | 阈值 | 理由 |
|---|---|---|
| `emptyTitleRatio ≥ 0.20` | 空标题超过两成 | 标题是检索与展示的主键，两成以上空标题说明源详情页基本不可用 |
| `duplicateHashRatio ≥ 0.30` | 哈希重复超过三成 | 三分之一以上正文与同源其他条目雷同，源内容不具备增量价值 |
| `degenerateRatio ≥ 0.50` | 退化条目超过半数 | 半数以上正文只是摘要搬运，详情抽取失败面过大 [R2] |
| `length.p50 < 50` | 半数正文不足 50 字 | 50 字低于摘要兜底后的基本可用长度，与 20 字入库下限相邻（`normalize.py:11`） |

**降级 `downgrade`**（未命中下线，且命中任意一条）：

| 判据 | 阈值 | 理由 |
|---|---|---|
| `length.p10 < 100` | 最差十分位正文不足 100 字 | 尾部条目过薄，前端只能取标题摘要 |
| `degenerateRatio ≥ 0.20` | 退化条目 ≥ 两成 | 局部详情抽取退化，先按标题摘要源使用 |
| `navHitRatio ≥ 0.20` | 导航/广告噪声 ≥ 两成 | 正文混入模板噪声，可读性不足 |
| `emptyDateRatio ≥ 0.30` | 空日期 ≥ 三成 | 时间排序与新鲜度判断不可靠（空日期排末尾，`QUERY-API.md:60`） |
| `duplicateHashRatio ≥ 0.10` | 哈希重复 ≥ 一成 | 存在同质化条目，需人工复核 |
| `length.p50 < 200` | 半数正文不足 200 字 | 介于摘要兜底与 300 字 `full` 分界（`normalize.py:12`、`:54`；`query.py:46`）之间，整体偏短 |

**保留 `keep`**：未命中上述任何一条。

阈值锚点说明：20 / 300 / 1000 三个数直接来自入库既有常量；0.10 / 0.20 / 0.30 / 0.50 为 v1 审计带，首版校准证据由验收轮次在 `.scratch` 副本库上实测回填；调整任一数值属于契约变更。`content_status` 的 `full/partial`（1000 字分界，`normalize.py:81`）只作样本旁证，不进判据。

### 2.5 最差 5 源排序

- 严重度：`offline=3`、`downgrade=2`、`keep=1`，按严重度降序。
- 同档内按 `defectRatio` 降序；`defectRatio = min(1, degenerateRatio + navHitRatio + duplicateHashRatio + emptyTitleRatio + emptyDateRatio)`，`null` 按 0 计。
- 再同档按 `source` 字典序升序兜底。
- `worstSources` 取前 `--top` 条（默认 5，范围 1..50）；源数不足时数组相应变短，不补空项。

### 2.6 CLI 参数

```powershell
cd E:\Documents\GitHub\YingXiaoShang\services\news-crawler-py
python scripts/quality_report.py --db .scratch/run/B/home/news.db --json-out .scratch/run/B/news-quality.json
```

| 参数 | 类型 | 必填 | 默认 | 边界与校验 |
|---|---|---|---|---|
| `--db PATH` | string | 否 | 环境变量 `NEWS_CRAWLER_DB`；未设则 `<服务根>/.data/news.db`（服务根 = `scripts/` 的上一级，对齐 `cli.py:21`、`query.py:49-51`） | 路径解析后为空 → 退出 2 |
| `--source ID` | string，可重复 | 否 | 全部源 | 库内不存在的名字不报错，写入警告「未在库内找到来源：<id>」 |
| `--md-out PATH` | string | 否 | 无（Markdown 打到 stdout，`--quiet` 时不打） | 父目录不存在则创建 |
| `--json-out PATH` | string | 否 | 无（不写 JSON 文件） | 父目录不存在则创建 |
| `--top N` | int | 否 | `5` | 1..50；越界 / 非整数 → 退出 2 |
| `--samples-per-source N` | int | 否 | `3` | 0..10；越界 / 非整数 → 退出 2 |
| `--quiet` | flag | 否 | 关 | 抑制 stdout Markdown；不影响 `--json-out` 落盘 |

脚本不接受采集类参数（`--workers`、`--browser`、`--output` 等）；传入未知参数由 `argparse` 退出 2。

### 2.7 确定性规则（同库两次运行一致）

1. SQL 取数带 `ORDER BY`；所有 Python 排序都有 §2.3 / §2.5 的显式兜底键，不依赖字典插入序。
2. 比例 `round(..., 4)`；分位数 `round(..., 2)`；长度为整数。
3. JSON 序列化：`json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True)`；键名顺序固定为字典序。
4. 唯一允许两次运行不同的字段：`generatedAt`（生成时间）、`elapsedMs`（墙钟耗时）。
5. 复跑一致性判定：剔除上述两个字段后做 JSON 深比较，必须完全相等；Markdown 报告除「生成时间」一行外逐行一致。
6. 脚本内不使用随机数、不读当前进程号、不写临时文件名带 PID。

## 3 数据结构（JSON Schema 逐字段）

字段命名沿用库内 snake_case 列名，不另起一套 camelCase；对象结构按「顶层 → 源报告 → 样本 → 最差源」分层，便于消费方按需解析 [R3]。

### 3.1 顶层 `QualityReport`

| 字段 | 类型 | 可空 | 来源 / 说明 |
|---|---|---|---|
| `schemaVersion` | string | 否 | 固定 `"1.0"` |
| `generatedAt` | string | 是 | ISO-8601 UTC，`YYYY-MM-DDTHH:MM:SS.sssZ`；确定性复跑时剔除该字段 |
| `elapsedMs` | int | 否 | 墙钟毫秒；确定性复跑时剔除该字段 |
| `dbPath` | string | 否 | 实际打开的库路径（解析后） |
| `dbReadable` | bool | 否 | 恒 `true`；退出 1 时不产出本结构 |
| `totals` | object | 否 | `{articles: int, sources: int, sourcesWithData: int}`；`articles` = `news_articles` 总行数，`sources` = 出现过的 `source` 去重数，`sourcesWithData` = 有文章的源数 |
| `global` | object | 否 | 全库汇总五类比例（`degenerateRatio/navHitRatio/duplicateHashRatio/emptyTitleRatio/emptyDateRatio`），口径同 §2.2，`null` 规则相同 |
| `sources` | `SourceReport[]` | 否 | 按 `source` 字典序排列 |
| `worstSources` | `WorstSource[]` | 否 | 排序规则见 §2.5 |
| `warnings` | string[] | 否 | 非致命提示；空表、样本不足、未知源等 |

### 3.2 `SourceReport`

| 字段 | 类型 | 可空 | 来源 / 说明 |
|---|---|---|---|
| `source` | string | 否 | 表内 `source` 列原值 |
| `sampleSize` | int | 否 | 该源文章条数 `n` |
| `length` | object | 否 | `{p10: number\|null, p50: number\|null, p90: number\|null}` |
| `degenerateRatio` | number\|null | 是 | §2.2(2) |
| `navHitRatio` | number\|null | 是 | §2.2(3) |
| `duplicateHashRatio` | number\|null | 是 | §2.2(4) |
| `emptyTitleRatio` | number\|null | 是 | §2.2(5) |
| `emptyDateRatio` | number\|null | 是 | §2.2(5) |
| `verdict` | string | 否 | `keep` / `downgrade` / `offline`；Markdown 展示为 保留 / 降级 / 下线 |
| `verdictReasons` | string[] | 否 | 越线判据清单，元素形如 `degenerateRatio>=0.20 (0.3333)`；护栏触发时写明样本不足原因 |
| `warnings` | string[] | 否 | 该源专属警告（如样本不足） |
| `samples` | `Sample[]` | 否 | ≤ `--samples-per-source`；`n=0` 时为空数组 |

### 3.3 `Sample`

| 字段 | 类型 | 可空 | 来源 / 说明 |
|---|---|---|---|
| `id` | string | 否 | 表内 `id` |
| `source` | string | 否 | 表内 `source` |
| `title` | string | 否 | `title`，空串允许 |
| `url` | string | 否 | `url` |
| `publishedAt` | string | 否 | `published_at`，空串允许 |
| `contentStatus` | string | 否 | `content_status` 原值（`full` / `partial` / 空串） |
| `contentPreview` | string | 否 | `content` 前 200 个码点；不追加省略号字符 |
| `truncated` | bool | 否 | `len(content) > 200` |
| `summaryPreview` | string | 否 | `summary` 前 120 个码点 |
| `summaryTruncated` | bool | 否 | `len(summary) > 120` |
| `defects` | string[] | 否 | 命中的缺陷码，取值见 §2.3 表 |

### 3.4 `WorstSource`

| 字段 | 类型 | 可空 | 来源 / 说明 |
|---|---|---|---|
| `rank` | int | 否 | 1 起序号，与数组下标一致 |
| `source` | string | 否 | 源 ID |
| `verdict` | string | 否 | 同 §3.2 |
| `sampleSize` | int | 否 | 该源条数 |
| `defectRatio` | number | 否 | §2.5 计算值，`round(..., 4)` |
| `reasons` | string[] | 否 | 复制自 `verdictReasons` |

### 3.5 Markdown 报告骨架

```text
# 新闻正文质量抽检报告

- 生成时间：<generatedAt>
- 数据库：<dbPath>
- 文章总数：<totals.articles>；来源数：<totals.sources>

### 最差 <N> 个来源

| 排名 | 来源 | 结论 | 样本数 | P50 正文 | 重合率 | 导航命中 | 哈希重复 | 空标题 | 空日期 | 主要问题 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

### 各源明细

#### <source>（结论：保留 / 降级 / 下线）

- 样本数：<sampleSize>；P10/P50/P90：<p10> / <p50> / <p90>
- 重合率 <degenerateRatio>；导航命中 <navHitRatio>；哈希重复 <duplicateHashRatio>；空标题 <emptyTitleRatio>；空日期 <emptyDateRatio>
- 主要问题：<verdictReasons，逐条>

样本 1：<title>
- URL：<url>；日期：<publishedAt>；状态：<contentStatus>
- 正文（截断 200 字）：<contentPreview>…

### 口径与阈值

（引用 docs/news-source-quality.md 的阈值表；本文件只放摘要，不复制完整方法学）
```

Markdown 是人读产物，字段以 JSON 契约为准；表格列顺序固定，比例为空时显示 `—`。

## 4 错误与消息

中文消息是产品契约，逐字匹配；英文异常堆栈只进内部记录，不上屏、不写进报告 JSON。错误分类按「失败语义」划分，不按抛出模块划分，同类失败在不同源下共用同一消息 [R4]。

| 退出码 | 类别 | 中文消息（逐字） | 触发条件 | 调用方应做什么 |
|---|---|---|---|---|
| 2 | 参数错 | `--top 必须是 1 到 50 的整数。` | `--top` 非整数或越界 | 修正参数后重跑 |
| 2 | 参数错 | `--samples-per-source 必须是 0 到 10 的整数。` | 同上规则 | 修正参数后重跑 |
| 2 | 参数错 | `数据库路径不能为空。` | `--db` 与 `NEWS_CRAWLER_DB` 解析后均为空 | 显式传 `--db` |
| 2 | 参数错 | `未识别的参数：<arg>。` | 传入脚本未声明的 CLI 参数（`argparse` 兜底） | 对照 §2.6 参数表修正 |
| 1 | 库不可读 | `数据库打不开：<path>，请检查文件是否存在且为 SQLite 库。` | 文件不存在、不可读、或不是 SQLite 文件（`OperationalError` / `DatabaseError`） | 检查路径与文件权限；不自动建库 |
| 1 | 库不可读 | `数据库里没有 news_articles 表，无法统计。` | 连接成功但缺表（`sqlite_master` 查询无命中） | 确认是否拷错库；不执行建表 DDL |
| 1 | 库不可读 | `数据库读取失败：<error>。` | 查询 / 分组过程中抛出的其他数据库异常 | 记录 `<error>` 分类，交实现者排查；不重试写库 |
| 0 | 警告（非错误） | `库内新闻文章为 0 条，报告指标全部为空。` | 表存在但 0 行 | 报告照常产出，指标为 `null` |
| 0 | 警告（非错误） | `来源 <id> 样本不足 3 条（n=<n>），结论仅供参考。` | 该源 `n < 3` | 结论按护栏强制保留 |
| 0 | 警告（非错误） | `未在库内找到来源：<id>。` | `--source` 名字在库内无匹配 | 检查源 ID 拼写 |

退出码语义对照：现有采集 CLI 的 1 表示采集有失败（`cli.py:128`），B 的 1 只表示「库不可读」，两者不混用；`KeyboardInterrupt` 沿用现状退出 130（`cli.py:362`），不在本脚本契约内重新定义。

## 5 事件与序列

B 是一次性 CLI，无 SSE、无长连接、无网络事件。只读快照的打开与关闭遵循一致性读取约束：连接期间不触发 checkpoint、不持有写锁 [R5]。执行序列（文字版时序）：

```text
t0  解析 CLI 参数 → 整数/边界校验；失败 → 退出 2（§4）
t1  解析库路径（--db > NEWS_CRAWLER_DB > 默认 .data/news.db）
t2  检查文件可读 → 失败 → 退出 1「数据库打不开」
t3  以 mode=ro 打开连接，PRAGMA query_only=ON；检查 news_articles 表
    → 缺表 → 退出 1「没有 news_articles 表」
t4  统计总行数；按 source 分组取数（ORDER BY id）
    → 查询异常 → 退出 1「数据库读取失败」
t5  逐源计算 §2.2 指标 → 行级缺陷打分 → 样本选取 → 结论阈值判定
t6  计算 global 汇总；生成 worstSources 排序
t7  渲染 Markdown / 组装 JSON；按 --md-out / --json-out 落盘（父目录按需创建）
t8  关闭连接 → 退出 0
```

分支约束：

- t3–t8 全程不出现 `INSERT/UPDATE/DELETE/CREATE/ALTER/DROP`；代码评审与只读夹具双向核验。
- 任一警告在 t5/t6 产生后继续执行，不中断报告。
- 落盘只写 §2.6 指定的两个产物路径；不写库目录、不写 `.learning-agent`。
- 时序中无「调用采集、等待侧车、重试网络」环节；脚本离线可跑。

## 6 兼容与版本

兼容口径以库内既有列与既有常量为准；脚本不假设下游打标表存在，也不把本轮的精确哈希分组扩展成近重复识别 [R7]。

### 6.1 Schema 版本

- `schemaVersion` 固定 `"1.0"`；消费方解析 JSON 时必须容忍未知额外字段，不得因多字段报错。
- 新增字段一律可选；删除字段、改字段类型、调整阈值数值，视为破坏性变更，升 `schemaVersion` 并在方法学文档登记。

### 6.2 与现有库结构的兼容

- 脚本按列名读取，不依赖列顺序；旧库缺 `content_hash` 列时，`duplicateHashRatio` 返回 `null` 并在该源 `warnings` 注明，不报错退出（列迁移归采集侧 `db.py:78-84`，B 不执行）。
- 表结构以 `db.py:25-31` 为准；B 不假设 `news_tags` 等下游表存在（`output.py:77` 仅在写路径做条件删除，只读报告不引用）。
- 输入库可以是任意快照副本；脚本不要求 WAL 处于 checkpoint 状态，读到的是打开时刻的提交快照。

### 6.3 运行时兼容

- Python `>=3.12,<3.14`（`pyproject.toml:5`）；仅标准库，不引入 `httpx/bs4/lxml` 之外的新依赖，也不依赖浏览器兜底。
- 报告 JSON 必须能被标准库 `json.loads` 解析；不依赖第三方 schema 校验器。
- Markdown 方法学文档（`docs/news-source-quality.md`）与样例（`docs/quality-report.sample.json`）随脚本一起交付；样例 JSON 的结构必须与 §3 一致。

### 6.4 与其他轮次的兼容面

- 不向 A 的服务端、F 的指标体系暴露接口；B 产物是离线文件，后续轮次按需读取 JSON。
- C 的采集镜像不打包 `scripts/`；B 脚本只在宿主侧运行，不进镜像构建上下文产物。
- D 的 PG 迁移落地后，本脚本的 SQLite 口径不自动延伸；迁移工具另定方言映射。

## 7 契约测试映射

| 编号 | 契约点 | 断言 |
|---|---|---|
| B-T1 | §2.7 确定性 | 同一副本库连跑两次；剔除 `generatedAt`/`elapsedMs` 后 JSON 深比较相等；Markdown 除生成时间行外一致 |
| B-T2 | §4 空表 | 0 行库退出 0；五类比例全 `null`；`warnings` 含「0 条」提示 |
| B-T3 | §4 文件不可读 | 指向不存在路径 → 退出 1 +「数据库打不开」 |
| B-T4 | §4 缺表 | 建一张不含 `news_articles` 的 SQLite → 退出 1 +「没有 news_articles 表」 |
| B-T5 | §4 参数错 | `--top abc`、`--top 0`、`--samples-per-source 11` 各 → 退出 2 + 对应逐字消息 |
| B-T6 | §2.3 样本上限 | 构造某源 20 条缺陷行 → `samples` 长度 ≤3；排序符合 `(-score, L, id)` |
| B-T7 | §2.5 最差源 | 构造多源不同严重度 → `worstSources` 顺序符合严重度 → `defectRatio` → `source`；条数 ≤ `--top` |
| B-T8 | §2.4 阈值 | 按每条判据构造夹具，分别命中对应 `verdict` 与 `verdictReasons`；`n<3` 护栏强制 `keep` |
| B-T9 | §5 只读 | 运行前后比对库文件哈希 / mtime；不产生 `-wal`/`-shm` 写入；脚本源码无写库 SQL 关键字 |
| B-T10 | §2.6 未知源 | `--source 不存在的源` → 退出 0，`warnings` 含「未在库内找到来源」 |
| B-T11 | §2.2 分位数 | `n=1` 夹具：P10=P50=P90=该条长度；`n=2` 夹具：插值结果与手算值一致（保留 2 位） |
| B-T12 | §3 schema | 样例 `quality-report.sample.json` 可被 `json.loads`；顶层与 `SourceReport` 字段名 / 类型与 §3 表一致 |

用例组织沿用「一个编号一条断言、失败原因写在断言文本里」的方式；自测代码落地位置由后续 `03-implementation.md` / `04-acceptance.md` 安排，本轮不新增 `tests/` 文件 [R3]。

## 参考

- [R1] trafilatura — https://github.com/adbar/trafilatura — 支撑 §1 指标维度划分与 §2.2 导航噪声信号 — 借鉴长度/噪声/重复三类质量信号；不引入其抽取器。
- [R2] python-readability — https://github.com/buriy/python-readability — 支撑 §2.2(2) 退化判据与 §2.4 下线阈值 — 借鉴「正文≈摘要即抽取失败」；不引入解析库。
- [R3] newspaper — https://github.com/codelucas/newspaper — 支撑 §3.5 按源明细 + 样本展示的报告结构与 §7 用例组织 — 借鉴报告形态；不引入抓取栈。
- [R4] SQLite STRICT tables — https://www.sqlite.org/stricttables.html — 支撑 §2.1 空值兜底与 §6.2 旧库兼容 — 采用 `NOT NULL DEFAULT ''` 下空串即空值；不改表结构。
- [R5] SQLite Online Backup API — https://www.sqlite.org/backup.html — 支撑 §5 只读快照与 §6.2 并发读取语义 — 借鉴一致性快照要求；B 不调用备份 API。
- [R6] dedupeio/dedupe — https://github.com/dedupeio/dedupe — 支撑 §2.2(4) 精确哈希分组边界 — 对照模糊匹配能力，明确本轮不引入实体解析。
- [R7] google-research/deduplicate-text-datasets — https://github.com/google-research/deduplicate-text-datasets — 支撑 §6.2 近重复不纳入本轮 — 对照 MinHash 思路，说明只做精确 `content_hash` 分组。
- [R8] CamDavidsonPilon/tdigest — https://github.com/CamDavidsonPilon/tdigest — 支撑 §2.2(1) 分位数方法选择 — 说明小样本不用近似 sketch，采用全量线性插值。
- [R9] ankane/active_median — https://github.com/ankane/active_median — 支撑 §2.2(1) 数组分位数计算路径 — 借鉴对数组直接算分位的简单实现；不引入其 ORM 与 Ruby 栈。
