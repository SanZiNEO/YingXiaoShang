# B · 新闻正文质量抽检 · 验收

> 轮次：B · 新闻正文质量抽检
> 文档角色：04-acceptance
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1
> 写权：[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1
> 一句话：12 条 AC 全部命令可复现；同库跑两次剔除 `generatedAt` / `elapsedMs` 后逐字段一致是硬指标，任何「我觉得正常」都不算过。

## 1 验收口径

**过 = 下列三组同时成立**：

1. **功能指标**：AC-01..AC-12 全部通过；每源指标齐全（`length.p10/p50/p90`、`degenerateRatio`、`navHitRatio`、`duplicateHashRatio`、`emptyTitleRatio`、`emptyDateRatio`）；每源 ≤ `--samples-per-source` 条最差样本；`worstSources` 与三档结论可复核。
2. **只读与确定性**：脚本对副本库零写入（AC-12）；同一副本连跑两次，剔除顶层 `generatedAt`、`elapsedMs` 后 JSON 深比较相等，Markdown 除生成时间行外逐行一致（AC-11）。
3. **证据**：每条 AC 在 `.scratch/run/B/evidence/<AC 编号>/` 留下命令原文、输出原文与退出码；反向验证的改坏/还原输出同样留痕。

不可替代项（不能用手工目测代替）：分位数与独立计算对账（AC-04）、两次运行 diff 为空（AC-11）、源码无写语句且副本哈希不变（AC-12）、空库判「无数据」而非报错（AC-08）、参数错退出 2 与库不可读退出 1 不混淆（AC-01/AC-09/AC-10）。

「可机器判定才算验收」这条口径来自测试实践：断言写成可执行检查，而不是人工观察 [R36]。按源聚合 + 样本回溯的报告形态参照 newspaper 的既有组织方式 [R21]。

## 2 前置条件

### 2.1 环境

```powershell
cd E:\Documents\GitHub\YingXiaoShang

# 复用仓库根 .venv（Python 3.12），不另建虚拟环境
.\.venv\Scripts\python.exe --version

# 确认本轮产物脚本与文档路径存在（实现完成后）
Test-Path services\news-crawler-py\scripts\quality_report.py
Test-Path services\news-crawler-py\docs\news-source-quality.md
Test-Path services\news-crawler-py\docs\quality-report.sample.json
```

缺什么就明说「缺则跳过并标记」：没有可用样例库时，AC-03..AC-07、AC-11 标记 `skipped: 无样例库`，但 AC-01、AC-02、AC-08、AC-09、AC-10、AC-12 仍可用构造夹具跑完。

### 2.2 隔离副本（禁止直连真实数据目录）

```powershell
cd E:\Documents\GitHub\YingXiaoShang
New-Item -ItemType Directory -Force .scratch\run\B\home\data | Out-Null
New-Item -ItemType Directory -Force .scratch\run\B\evidence | Out-Null

# 以采集侧 scratch 样例库为输入（只读复制；不碰 %APPDATA%、~/.learning-agent、<repo>/.learning-agent）
$src = "services\news-crawler-py\.scratch\acceptance-news.db"
Copy-Item $src .scratch\run\B\home\news.db
# WAL 副件一并复制，避免读到未 checkpoint 的旧状态
Copy-Item "$src-wal" .scratch\run\B\home\news.db-wal -ErrorAction SilentlyContinue
Copy-Item "$src-shm" .scratch\run\B\home\news.db-shm -ErrorAction SilentlyContinue
```

库路径通过 `--db` 或 `NEWS_CRAWLER_DB` 指向该副本；本脚本不读 `LEARNING_AGENT_HOME`。

### 2.3 夹具库（AC-08 / AC-10 用，均在 scratch 内构造）

```powershell
cd E:\Documents\GitHub\YingXiaoShang
.\.venv\Scripts\python.exe .scratch\run\B\make_fixtures.py
```

`make_fixtures.py`（验收者自建的一次性夹具脚本，不是交付物）职责：

- 建 `.scratch\run\B\empty.db`：含空的 `news_articles` 表，0 行；
- 建 `.scratch\run\B\notable.db`：只含一张 `chapters` 表，不含 `news_articles`。

WAL 下复制副本的一致性前提参照 SQLite Online Backup API 的说明：停采状态下文件复制可用，采集进程仍在写库时应改用在线备份出副本 [R45]。

## 3 用例清单

| 编号 | 操作步骤 | 期望输出 | 失败判据 | 证据文件 |
|---|---|---|---|---|
| AC-01 | ① `quality_report.py --help`；② `--top abc`；③ `--samples-per-source 11` | ① 退出码 0，帮助含 `--db`、`--source`、`--md-out`、`--json-out`、`--top`、`--samples-per-source`、`--quiet`；② 退出码 2，消息 `--top 必须是 1 到 50 的整数。`；③ 退出码 2，消息 `--samples-per-source 必须是 0 到 10 的整数。` | 退出码非 0/非 2；任一参数缺失；消息与契约 §4 逐字不符 | `evidence/AC-01/help.txt`、`param-top.txt`、`param-samples.txt`、`exit-code.txt` |
| AC-02 | 记录副本目录文件清单 → 跑一次报告 → 再记清单 | 退出码 0；两次清单一致，未生成新的 `-wal`/`-shm`/临时文件 | 清单多出文件；副本目录出现写副件 | `evidence/AC-02/listing-before.txt`、`listing-after.txt`、`report.md` |
| AC-03 | 跑完整报告输出 JSON，逐源核对字段 | 每个 `sources[]` 元素含 `source`、`sampleSize`、`length{p10,p50,p90}`、`degenerateRatio`、`navHitRatio`、`duplicateHashRatio`、`emptyTitleRatio`、`emptyDateRatio`、`verdict`、`verdictReasons`、`warnings`、`samples`；`n=0` 时比例为 `null` 而不是缺键；比率在 0..1 | 任一键缺失；空表直接抛错；比率越界；字段名与契约 §3.2 不符 | `evidence/AC-03/report.json` |
| AC-04 | 取报告中样本数 ≥2 的一个源，用独立 Python 片段对原始长度列表重算 P50，与 JSON `length.p50` 对账 | 两者一致（浮点误差 <1e-9）；`n=0` 三个分位数为 `null`；`n=1` 三者同取该值 | 数值不一致；空源给出 0 或单值冒充；单元素源插值出错 | `evidence/AC-04/p50-check.txt` |
| AC-05 | 核对每个源 `samples` | 条数 ≤ `--samples-per-source`（默认 3）；每条 `contentPreview` 长度 ≤200 码点；`truncated` 与实际长度一致；`defects` 为数组；含 `id/title/url/publishedAt/contentStatus/summaryPreview/summaryTruncated` | 条数超限；预览超 200；缺 `truncated` 或 `url`/`title`；缺陷码不在契约 §2.3 表内 | `evidence/AC-05/report.json` |
| AC-06 | 核对 JSON `worstSources` 与 Markdown 头部表 | 数量 ≤ `--top`（默认 5）；按严重度 `offline=3/downgrade=2/keep=1` 降序，同档按 `defectRatio` 降序，再同档按 `source` 字典序；Markdown 表内同名同序 | 数量超限；顺序与契约 §2.5 矛盾；Markdown 与 JSON 源名单不一致 | `evidence/AC-06/report.json`、`report.md` |
| AC-07 | 核对每源 `verdict` 与 `verdictReasons` | `verdict ∈ {keep, downgrade, offline}`；非 `keep` 时 `verdictReasons` 非空且写明命中规则；`n < 3` 护栏强制 `keep` 并带样本不足警告 | 出现枚举外取值；非 keep 无理由；护栏源被升级为降级/下线；结论与指标数值矛盾 | `evidence/AC-07/report.json` |
| AC-08 | 对夹具 `empty.db` 跑报告 | 退出码 0；`totals.articles=0`；各比例为 `null`；`warnings` 含 `库内新闻文章为 0 条，报告指标全部为空。`；stderr 无堆栈 | 退出码非 0；抛除零/索引异常；指标给出假数值 | `evidence/AC-08/empty-report.json`、`empty-stderr.txt` |
| AC-09 | `--db` 指向不存在路径跑报告 | 退出码 1；stderr 消息 `数据库打不开：<path>，请检查文件是否存在且为 SQLite 库。` | 退出码不是 1；英文堆栈外泄；消息与契约 §4 逐字不符 | `evidence/AC-09/missing-stderr.txt`、`exit-code.txt` |
| AC-10 | 对夹具 `notable.db` 跑报告 | 退出码 1；stderr 消息 `数据库里没有 news_articles 表，无法统计。` | 退出码不是 1；消息未指出缺哪张表 | `evidence/AC-10/notable-stderr.txt` |
| AC-11 | 同一副本连跑两次，输出 r1/r2，剔除 `generatedAt`、`elapsedMs` 后比对 | JSON 深比较相等；Markdown 剔除生成时间行后一致；退出码 0 | 任一字段两次不同；样本集合/顺序不同；Markdown 有非时间戳差异 | `evidence/AC-11/report-r1.json`、`report-r2.json`、`diff.txt` |
| AC-12 | 跑前算副本哈希，跑后再算；扫描脚本源码 | 前后哈希一致；源码不含 `INSERT`/`UPDATE`/`DELETE`/`CREATE`/`ALTER`/`DROP`/`ATTACH`；连接为 `mode=ro` | 哈希变化；出现写语句；连接未用只读 URI | `evidence/AC-12/hash-before.txt`、`hash-after.txt`、`write-scan.txt` |

用例写法遵循「一条 AC 一个可观察结果 + 明确失败判据」，避免「看起来正常」这类不可判定描述 [R36]。指标字段、阈值与消息以 [`02-contract.md`](./02-contract.md) §2/§3/§4 为准；样例结构对照 `docs/quality-report.sample.json`。

### AC-11 完整命令（硬指标：跑两次、diff 为空）

```powershell
cd E:\Documents\GitHub\YingXiaoShang
$py     = ".\.venv\Scripts\python.exe"
$script = "services\news-crawler-py\scripts\quality_report.py"
$db     = ".scratch\run\B\home\news.db"
$ev     = ".scratch\run\B\evidence\AC-11"
New-Item -ItemType Directory -Force $ev | Out-Null

# 第一次运行
& $py $script --db $db --json-out "$ev\report-r1.json" --md-out "$ev\report-r1.md"
$r1Exit = $LASTEXITCODE

# 第二次运行（同一副本，中间不刷新库）
& $py $script --db $db --json-out "$ev\report-r2.json" --md-out "$ev\report-r2.md"
$r2Exit = $LASTEXITCODE

# 剔除顶层 generatedAt / elapsedMs 后逐字段比对 JSON
$j1 = Get-Content "$ev\report-r1.json" -Raw | ConvertFrom-Json
$j2 = Get-Content "$ev\report-r2.json" -Raw | ConvertFrom-Json
$j1.generatedAt = $null
$j1.elapsedMs   = $null
$j2.generatedAt = $null
$j2.elapsedMs   = $null
$d1 = $j1 | ConvertTo-Json -Depth 20
$d2 = $j2 | ConvertTo-Json -Depth 20
$jsonDiff = Compare-Object $d1 $d2

# Markdown 剔除生成时间行后比对
$m1 = (Get-Content "$ev\report-r1.md") | Where-Object { $_ -notmatch '生成时间|generatedAt|Generated' }
$m2 = (Get-Content "$ev\report-r2.md") | Where-Object { $_ -notmatch '生成时间|generatedAt|Generated' }
$mdDiff = Compare-Object $m1 $m2

"r1Exit=$r1Exit r2Exit=$r2Exit" | Out-File "$ev\exit-code.txt"
if ($jsonDiff) { $jsonDiff | Out-File "$ev\diff.txt" } else { "json identical" | Out-File "$ev\diff.txt" }
if ($mdDiff) { $mdDiff | Out-File "$ev\diff-md.txt" } else { "markdown identical" | Out-File "$ev\diff-md.txt" }

# 判据：两个 exit 均为 0，diff.txt 与 diff-md.txt 均为 identical
if ($r1Exit -ne 0 -or $r2Exit -ne 0 -or $jsonDiff -or $mdDiff) { exit 1 }
```

判据记录：`exit-code.txt` 两行退出码均为 0；`diff.txt` 内容为 `json identical`；`diff-md.txt` 内容为 `markdown identical`。任何一行 JSON 字段或样本顺序不同，`Compare-Object` 都会列出 `<=>` 方向行，AC-11 即判失败。

## 4 证据

### 4.1 落点目录

```text
.scratch/run/B/
  home/news.db                      # 验收输入副本（含 -wal/-shm 若源库有）
  empty.db                          # AC-08 夹具
  notable.db                        # AC-10 夹具
  make_fixtures.py                  # 一次性夹具构造脚本（非交付物）
  report.md / report.json            # 首轮完整输出
  evidence/
    AC-01/help.txt  param-top.txt  param-samples.txt  exit-code.txt
    AC-02/listing-before.txt  listing-after.txt  report.md
    AC-03/report.json
    AC-04/p50-check.txt
    AC-05/report.json
    AC-06/report.json  report.md
    AC-07/report.json
    AC-08/empty-report.json  empty-stderr.txt
    AC-09/missing-stderr.txt  exit-code.txt
    AC-10/notable-stderr.txt
    AC-11/report-r1.json  report-r2.json  diff.txt  diff-md.txt  exit-code.txt
    AC-12/hash-before.txt  hash-after.txt  write-scan.txt
```

### 4.2 采集约定

- 每条证据目录记录采集时间戳：`Get-Date -Format o | Out-File <ev>/timestamp.txt`。
- 命令原文与输出原文分别落盘；stderr 单独重定向：`2> "$ev\stderr.txt"`。
- 哈希基线（AC-12）：

```powershell
cd E:\Documents\GitHub\YingXiaoShang
Get-FileHash .scratch\run\B\home\news.db -Algorithm SHA256 |
  Format-List Path, Hash | Out-File .scratch\run\B\evidence\AC-12\hash-before.txt
# 跑完报告后同命令写入 hash-after.txt
```

- 复跑要求：所有 AC 必须能在同一副本上重复跑；第二次跑前不刷新副本，AC-11 的两次运行之间尤其不能重拷库。

证据存「命令原文 + 输出原文」而不是截图，失败才能在本地复盘；每条 AC 独立目录留痕的做法参照 fixture + 证据落盘的测试组织方式 [R34]。结构化结果落盘的口径与既有脚本 JSON 落盘方式一致（`services/news-crawler-py/scripts/live_check.py:106-109`）。

### 4.3 自检脚本与样例对照

- `docs/quality-report.sample.json` 作为字段基线：AC-03 核对键名/类型时与之逐字段对照；样例是静态文件，不被脚本覆盖。
- 文档自检命令见 §7；样例 JSON 本身应能被 `json.load` 解析。

## 5 反向验证（mutation）

执行约定：改坏一处 → 跑对应 AC 记录失败输出 → 还原 → 再跑记录通过输出；`git diff --stat` 确认只动了预期文件，`git status --porcelain` 对 `packages`、`apps/desktop`、`docs/contracts` 为空。本轮只允许改 `services/news-crawler-py/scripts/quality_report.py` 这一个本轮名下文件做临时 mutation，验收结束必须还原。

| # | 改坏哪里（具体到行/函数） | 预期变红的 AC | 还原后 |
|---|---|---|---|
| M1 | 计数 SQL 中把空标题判断 `TRIM(title) = ''` 改成 `title IS NULL`；STRICT 表 `title NOT NULL`（`services/news-crawler-py/src/news_crawler/db.py:25-31`），NULL 永不出现，`emptyTitleRatio` 恒 0 | AC-03（字段对账）、AC-07（结论与指标矛盾时可能误判 keep） | 变绿 |
| M2 | `percentile()` 把插值返回改成 `sum(values)/len(values)`（平均值冒充 P50） | AC-04 | 变绿 |
| M3 | 样本截断 `content[:200]` 改成 `content[:500]` | AC-05（`contentPreview` 长度 >200） | 变绿 |
| M4 | 删掉空表分支：`COUNT(*)=0` 时仍继续算比率，触发除零 | AC-08 | 变绿 |
| M5 | 样本排序去掉固定键（按行插入顺序取前 N），两次运行候选顺序随库返回顺序变化 | AC-11（diff 非空）、AC-05（样本集合漂移） | 变绿 |
| M6 | 脚本里临时加一句 `DELETE FROM news_articles`（或连接串去掉 `mode=ro`） | AC-12（源码扫描命中写语句 / 副本哈希变化） | 变绿 |

mutation 判据沿用 killed / survived 术语：用例变红 = killed，仍绿 = survived（说明用例没覆盖这条契约）；本轮只做手写改坏，不引入 Stryker 运行时 [R52][R53]。

## 6 排查表

| 症状 | 最可能原因 | 一条命令确认 |
|---|---|---|
| 退出码 1，消息「数据库打不开」 | `--db` 或 `NEWS_CRAWLER_DB` 路径写错、文件不可读或非 SQLite | `Test-Path $env:NEWS_CRAWLER_DB`；`Test-Path .scratch\run\B\home\news.db` |
| 退出码 1，消息「没有 news_articles 表」 | 副本是别的库（如只含章节表的夹具） | `.\.venv\Scripts\python.exe -c "import sqlite3; print(sqlite3.connect('file:.scratch/run/B/home/news.db?mode=ro', uri=True).execute(\"SELECT name FROM sqlite_master WHERE type='table'\").fetchall())"` |
| 退出码 2，消息「必须是 1 到 50 / 0 到 10 的整数」 | `--top`、`--samples-per-source` 非整数或越界 | 回看命令行参数值；对照契约 §2.6 范围 |
| 退出码 2，消息「数据库路径不能为空」 | `--db` 与 `NEWS_CRAWLER_DB` 都未提供有效路径 | `echo $env:NEWS_CRAWLER_DB`；检查 `--db` 是否传了目录 |
| 报告空表且指标全 null | 副本是空表，不是损坏 | `.\.venv\Scripts\python.exe -c "import sqlite3; print(sqlite3.connect('file:.scratch/run/B/home/news.db?mode=ro', uri=True).execute('SELECT COUNT(*) FROM news_articles').fetchone())"` |
| JSON 里中文乱码 | 写盘未指定 UTF-8 | 查脚本 `open(..., encoding='utf-8')` 与 `json.dumps(ensure_ascii=False)` |
| AC-11 diff 非空 | 没剔 `generatedAt` / `elapsedMs`；或样本排序键未固定 | `Compare-Object (Get-Content report-r1.json) (Get-Content report-r2.json)` 先看差异行是不是时间戳或耗时 |
| 副本数据偏旧 | WAL 副件 `-wal`/`-shm` 没一起复制 | `Get-ChildItem .scratch\run\B\home\data` 看副件是否齐全 |
| 导航命中比例虚高 | 词表过宽，合法用词被误判 | 抽一条命中样本看 `contentPreview` 与 `defects`，对照 `docs/news-source-quality.md` 词表 |
| 分位数与手算对不上 | 单元素/空数组分支写错，或插值位置写错 | 看 JSON `sampleSize` 与 `length.p10/p50/p90`；对照 03 §3.4 公式 |

排查按「症状 → 最可能原因 → 一条确认命令」组织；指标类症状必须落到 JSON 原文或 SQL 计数上，不看平均值描述 [R23]。

## 7 自检输出

文档自检是「交活前的最后一道机器闸」：它只查得到结构与引用是否对得上，查不到内容对不对——内容由 §3 的 12 条 AC 负责。这种「机器查形式、人查语义」的分工，是测试实践反复强调的底线 [R36]。

```powershell
cd E:\Documents\GitHub\YingXiaoShang
python plans\server-client-split\00-master\check-docs.py --round B
```

2026-11-19 实跑记录（按 02 契约改写后重跑 `python plans\server-client-split\00-master\check-docs.py --round B`，退出码 0）：

```text
仓库根：E:\Documents\GitHub\YingXiaoShang
检查轮次：B
行数统计：
  B-*: 1135 行 / 4 份

全部通过：轮次齐全、节数达标、每节有引用、参考清单与本地行号引用都对得上。
退出码：0
```

## 参考

- [R21] newspaper — https://github.com/codelucas/newspaper — 支撑 §1 按源统计与样本回溯的报告形态 — 借鉴结构，不引入抓取栈。
- [R23] CamDavidsonPilon/tdigest — https://github.com/CamDavidsonPilon/tdigest — 支撑 §6 分位数症状排查 — 了解近似结构；本轮精算排序。
- [R36] JavaScript Testing Best Practices — https://github.com/goldbergyoni/javascript-testing-best-practices — 支撑 §1 可机器判定口径与 §3 用例写法 — 采用可执行断言，不用人工观察。
- [R34] Playwright — https://playwright.dev/docs/intro — 支撑 §4 每 AC 独立证据目录与 fixture 组织 — 借鉴证据落盘思路，不引入其快照测试。
- [R45] SQLite Online Backup API — https://www.sqlite.org/backup.html — 支撑 §2.3 WAL 副本一致性前提 — 了解 `cp` 半写风险；停采状态下用副本。
- [R47] SQLite PRAGMA integrity_check — https://www.sqlite.org/pragma.html#pragma_integrity_check — 支撑 §6 损坏库排查 — 采用 quick_check 双档判断。
- [R52] Stryker JS — https://github.com/stryker-mutator/stryker-js — 支撑 §5 mutation 范式 — 借鉴 killed/survived，不引入运行时。
- [R53] Stryker 文档 — https://stryker-mutator.io/docs/ — 支撑 §5 报告口径 — 同上。
