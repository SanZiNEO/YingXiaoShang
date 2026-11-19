# B · 新闻正文质量抽检 · 实现方案

> 轮次：B · 新闻正文质量抽检
> 文档角色：03-implementation
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1
> 写权：[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1
> 一句话：一个只走标准库的宿主侧只读脚本，把新闻库按来源算成可复核的质量指标、最差样本与分级结论，不跑采集、不改库、不引第三方依赖；字段、阈值、参数、退出码一律细化自 [`02-contract.md`](./02-contract.md)，不自创口径。

## 1 目录与模块

本轮三件产物全部落在 B 轮写权范围内（[`02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1：`services/news-crawler-py/scripts/quality_report.py` 与 `services/news-crawler-py/docs/**`），不触碰 `packages/**`、`apps/desktop/**` 与采集适配器代码。

| 产物路径 | 职责 | 新建/既有 | 读写边界 |
|---|---|---|---|
| `services/news-crawler-py/scripts/quality_report.py` | 宿主侧抽检脚本：解析参数 → 定位只读库 → 探测主表 → 跑指标 SQL → 算分位数与分级 → 选最差样本 → 输出 Markdown 与 JSON | 新建 | 只打开数据库副本，只读；不发起网络请求、不调用采集 runner |
| `services/news-crawler-py/docs/news-source-quality.md` | 指标口径说明：五类指标定义、阈值表、三档分级规则、导航词表来源、样本字段解释；供人工读报告时对照 | 新建 | 静态文档，不随脚本每次生成 |
| `services/news-crawler-py/docs/quality-report.sample.json` | 一份固定的样例 JSON 报告，结构与 [`02-contract.md`](./02-contract.md) §3 逐字段对齐；供 E 轮契约核对与新人理解结构 | 新建 | 静态样例，不被脚本覆盖 |

脚本内部按函数分层（单文件，不拆包；`scripts/` 下既有工具脚本如 `live_check.py` 也是单文件组织，见 `services/news-crawler-py/scripts/live_check.py:113-120`）：

| 函数 | 输入 → 步骤 → 输出 |
|---|---|
| `parse_args(argv)` | 解析 `--db/--source/--md-out/--json-out/--top/--samples-per-source/--quiet`；整数边界校验；输出 `argparse.Namespace` |
| `resolve_db_path(args)` | 优先级 `--db` > 环境变量 `NEWS_CRAWLER_DB` > 服务根 `.data/news.db`；输出绝对路径；解析为空 → 参数错（§5.3 退出 2） |
| `open_readonly(path)` | 以只读 URI 打开连接，探测 `news_articles` 主表；输出 `connection` |
| `collect_source_metrics(con, wanted_sources)` | 逐源跑指标 SQL，取长度列表与样本候选；输出按源聚合的指标字典 |
| `percentile(values, q)` | 排序 + 线性插值求 P10/P50/P90；空数组返回 `null`，单元素直接取该值 |
| `pick_worst_samples(rows, defects, n)` | 按 §2.3 缺陷分排序取每源最差 `n` 条，正文/摘要按码点截断 |
| `classify(metrics)` | 按 [`02-contract.md`](./02-contract.md) §2.4 阈值给出 `keep` / `downgrade` / `offline` 与理由清单；`n < 3` 护栏强制 `keep` |
| `render_markdown(report)` / `render_json(report)` | 分别产出人读表格报告与结构化 JSON |
| `main(argv) -> int` | 串起以上步骤，按 §5.3 表返回退出码 |

按源统计与抽样展示的报告结构借鉴 newspaper 的「分源聚合 + 样本回溯」形态 [R21]，但不引入它的抓取栈——采集由既有 crawler 负责，本轮只做只读分析。

## 2 依赖与运行方式

### 2.1 依赖核对（标准库，零新增第三方包）

脚本只使用 Python 标准库：`sqlite3`、`json`、`argparse`、`sys`、`os`、`pathlib`、`datetime`、`unicodedata`。

开工前与交付前各核对一次 `services/news-crawler-py/pyproject.toml:6-10`：现有第三方依赖只有 `httpx`、`beautifulsoup4`、`lxml`（外加可选的 `playwright` 与 dev 工具），本脚本的 import 列表里**一个都不出现**；也不修改 `pyproject.toml` 加依赖。采集侧的 STRICT 表假设见 `services/news-crawler-py/src/news_crawler/db.py:25-31`，列可空性以建表 DDL 为准 [R22]。

脚本**不 import `news_crawler` 包**：既有 `db.connect()`（`services/news-crawler-py/src/news_crawler/db.py:65-75`）打开连接后会 `executescript(SCHEMA)` 建表并 `_ensure_columns` 补列，属于写边界；只读脚本必须自己开连接，绕开这条初始化路径。

### 2.2 运行环境与命令

复用仓库根的 `.venv`（验收机上实测为 Python 3.12.13，路径 `.venv\Scripts\python.exe`），不在 `services/news-crawler-py/` 下另建虚拟环境。

在仓库根目录执行（PowerShell 7，命令可直接粘贴）：

```powershell
cd E:\Documents\GitHub\YingXiaoShang

# 最简：库路径走环境变量，Markdown 打到 stdout
.\.venv\Scripts\python.exe services\news-crawler-py\scripts\quality_report.py

# 完整：指定副本库、Markdown 报告与 JSON 报告落点
.\.venv\Scripts\python.exe services\news-crawler-py\scripts\quality_report.py `
  --db .scratch\run\B\home\news.db `
  --md-out .scratch\run\B\report.md `
  --json-out .scratch\run\B\report.json

# 只输出 JSON 文件，不把 Markdown 打到 stdout
.\.venv\Scripts\python.exe services\news-crawler-py\scripts\quality_report.py `
  --db .scratch\run\B\home\news.db --json-out .scratch\run\B\report.json --quiet

# 只看指定来源（--source 可重复）
.\.venv\Scripts\python.exe services\news-crawler-py\scripts\quality_report.py `
  --db .scratch\run\B\home\news.db --source socialbeta --source huxiu
```

默认库路径沿用采集侧既有口径：服务根（`scripts/` 的上一级）下 `.data/news.db`，见 `services/news-crawler-py/src/news_crawler/query.py:49-51` 与 `services/news-crawler-py/src/news_crawler/cli.py:21`；本轮通过 `NEWS_CRAWLER_DB` 环境变量或 `--db` 覆盖（见 §5）。参数名与边界以 [`02-contract.md`](./02-contract.md) §2.6 为准。

### 2.3 脚本不做的事

- 不发起 HTTP 请求、不跑 `SourceRunner`、不调 `live_check` 式的实抓流程。
- 不写库、不建表、不补列；不调用 `record_run`、`SQLiteSink` 等写路径。
- 不读真实数据目录；输入库必须是 §4 约定的 `.scratch/run/B/` 副本。

## 3 关键实现

### 3.1 只读连接与主表探测

连接串用 SQLite URI 只读模式，打开时即限制为只读：

```python
uri = f"file:{path.as_posix()}?mode=ro"
con = sqlite3.connect(uri, uri=True, check_same_thread=False)
con.row_factory = sqlite3.Row
con.execute("PRAGMA query_only=ON")
```

- `mode=ro`：文件级只读，连接内任何写语句会被 SQLite 拒绝；`query_only=ON` 是第二道保险（禁止写与 ATTACH 写库）。
- 不执行 `journal_mode`、不建表、不跑列迁移；对照带副作用的 `db.connect()`，`services/news-crawler-py/src/news_crawler/db.py:65-75`。
- 主表探测复用既有 `has_table` 的判断思路（`services/news-crawler-py/src/news_crawler/db.py:87-91`：查 `sqlite_master`），但在脚本内重写一份只读版本，不 import `db.py`。
- `news_articles` 缺失按 §6 退出 1；本轮指标不引用 `source_runs`（[`02-contract.md`](./02-contract.md) §2.1），也不假设 `news_tags` 等下游表存在（[`02-contract.md`](./02-contract.md) §6 备注）。

### 3.2 指标 SQL（按源聚合）

取数一条分组 SQL 取齐计数类指标，长度列表与样本候选单独取，避免把十万行正文全载入内存：

```sql
SELECT
  source,
  COUNT(*) AS n,
  SUM(CASE WHEN TRIM(title) = '' THEN 1 ELSE 0 END) AS empty_title,
  SUM(CASE WHEN TRIM(published_at) = '' THEN 1 ELSE 0 END) AS empty_date
FROM news_articles
GROUP BY source
ORDER BY source
```

行级取数带 `ORDER BY id`，保证取数顺序确定（[`02-contract.md`](./02-contract.md) §2.1）。`content/summary/title/published_at` 为 `NULL` 时按空串处理，与 `services/news-crawler-py/src/news_crawler/query.py:99-114` 出参兜底一致。长度（Python 码点数 `len()`，不按 UTF-8 字节、不二次清洗）、退化判定、导航命中在 Python 侧逐行处理；正文列只在入选样本行读取。

| 指标（JSON 字段） | 定义（口径钉死在契约 §2.2） | 分母 |
|---|---|---|
| `emptyTitleRatio` | `TRIM(title) == ''` 的条数 / `n` | 该源全部文章 |
| `emptyDateRatio` | `TRIM(published_at) == ''` 的条数 / `n` | 同上 |
| `degenerateRatio` | 同时满足：`summary.strip()` 与 `content.strip()` 均非空；`len(summary) >= 0.80 * len(content)`；去空白后 `summary in content` 或 `content in summary` | 同上 |
| `navHitRatio` | 正文命中 §3.3 冻结词表任一词的条数 / `n` | 同上 |
| `duplicateHashRatio` | eligible 行（`content_hash.strip()` 非空）中落在成员数 `≥ 2` 的哈希组内的行数 / eligible 行数 | eligible 行；eligible 为 0 时 `null` |

比例一律 `round(..., 4)`；`n = 0` 时上述比例为 `null`。哈希口径沿用入库侧 `sha256(content utf-8)` 十六进制摘要（`services/news-crawler-py/src/news_crawler/output.py:91`），只做精确哈希分组，不做模糊匹配或 MinHash。

「正文≈摘要 = 抽取退化」的判据借鉴 python-readability 对正文退化为摘要形态的识别思路 [R20]；导航噪声、长度不足、重复这三类信号的划分参照 trafilatura 的质量评价维度 [R19]，但不引入其抽取器。

### 3.3 导航词表怎么定

冻结词表写在脚本常量 `NAV_TERMS`（元组，顺序固定，保证两次运行结果一致；纯子串匹配，区分大小写，不做分词），词表以 [`02-contract.md`](./02-contract.md) §2.2(3) 为准：

```text
广告, 点击查看, 相关阅读, 相关推荐, 扫码下载, 下载APP, 下载 App, 免责声明,
版权所有, 举报, 微信公众号, 上一篇, 下一篇, 返回首页, 登录后查看, 扫码关注, 转载请注明出处
```

判定：`any(term in content for term in NAV_TERMS)`，命中即计数；命中样本必须在 `defects` 与样本预览里可复核命中词。词表扩充与调整记录在 `docs/news-source-quality.md`，不在脚本外散落第二份词表。

### 3.4 P10/P50/P90 算法

长度列表在 Python 侧排序后按线性插值取分位数（等价 Hyndman–Fan 方法 7 / NumPy 默认 `linear`）：

```python
def percentile(values: list[int], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return float(ordered[0])
    h = (len(ordered) - 1) * q
    i = int(h)
    f = h - i
    return ordered[i] + f * (ordered[i + 1] - ordered[i])
```

- 边界规则（契约 §2.2(1)）：`n = 0` 三个分位数均 `null`；`n = 1` 三者同取 `x[0]`；`n ≥ 2` 按上式插值。
- 输出 `round(Q(p), 2)`，类型 `number | null`；在 Python 端排序计算，不用 SQLite 窗口函数，避免不同 SQL 方言插值口径漂移。
- 分位数是全量排序精算，不引入 t-digest 一类近似结构 [R23]；数组上分位数的实现形态参照 active_median [R24]，但我们不依赖其 Ruby 运行时。

### 3.5 最差样本选取规则

每源取 `--samples-per-source` 条（默认 3，范围 0..10）；行级缺陷码与权重按契约 §2.3：

| 缺陷码 `defects` | 含义 | 权重 |
|---|---|---|
| `empty_title` | 标题为空 | 3 |
| `degenerate` | 命中 §3.2 退化判据 | 2 |
| `short_body` | `L < 20`（对齐入库下限 `MIN_CONTENT_CHARS`，`services/news-crawler-py/src/news_crawler/normalize.py:11`、`:40-41`） | 2 |
| `dup_hash` | 命中哈希重复组 | 1 |
| `nav_hit` | 命中导航词表 | 1 |
| `empty_date` | 发布日期为空 | 1 |

排序键固定为逐级兜底：`(-score, L 升序, id 升序)`，保证同库两次运行样本集合与顺序一致。样本字段按契约 §3.3：`id`、`source`、`title`、`url`、`publishedAt`、`contentStatus`、`contentPreview`、`truncated`、`summaryPreview`、`summaryTruncated`、`defects`。

截断按 Python 码点切，不按字节：

```python
contentPreview = content[:200]
truncated = len(content) > 200
summaryPreview = summary[:120]
summaryTruncated = len(summary) > 120
```

`contentPreview` 不追加省略号字符；是否截断由 `truncated` 布尔标记表达。样本只带预览，不在报告里贴全文。

### 3.6 分级结论规则

阈值表钉死在 [`02-contract.md`](./02-contract.md) §2.4，脚本内只做判定，不另存一套数值。样本护栏：`n < 3` 时结论强制 `keep`，并写入警告「样本不足 3 条（n=<n>），结论仅供参考。」；阈值越线情况仍记入 `verdictReasons`，但不升级为降级 / 下线。

| 结论 | 触发条件（任一命中） |
|---|---|
| `offline`（下线） | `emptyTitleRatio ≥ 0.20`；或 `duplicateHashRatio ≥ 0.30`；或 `degenerateRatio ≥ 0.50`；或 `length.p50 < 50` |
| `downgrade`（降级为只取标题摘要） | `length.p10 < 100`；或 `degenerateRatio ≥ 0.20`；或 `navHitRatio ≥ 0.20`；或 `emptyDateRatio ≥ 0.30`；或 `duplicateHashRatio ≥ 0.10`；或 `length.p50 < 200` |
| `keep`（保留） | 以上均未命中；或护栏 `n < 3` 强制保留 |

长度锚点：20 字对齐 `MIN_CONTENT_CHARS`（`services/news-crawler-py/src/news_crawler/normalize.py:11`）；200 / 300 字位于摘要兜底与 1000 字 `full` 分界（`normalize.py:12`、`:54`、`:81`）之间。每条结论在 `verdictReasons` 里写明命中了哪条规则（元素形如 `degenerateRatio>=0.20 (0.3333)`），便于复核回溯。

### 3.7 输出结构与确定性

JSON 顶层字段按契约 §3.1：`schemaVersion`、`generatedAt`、`elapsedMs`、`dbPath`、`dbReadable`、`totals`（`articles/sources/sourcesWithData`）、`global`（全库五类比例）、`sources`、`worstSources`、`warnings`。Markdown 报告：头部摘要（生成时间、库路径、文章总数、来源数）→ 最差 `<--top>` 源表 → 逐源小节（指标表 + 样本列表）。

`worstSources` 排序按契约 §2.5：严重度 `offline=3`、`downgrade=2`、`keep=1` 降序；同档按 `defectRatio` 降序（`defectRatio = min(1, degenerateRatio + navHitRatio + duplicateHashRatio + emptyTitleRatio + emptyDateRatio)`，`null` 按 0 计）；再同档按 `source` 字典序升序兜底；取前 `--top` 条。

确定性约束（硬指标，见 04-acceptance AC-11）：

- 所有列表排序键固定：源按 `source` 字典序；样本按 §3.5 键；`worstSources` 按 §2.5 键。
- 唯一允许两次运行不同的字段是顶层 `generatedAt` 与 `elapsedMs`；两次输出比对时剔除这两个字段后必须逐字节一致。
- JSON 序列化：`json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True)`，键名字典序固定；与既有脚本 `live_check.py:106-109` 的 JSON 落盘口径一致。
- 脚本内不使用随机数、不读当前进程号、不写带 PID 的临时文件名。

## 4 数据读写

### 4.1 读哪些表、哪些列

| 表 | 读取列 | 依据 |
|---|---|---|
| `news_articles` | `id, source, title, url, published_at, summary, content, content_hash, content_status` | 建表 DDL `services/news-crawler-py/src/news_crawler/db.py:25-31` |

- `source_runs` 不在本轮指标范围内（[`02-contract.md`](./02-contract.md) §2.1），脚本不读、不展示其运行状态。
- `news_tags` 等下游表不假设存在；只读报告不引用标签覆盖（`services/news-crawler-py/src/news_crawler/output.py:77` 仅在写路径做条件删除）。
- `news_articles` 的列含 `content_hash`、`tag_content_hash` 两个补列（`services/news-crawler-py/src/news_crawler/db.py:59-62`）；本脚本只用 `content_hash`。

### 4.2 写边界

- 脚本内不出现 `INSERT` / `UPDATE` / `DELETE` / `CREATE` / `ALTER` / `DROP` / `ATTACH`；代码评审与 04 的 AC-12 用文本扫描复核这一条。
- 不开写事务；连接 `query_only=ON` + URI `mode=ro` 双保险。
- 不调用 `db.record_run`、不写 JSONL、不落 `artifacts/` 或 `exports/`。

### 4.3 WAL 下的副本策略

验收与日常抽检都不直连运行中的主库：先把库文件复制到本轮隔离目录，脚本打开副本。

```powershell
cd E:\Documents\GitHub\YingXiaoShang
New-Item -ItemType Directory -Force .scratch\run\B\home\data | Out-Null
Copy-Item <源库路径> .scratch\run\B\home\news.db
# WAL 模式下若存在 -wal / -shm，一并复制，避免读到未 checkpoint 的旧状态
Copy-Item <源库路径>-wal .scratch\run\B\home\news.db-wal -ErrorAction SilentlyContinue
Copy-Item <源库路径>-shm .scratch\run\B\home\news.db-shm -ErrorAction SilentlyContinue
```

SQLite 在 WAL 下直接 `cp` 主库可能拿到半写状态，在线一致性快照应走 Online Backup API 或 `VACUUM INTO` [R45]；本轮是只读抽检、且源库处于停采状态时复制副本即可，若抽检时采集进程仍在写库，应改用 `.backup` 方式出副本（该方式归 G 轮工具链，本轮只在口径文档里标注前提）。副本目录由 B 轮独占，不删除 `.scratch/` 下其他轮次的目录（[`02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §3 硬规则）。

### 4.4 禁止访问的位置

不读写 `%APPDATA%`、`~/.learning-agent`、`<repo>/.learning-agent` 下的真实数据目录；脚本路径解析只认参数与环境变量，不反向猜测用户目录。

## 5 配置

### 5.1 环境变量

| 变量 | 默认 | 作用 | 谁设置 |
|---|---|---|---|
| `NEWS_CRAWLER_DB` | 未设则取服务根 `.data/news.db`（`query.py:49-51`、`cli.py:21`） | 待抽检的 SQLite 库路径；`--db` 未传时取它 | 验收者 / 运维 |

本脚本不读 `LEARNING_AGENT_HOME`；环境变量名与冻结表一致（[`01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) §10.2：`NEWS_CRAWLER_DB`），不在脚本里引入第二份环境变量名。配置从环境与命令行一次性读完，运行期不再回读进程环境，符合 12-Factor「配置在环境中」的口径 [R6]。

### 5.2 命令行参数

参数名、类型、默认值与边界校验以 [`02-contract.md`](./02-contract.md) §2.6 为准：

| 参数 | 类型 | 默认 | 作用与边界 |
|---|---|---|---|
| `--db PATH` | 字符串 | 环境变量 `NEWS_CRAWLER_DB`；未设则服务根 `.data/news.db` | 覆盖库路径；解析后为空 → 退出 2 |
| `--source ID` | 字符串，可重复 | 全部源 | 只统计指定来源；库内不存在的名字不报错，写入警告「未在库内找到来源：<id>」 |
| `--md-out PATH` | 字符串 | 无（Markdown 打到 stdout，`--quiet` 时不打） | Markdown 报告落盘路径；父目录不存在则创建 |
| `--json-out PATH` | 字符串 | 无（不写 JSON 文件） | JSON 报告落盘路径；父目录不存在则创建 |
| `--top N` | 整数 | `5` | `worstSources` 列入的最差源数量；范围 1..50，越界 / 非整数 → 退出 2 |
| `--samples-per-source N` | 整数 | `3` | 每源样本条数；范围 0..10，越界 / 非整数 → 退出 2 |
| `--quiet` | 开关 | 关 | 抑制 stdout Markdown；不影响 `--json-out` 落盘 |

脚本不接受采集类参数（`--workers`、`--browser`、`--output` 等）；传入未知参数由 `argparse` 退出 2。

### 5.3 退出码表

退出码语义以 [`02-contract.md`](./02-contract.md) §4 为准：

| 退出码 | 类别 | 触发 |
|---|---|---|
| `0` | 正常出报告 | 有数据；空数据报告；缺次要表；样本不足、未知源等非致命警告 |
| `1` | 库不可读 | 文件不存在 / 不可读 / 不是 SQLite 文件；连接成功但缺 `news_articles` 表；查询或分组过程中抛出的其他数据库异常 |
| `2` | 参数错 | `--top` / `--samples-per-source` 非整数或越界；`--db` 与环境变量解析后均为空；未知参数；`--db` 指向目录 |
| `130` | 中断 | 仅 `KeyboardInterrupt`，沿用采集 CLI 现状（`services/news-crawler-py/src/news_crawler/cli.py:362`） |

内容质量不达标不导致非零退出：非零只代表脚本没跑成。采集 CLI 的 1 表示采集有失败（`cli.py:128`），B 的 1 只表示「库不可读」，两者不混用。

## 6 失败处理

每条失败路径给出探测方式、stderr 中文消息（一行，不带堆栈；消息逐字对齐契约 §4）、退出码与是否重试；内部英文异常只进内部记录，不上屏、不写进报告 JSON。

| 场景 | 探测方式 | 用户看到的消息（stderr） | 退出码 | 重试 |
|---|---|---|---|---|
| 库打不开（不存在 / 不可读 / 非 SQLite） | `Path.exists()` 预检；`connect` 抛 `OperationalError` / `DatabaseError` 兜底 | `数据库打不开：<path>，请检查文件是否存在且为 SQLite 库。` | 1 | 否 |
| 主表 `news_articles` 缺失 | 查 `sqlite_master` 无命中 | `数据库里没有 news_articles 表，无法统计。` | 1 | 否 |
| 查询 / 分组异常 | 迭代与聚合过程中捕获 `OperationalError` / `DatabaseError` | `数据库读取失败：<error>。` | 1 | 否（不自动重连，避免对 WAL 副本造成二次打开） |
| `--top` 非整数 / 越界 | argparse 类型 + 范围校验 | `--top 必须是 1 到 50 的整数。` | 2 | 否 |
| `--samples-per-source` 非整数 / 越界 | argparse 类型 + 范围校验 | `--samples-per-source 必须是 0 到 10 的整数。` | 2 | 否 |
| 库路径解析为空 | `--db` 与 `NEWS_CRAWLER_DB` 均未提供有效路径 | `数据库路径不能为空。` | 2 | 否 |
| 未知参数 | argparse 兜底 | `未识别的参数：<arg>。` | 2 | 否 |
| 空表（0 篇文章） | `COUNT(*) = 0` | 不打错误；报告照常产出，指标为 `null`，`warnings` 含 `库内新闻文章为 0 条，报告指标全部为空。` | 0 | — |
| 样本不足 | 该源 `n < 3` | 不打错误；`warnings` 含 `来源 <id> 样本不足 3 条（n=<n>），结论仅供参考。`；护栏强制 `keep` | 0 | — |
| `--source` 名字无匹配 | 库内查不到该 `source` | 不打错误；`warnings` 含 `未在库内找到来源：<id>。` | 0 | — |
| `KeyboardInterrupt` | 顶层捕获 | 不打印堆栈 | 130 | 否 |

损坏库的完整性判断可附 `PRAGMA quick_check` 结果，不跑全量 `integrity_check`（大库耗时不可控）[R47]。空表不是错误：脚本能区分「库坏了」（退出 1）和「库还没数据」（退出 0，出空指标报告）。

## 7 性能与资源

### 7.1 预期耗时与规模口径

| 规模 | 预期耗时（待实测） | 说明 |
|---|---|---|
| 百行级（现有 scratch 样例 55 / 166 行） | 预期亚秒级（待实测） | 2026-11-19 只读探测两个样例库可正常打开；报告脚本实际耗时以 04 证据为准 |
| 1 万行 | 预期 1 秒以内（待实测） | 单连接只读，分组 SQL 走 `source` 聚合 |
| 10 万行 | 预期数秒到十几秒区间（待实测） | 不把正文全量载入；长度与判定走单行流式处理，样本行才读正文 |

10 万行的耗时区间是首版假设，不作为承诺数字；验收时按下面的方法实测并把结果写回 04 证据。

测量方法（PowerShell，同一副本连跑两次取第二次）：

```powershell
cd E:\Documents\GitHub\YingXiaoShang
$sw = [System.Diagnostics.Stopwatch]::StartNew()
.\.venv\Scripts\python.exe services\news-crawler-py\scripts\quality_report.py `
  --db .scratch\run\B\home\news.db --json-out .scratch\run\B\report.json
$sw.Stop()
"elapsedMs=$($sw.ElapsedMilliseconds)"
```

规模梯度造数：在 `.scratch/run/B/` 副本上用只读探针导出 1k / 10k / 100k 行子集（或复制真实样本库后重复插入只读副本——造数动作只在 scratch 副本上做，不碰主库），分别计时。

### 7.2 内存与资源约束

- 逐行处理：游标迭代文章行，只在内存保留每源的长度列表、计数累计与样本候选；正文列仅对入选样本读取并截断 200 码点。
- 不缓存全文：10 万行 × 平均数千字正文若全量驻留会达到数百 MB，本脚本不允许出现这种载入方式。
- 单线程、单连接；不并发开库、不起线程池。
- 报告文件体积：每源 ≤ `--samples-per-source` 条样本 × 200 字预览，源数量级在数十个，Markdown/JSON 均为百 KB 级；超大样本集由该参数控制。

### 7.3 索引利用

分组与过滤尽量走既有索引：`news_articles_by_url`、`news_articles_by_published`（`services/news-crawler-py/src/news_crawler/db.py:32-34`）；STRICT 表上的扫描成本与列亲和性见 SQLite 类型说明 [R22]；按 `source` 聚合在当前 schema 上没有专用索引，10 万行以内全表扫描可接受，若实测超时再考虑在只读副本上建临时索引（不在主库建）。

## 8 实施顺序（每步做完能验证什么）

按「先能跑、再能算、再能出报告、最后对齐口径」排 8 步，每步有可执行的验证点；这种可回退小步拆分的做法参照通用的分步交付经验 [R36]。

1. **骨架与参数解析**：`parse_args` + `resolve_db_path` + `main` 空壳。验证：`--help` 列出 §5.2 全部参数；`--top abc`、`--samples-per-source 11` 退出 2 并打印对应逐字消息；库路径解析为空退出 2。
2. **只读连接与主表探测**：`open_readonly` + `sqlite_master` 探测。验证：能打开 `.scratch/run/B/` 副本；缺 `news_articles` 的副本退出 1 并打印契约消息。
3. **计数类指标 SQL**：空标题、空日期、哈希 eligible 分组。验证：脚本结果与手工 SQL（同一条 `GROUP BY source`）逐源对账一致；`null` 兜底与 `query.py:99-114` 一致。
4. **长度分位数**：`percentile` + 逐源长度列表。验证：挑一个小源，用 Python 手算 P50 与脚本输出一致；`n = 0` 为 `null`，`n = 1` 三者同值。
5. **退化判定与导航命中**：单行判定函数 + 冻结 `NAV_TERMS` 词表。验证：造两条已知退化 / 命中样本，缺陷码判断正确；词表顺序在源码中固定。
6. **样本选取与截断**：缺陷分排序 + 200 / 120 码点预览。验证：每源样本数等于 `--samples-per-source`；`contentPreview` 长度 ≤ 200、`truncated` 与实际一致；`defects` 与扣分对得上。
7. **分级结论与双格式输出**：`classify` + Markdown/JSON 渲染 + 固定排序。验证：同库跑两次，剔除 `generatedAt` / `elapsedMs` 后两份 JSON 深比较相等（AC-11）；护栏 `n < 3` 强制 `keep`；边界样本落档正确。
8. **口径文档与样例收尾**：写 `news-source-quality.md` 指标口径、`quality-report.sample.json` 样例；跑 `check-docs.py --round B`。验证：样例 JSON 字段与契约 §3 逐字段对照无缺项；文档自检全绿。

## 参考

- [R19] trafilatura — https://github.com/adbar/trafilatura — 支撑 §3.2 长度/噪声/重复三类质量指标划分 — 借鉴评价维度，不引入其抽取器。
- [R20] python-readability — https://github.com/buriy/python-readability — 支撑 §3.2 正文退化为摘要的识别判据 — 借鉴退化形态思路，不引入其解析栈。
- [R21] newspaper — https://github.com/codelucas/newspaper — 支撑 §1 按源统计与样本抽样的报告结构 — 借鉴报告组织，不引入抓取栈。
- [R22] SQLite STRICT tables — https://www.sqlite.org/stricttables.html — 支撑 §2.1 列可空性假设 — 按 STRICT DDL 判断空串与 NULL。
- [R23] CamDavidsonPilon/tdigest — https://github.com/CamDavidsonPilon/tdigest — 支撑 §3.4 分位数方案取舍 — 了解近似分位数结构；本轮全量排序精算，不引入 t-digest。
- [R24] ankane/active_median — https://github.com/ankane/active_median — 支撑 §3.4 数组上分位数实现形态 — 借鉴数组计算口径，不依赖其 Ruby 运行时。
- [R45] SQLite Online Backup API — https://www.sqlite.org/backup.html — 支撑 §4.3 WAL 副本与一致性快照口径 — 了解 `cp` 的半写风险；本轮停采状态下用副本。
- [R47] SQLite PRAGMA integrity_check — https://www.sqlite.org/pragma.html#pragma_integrity_check — 支撑 §6 损坏库 `quick_check` 探测 — 采用双档校验，不全量跑 integrity_check。
- [R6] 12-Factor Logs — https://12factor.net/logs — 支撑 §5 配置从环境一次性读取 — 采用环境配置口径，不引入日志聚合服务。
- [R36] JavaScript Testing Best Practices — https://github.com/goldbergyoni/javascript-testing-best-practices — 支撑 §8 分步交付与每步可验证 — 借鉴可执行验证点组织，不引入其工具链。
