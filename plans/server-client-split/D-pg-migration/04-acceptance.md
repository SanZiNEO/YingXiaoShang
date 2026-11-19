# D · SQLite → PostgreSQL 迁移工具 · 验收

> 轮次：D · SQLite → PostgreSQL 迁移与校验工具
> 文档角色：04-acceptance
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1 §10.5（PostgreSQL 口径）
> 写权：[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1（`tools/migrate-pg/**` 归 D）
> 一句话：12 条 AC 全部可命令复现；迁移两遍行数不变、校验能抓出正文与哈希两类篡改、回滚默认只打印，证据全部落在 `.scratch/run/D/`。

**边界声明（与 03 一致）**：A 轮服务端运行时仍然读 SQLite，本工具不切换数据源；不改 `packages/db`，不改 `apps/server`。本验收只面向 `tools/migrate-pg/` 下的工具产物，不要求运行时连接 PG [R4]。

## 1 验收口径

**过 = 下列三组同时成立**：

1. **硬指标**：同一源库副本连跑两遍 `migrate.js`，PG 侧行数不变、无重复行；`verify.js` 对未改动副本退出 0 并输出 `[verify] ok`；故意改坏一条 `content` 与一条 `content_hash` 分别能被退出码 3 捕获；`rollback.js` 不带 `--apply` 时库表不变；DDL 抽查保留 `NOT NULL` 与 `jsonb` 类型；README 三条命令可直接粘贴执行。
2. **反向验证**：§5 的 6 个 mutation 每个都能让指定 AC 变红；改回后变绿。
3. **证据**：每条 AC 在 `.scratch/run/D/evidence/` 留下可复跑的日志、查询原文与 diff 记录。

不可替代项（不能用「手工看了一眼」代替）：两遍行数一致、第一处差异定位到表/主键/列、dry-run 不删表、`jsonb` 列类型抽查、隔离端口与容器名。

「可机器判定的才算验收」这条口径来自测试实践：断言写成可执行检查，而不是人工观察 [R7]。

## 2 前置条件

```powershell
cd E:\Documents\GitHub\YingXiaoShang

# 1) 隔离目录：源库只放 .scratch/run/D/，禁止指向真实数据目录
New-Item -ItemType Directory -Force .scratch\run\D\evidence | Out-Null

# 2) 准备 SQLite 副本（来源：seed 产物或既有演练副本；任选其一，禁止直接复制 %APPDATA% / ~/.learning-agent）
#    若仓库内暂时没有可用库副本，跳过依赖数据内容的 AC-D-02..08、10，并在证据目录标 skipped
Copy-Item <来源>\learning.db .scratch\run\D\learning.db

# 3) PG 连接环境变量（实例已由他人拉起；容器 yxs-pg-d，宿主端口 55432）
$env:PGHOST = '127.0.0.1'
$env:PGPORT = '55432'
$env:PGDATABASE = 'yxs'
$env:PGUSER = 'yxs'
$env:PGPASSWORD = 'yxs_local_pw'

# 4) 工具独立安装（不跑根 pnpm install，不进根 workspace）
pnpm --dir tools\migrate-pg install --ignore-workspace
```

缺什么就明说「缺则跳过并标记」：

- 没有 PG 实例（`55432` 不可达）：所有写 PG 的 AC 跳过，标 `skipped: PG unreachable`；不得伪造「通过」结论。
- 没有可用 SQLite 副本：数据类 AC 跳过；结构类 AC（参数错误、隔离端口、README 命令、dry-run 清单）仍可执行。
- 本机无 `psql`：DDL 抽查改用工具目录本地 `node_modules/pg` 跑 `information_schema` 查询，不依赖系统客户端。

源库版本基线：`PRAGMA user_version` 必须为 7（`packages/db/src/index.ts:850-851` 读版本、`:931` 收尾置 7）；低于 7 的副本按 AC-D-01 拦截 [R1]。

### 2.1 运行期资源对照（D 与 G 隔离）

| 项 | D 轮（本验收） | G 轮（对照，不得串用） |
|---|---|---|
| PG 宿主端口 | `55432` | `55433` |
| 容器名 | `yxs-pg-d` | `yxs-pg-g` |
| 数据卷 | `yxs-pg` | G 自有卷 |
| 库名 / 用户 | `yxs` / `yxs` | 各自实例 |
| 临时数据 | `.scratch/run/D/learning.db` | `.scratch/run/G/` |

源库副本的合法来源：seed 流程产出的 `learning.db`（计数摘要见 `pipeline/seed-db.ts:164-184`），或既有演练副本；桌面端首跑从 seed 资源复制库的现状见 `apps/desktop/src/main/index.ts:71-79`，但本验收不直接打开该真实位置。副本就位后以只读模式打开核对版本，不在副本目录留下 `-wal`/`-shm` 残留 [R4]。

## 3 用例清单

| 编号 | 操作 | 期望 | 失败判据 | 证据 |
|---|---|---|---|---|
| AC-D-01 | 副本就位后跑 `node tools/migrate-pg/migrate.js --source .scratch/run/D/learning.db --dry-run`；另备一个 `user_version < 7` 的副本试跑 | 正常副本打印 schema 计划与预计行数后退出 0；低版本副本退出 2，消息含「预期 7」 | 低版本副本退出 0；消息不含版本号；dry-run 实际建表 | `dry-run.txt`、`version-fail.txt` |
| AC-D-02 | 首跑 `node tools/migrate-pg/migrate.js --source .scratch/run/D/learning.db` | 退出 0；阶段行逐表输出 copy 行数；汇总行含 38 张表；PG 侧 38 张表存在 | 退出非 0；缺表；汇总表数 ≠ 38 | `migrate-1.log` |
| AC-D-03 | 同一源库再跑一遍 `migrate.js`（缺省幂等路径），逐表比对两遍 count(*) 与主键去重数 | 两遍后每表行数不变；`count(*) = count(DISTINCT <pk>)`，无重复行 | 第二遍后行数增加；存在重复主键 | `migrate-2.log`、`idempotent-counts.txt` |
| AC-D-04 | `node tools/migrate-pg/verify.js --source .scratch/run/D/learning.db` | 退出 0；输出 `[verify] ok: 38 tables, rows match, sample and hash check passed` | 退出非 0；抽样行被跳过；哈希未复算 | `verify-ok.log` |
| AC-D-05 | 用本地 `pg` 客户端改坏 PG 侧一条 `news_articles.content`（不动 `content_hash`），再跑 `verify.js` | 退出 3；打印第一处 `[verify] DIFF` 行，含表名 `news_articles`、文章主键、列名 `content`、两侧取值 | 退出 0；DIFF 行缺表名/主键/列名；一次报多行第一处之后的内容 | `verify-diff-content.log` |
| AC-D-06 | 还原 AC-D-05 的正文，只把该条 `content_hash` 改成另一串 sha256 hex，再跑 `verify.js` | 退出 3；打印 `[verify] HASH article=<id> source=<源哈希> recomputed=<复算哈希>` | 退出 0；HASH 行缺失；复算口径混入标题或摘要 | `verify-diff-hash.log` |
| AC-D-07 | `node tools/migrate-pg/rollback.js`（缺省 dry-run）；之后查表仍在 | 退出 0；输出 `[rollback] dry-run（未删除任何数据）` 与 38 张表的依赖逆序清单；PG 侧表全部仍在 | 表被删除；清单少于 38 张；无 dry-run 提示行 | `rollback-dry-run.log` |
| AC-D-08 | 查 `information_schema.columns` 抽查：`chapters.title` 为 `text NOT NULL`；`knowledge_points.keywords_json`、`artifacts.content_json` 为 `jsonb`；`skills.enabled` 为 `boolean` | 抽查列类型与可空性全部符合契约 §3.1；非空约束保留 | 任一抽查列类型不符；`NOT NULL` 丢失；jsonb 被建成 text | `ddl-check.txt` |
| AC-D-09 | 分别跑：不带 `--source`；`--sample 0`；`--sample abc` | 三种均退出 1；消息逐字匹配 §6：`缺少必填参数 --source：SQLite 源库路径。`、`--sample 必须是 1 到 1000 的整数。` | 退出 0 或 2；消息与合同不一致 | `param-fail.log` |
| AC-D-10 | 在副本某 `*_json` 列注入非 JSON 串（如 `{not-json`），跑 `migrate.js` | 退出 2；消息含表名、列名、主键与解析原因；不打印整行数据 | 退出 0；非法值进了 jsonb 列；消息无定位信息 | `json-bad.log` |
| AC-D-11 | 通读 `tools/migrate-pg/` 全部文件与 README：端口/容器/卷名只能出现 `55432`、`yxs-pg-d`、`yxs-pg`；不得引用 `55433`、`yxs-pg-g` | 隔离命名全部命中 D 轮；无 G 轮资源引用 | 出现 G 轮端口/容器名；连接默认指向 55433 | `isolation-grep.txt` |
| AC-D-12 | 照 README 三条命令原样粘贴执行：migrate、verify、rollback（dry-run） | 三条命令均按 README 描述退出；参数名与文档一致 | README 参数与脚本实际解析不一致；命令缺工作目录前提 | `README-commands.txt` |

用例写法遵循「一条 AC 一个可观察结果 + 明确失败判据」，避免「看起来正常」这类不可判定描述 [R7]。哈希口径只对正文 `content` 取 sha256 hex，依据 `packages/db/src/index.ts:2855` 写入哈希与 `:2889` 复算哈希 [R6]。

### 3.1 阶段行样例与判定点

migrate 首跑的 stdout 应按顺序出现下列阶段行（行数以源库实测为准，样例只标字段形态）：

```text
[migrate] source: .scratch/run/D/learning.db (schema version 7, 38 tables)
[migrate] target: postgres://yxs@127.0.0.1:55432/yxs
[migrate] schema: ok
[migrate] copy chapters 13
[migrate] copy sections 42
…
[migrate] done: 38 tables, <N> rows
```

判定点：`schema version 7`；表数 38；每表一条 `copy <table> <rows>`；目标行的密码已替换为 `***`，不出现明文 `PGPASSWORD`。verify 全绿时收尾行固定为 `[verify] ok: 38 tables, rows match, sample and hash check passed`。

### 3.2 篡改操作命令（AC-D-05 / AC-D-06）

在工具目录下用本地 `pg` 客户端直连演练库；先取一条有正文的文章 id，再分别做两类篡改：

```powershell
cd E:\Documents\GitHub\YingXiaoShang\tools\migrate-pg

# 取首条文章 id（双侧对照基线）
node --input-type=module -e "
import pg from 'pg'
const c = new pg.Client({host:process.env.PGHOST,port:Number(process.env.PGPORT),database:process.env.PGDATABASE,user:process.env.PGUSER,password:process.env.PGPASSWORD})
await c.connect()
const r = await c.query('SELECT id, length(content) AS len, content_hash FROM news_articles ORDER BY id LIMIT 1')
console.log(JSON.stringify(r.rows[0]))
await c.end()
"

# AC-D-05：只改正文，不动 content_hash
node --input-type=module -e "
import pg from 'pg'
const c = new pg.Client({host:process.env.PGHOST,port:Number(process.env.PGPORT),database:process.env.PGDATABASE,user:process.env.PGUSER,password:process.env.PGPASSWORD})
await c.connect()
await c.query(\"UPDATE news_articles SET content = content || ' ' WHERE id = (SELECT id FROM news_articles ORDER BY id LIMIT 1)\")
await c.end()
"

# AC-D-06：还原正文后，只把 content_hash 改成另一串 64 位 hex
node --input-type=module -e "
import pg from 'pg'
const c = new pg.Client({host:process.env.PGHOST,port:Number(process.env.PGPORT),database:process.env.PGDATABASE,user:process.env.PGUSER,password:process.env.PGPASSWORD})
await c.connect()
await c.query(\"UPDATE news_articles SET content_hash = '0000000000000000000000000000000000000000000000000000000000000000' WHERE id = (SELECT id FROM news_articles ORDER BY id LIMIT 1)\")
await c.end()
"
```

两类篡改各跑一次 `verify.js`，退出码必须为 3；AC-D-05 先还原正文与哈希再进入 AC-D-06，避免两类差异互相干扰。

## 4 证据

- 落点：`.scratch/run/D/evidence/<AC 编号>/`，每条 AC 一个目录；共享日志放 `.scratch/run/D/evidence/` 根目录。
- 文件清单：

| 证据文件 | 内容 | 产生方式 |
|---|---|---|
| `migrate-1.log` / `migrate-2.log` | 两遍 migrate 的完整 stdout 阶段行 | 命令输出重定向 |
| `idempotent-counts.txt` | 两遍后每表 `count(*)` 与 `count(DISTINCT pk)` 对照 | 本地 `pg` 查询脚本输出 |
| `verify-ok.log` | 全绿 verify 原文 | 命令输出重定向 |
| `verify-diff-content.log` / `verify-diff-hash.log` | 两类篡改后的退出码与 DIFF/HASH 行 | 篡改后重跑 verify |
| `rollback-dry-run.log` | dry-run 清单与「未删除」提示 | rollback 缺省执行 |
| `ddl-check.txt` | `information_schema` 抽查查询与结果 | 本地 `pg` 查询 |
| `param-fail.log` / `json-bad.log` / `version-fail.txt` | 退出码与中文消息原文 | 失败路径重跑 |
| `isolation-grep.txt` | 隔离命名 grep 结果 | `Select-String` 输出存档 |
| `perf.txt` | 两遍装载耗时与行数、RSS | `Measure-Command` + `process.memoryUsage()` |

目录落点结构：

```text
.scratch/run/D/
  learning.db                     # 源库副本（只读打开）
  evidence/
    migrate-1.log                 # 首跑阶段行
    migrate-2.log                 # 第二遍阶段行
    idempotent-counts.txt         # 两遍 count(*) / count(DISTINCT pk) 对照
    verify-ok.log                 # 全绿校验
    verify-diff-content.log       # 正文篡改后的 DIFF 行
    verify-diff-hash.log          # 哈希篡改后的 HASH 行
    rollback-dry-run.log          # dry-run 清单
    ddl-check.txt                 # information_schema 抽查结果
    param-fail.log                # 参数错误退出码与消息
    json-bad.log                  # 非法 JSON 拦截记录
    version-fail.txt              # 版本不符拦截记录
    isolation-grep.txt             # D/G 命名隔离 grep 存档
    perf.txt                      # 两遍耗时、行数、RSS
```

复跑要求：所有 AC 在同一副本上可重复跑；第二遍 migrate 之前不手工清库。证据存成「命令原文 + 输出原文」而不是截图，便于在 CI 里复盘 [R2]。

命令模板（PowerShell，仓库根为工作目录）：

```powershell
cd E:\Documents\GitHub\YingXiaoShang
node tools/migrate-pg/migrate.js   --source .scratch\run\D\learning.db 2>&1 | Tee-Object .scratch\run\D\evidence\migrate-1.log
node tools/migrate-pg/verify.js     --source .scratch\run\D\learning.db 2>&1 | Tee-Object .scratch\run\D\evidence\verify-ok.log
node tools/migrate-pg/rollback.js 2>&1 | Tee-Object .scratch\run\D\evidence\rollback-dry-run.log
```

## 5 反向验证（mutation）

| # | 改坏哪里 | 预期变红的 AC | 还原后 |
|---|---|---|---|
| M1 | `schema-map.js`：把一个 `*_json` 列的目标类型从 `jsonb` 改成 `text` | AC-D-08 | 变绿 |
| M2 | `verify.js`：抽样从「主键升序前 N 行」改成随机取行 | AC-D-03 复跑不稳定；AC-D-04/05 的抽样集合不可复现 | 变绿 |
| M3 | `rollback.js`：dry-run 分支直接执行 DROP，只在屏幕打印 | AC-D-07 | 变绿 |
| M4 | migrate 缺省路径：去掉 `ON CONFLICT DO UPDATE`，改成纯 `INSERT` | AC-D-03（第二遍出现重复主键） | 变绿 |
| M5 | verify 哈希复算：把 `title` 拼进 `sha256` 输入 | AC-D-06（误报或漏报 HASH 差异） | 变绿 |
| M6 | 连接默认配置：`PGPORT` 默认写成 `55433`、容器名引用 `yxs-pg-g` | AC-D-11 | 变绿 |

执行约定：

```powershell
cd E:\Documents\GitHub\YingXiaoShang
git diff --stat                       # 确认只改动 tools/migrate-pg/ 内预期文件
# 手工改坏 → 跑对应 AC → 记录失败输出 → 还原文件 → 再跑 → 记录通过输出
git status --porcelain packages apps  # 必须为空：共享包与服务端零改动
```

mutation 判据：用例变红 = killed，仍绿 = survived（说明用例没覆盖到这条契约）。术语参照 mutation 测试实践；本轮只维护 6 个手写 mutation，不引入 mutation 运行时 [R8]。

## 6 排查表

| 症状 | 最可能原因 | 一条命令确认 |
|---|---|---|
| migrate 启动即退出 2，消息 `无法连接 PostgreSQL` | PG 实例未起 / 端口不是 55432 / 密码错 | `Test-NetConnection 127.0.0.1 -Port 55432`；核对 `$env:PGPORT`、`$env:PGPASSWORD` |
| `源库 schema 版本为 <v>，预期 7` | 副本没跑齐本地迁移链 | `node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('.scratch/run/D/learning.db',{readOnly:true});console.log(d.prepare('PRAGMA user_version').get())"` |
| 装载某表报外键约束失败 | 拓扑序错（子表先于父表）或源数据参照不完整 | 看失败阶段行的表名；在 `schema-map.js` 依赖边里查父表是否先装载 |
| jsonb 列装载退出 2 | 历史脏值不是合法 JSON | 按消息里的表/列/主键回源库抽查该值；不在工具内静默兜底 |
| verify 行数不等但内容没改 | 第二遍 migrate 走了非幂等路径，或中途清过表 | 对照 `migrate-1.log`/`migrate-2.log` 行数；跑 `idempotent-counts.txt` 脚本 |
| verify 抽样一致但 HASH 行报错 | 正文在迁移中被改写（编码截断、转义变化），或哈希口径不一致 | 取 HASH 行里的文章 id，双侧比对 `content` 原文长度与字符 |
| rollback dry-run 清单缺表 | 登记表与 PG 实际表名集合不一致 | 对 `schema-map.js` 表清单与 `information_schema.tables` 做集合差 |
| 工具装不上依赖 | 误在仓库根跑了 `pnpm install`，或 `--ignore-workspace` 漏写 | `pnpm --dir tools\migrate-pg install --ignore-workspace`；查根 `pnpm-lock.yaml` 无改动 |
| AC-D-11 grep 命中 55433 | 复制了 G 轮配置片段 | `Select-String -Path tools\migrate-pg\* -Pattern "55433|yxs-pg-g"`，逐处改回 D 轮命名 |
| 时间戳列装载退出 2，消息 `非 ISO 取值` | 源库存了空串以外的占位串或本地时区串 | 按消息里的表/列/主键回源库抽查取值；确认是否符合 `toISOString()` UTC `Z` 口径 |
| 文本列出现 `U+FFFD` 替换字符 | 源库编码非 UTF-8 或读取解码错误 | 用只读连接查该列原始字节；对照 `packages/db/src/index.ts` 读取侧编码口径 |
| `rollback.js --apply` 退出 2，表没删成 | 单事务内某张表 DROP 失败（依赖占用/权限） | 重连后查表是否仍在；事务已整体回滚，不存在半删状态；修权限后重试 |
| `--sample abc` 被当成默认 20 | 参数解析没做整数与范围校验 | 查 `verify.js` 参数分支；必须退出 1 并报 `--sample 必须是 1 到 1000 的整数。` |
| dry-run 清单顺序与装载顺序相同 | 逆序拓扑没生效 | 核对 `rollback.js` 是否按依赖逆序排列；父表应排在子表之后删除 |

排查表按「症状 → 最可能原因 → 一条确认命令」组织；数据类症状必须落到双侧实际查询结果，不看平均值 [R3]。

## 7 自检输出

文档自检是「交活前的最后一道机器闸」：它只查得到结构与引用是否对得上，查不到内容对不对——内容由 §3 的 12 条 AC 负责。这种「机器查形式、人查语义」的分工，是测试实践里反复强调的底线 [R7]。

```powershell
cd E:\Documents\GitHub\YingXiaoShang
python plans\server-client-split\00-master\check-docs.py --round D
```

实跑输出（2026-11-19，退出码 0；行数统计随文档微调变化，以最后一次为准）：

```text
仓库根：E:\Documents\GitHub\YingXiaoShang
检查轮次：D
行数统计：
  D-*: 1563 行 / 4 份

全部通过：轮次齐全、节数达标、每节有引用、参考清单与本地行号引用都对得上。
退出码：0
```

## 参考

- [R1] pgloader — https://github.com/dimitri/pgloader — 支撑 §2 源库基线与 §3 类型/批量对照 — 借鉴映射表与批量装载思路；不用它跑本轮迁移。
- [R2] PostgreSQL `COPY` — https://www.postgresql.org/docs/current/sql-copy.html — 支撑 §4 证据装载通道与日志留痕 — 采用 CSV 格式 `COPY … FROM STDIN`。
- [R3] SQLite 数据类型亲和性 — https://www.sqlite.org/datatype3.html — 支撑 §6 排查表按列声明核对 — 按列类型比对，不按抽样值猜类型。
- [R4] SQLite STRICT tables — https://www.sqlite.org/stricttables.html — 支撑 §1 边界与 §3 AC-D-08 约束保留 — `NOT NULL` / `DEFAULT` 必须在目标库保留。
- [R5] PostgreSQL 事务与 `TRUNCATE` — https://www.postgresql.org/docs/current/sql-truncate.html — 支撑 §3 AC-D-07 回滚边界 — 只 DROP 本轮登记表，禁止 `TRUNCATE` 共享库。
- [R6] PostgreSQL `INSERT … ON CONFLICT` — https://www.postgresql.org/docs/current/sql-insert.html — 支撑 §3 AC-D-03 幂等口径 — 主键冲突更新；重复执行不产生重复行。
- [R7] JavaScript Testing Best Practices — https://github.com/goldbergyoni/javascript-testing-best-practices — 支撑 §1 可机器判定口径与 §3 用例写法 — 采用可执行断言，不用人工观察。
- [R8] golang-migrate/migrate — https://github.com/golang-migrate/migrate — 支撑 §5 mutation 可重复执行形态 — 借鉴「迁移状态可追踪、可重跑」；不引入其 Go 运行时。
