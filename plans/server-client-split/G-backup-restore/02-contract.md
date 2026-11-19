# G · 备份与恢复 · 契约

> 轮次：G · 备份 / 恢复 / 演练工具
> 文档角色：02-contract
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1（§10.2 环境变量、§10.3 数据目录、§10.5 PostgreSQL；本文件只细化，不改端口、不改库名、不新增错误体系）
> 一句话：四个脚本的参数、退出码、manifest 字段、校验档位、抽样规则与报告骨架全部在本文写死，实现者与验收者照此对账。

## 1 契约总览

| 层 | 冻结（来自 `01-frozen-contracts.md`） | 本轮细化（本文件） |
|---|---|---|
| 运行环境 | §10.2 环境变量名；§10.5 `postgres:16-alpine`、库 `yxs`、用户 `yxs` | G 专用默认端口 `55433`、容器名 `yxs-pg-g`、恢复目标库前缀 `yxs_g_`（§2.1、§3.6） |
| 备份对象 | §10.3 业务库 `learning.db`；§10.5 迁移与备份只针对业务库，不含 `auth.db` | 表名集合、主键清单取自 `packages/db/src/index.ts:92-441`；`auth.db` 与文件产物不进入备份清单（§3.2） |
| SQLite 口径 | 需求文档 `docs/requirements/R17-local-data.md:78-82` 要求在线备份 | `.backup` 优先、`VACUUM INTO` 兜底；`quick_check` / `integrity_check` 两档的执行阶段（§3.5） |
| PG 口径 | §10.5 版本与类型映射；D 轮占用 `55432` / `yxs-pg-d` | `pg_dump --format=custom`；`pg_restore` 到隔离新库；禁用 `--clean`（§3.6） |
| 演练口径 | `02-ownership-and-parallel.md` §3 G 行：`.scratch/run/G/`、`g_backups/`、`55433`、`yxs-pg-g` | 「备份 → 删数据 → 恢复 → 行数 + 20 条样本核对」时序与报告骨架（§5、§3.7） |

**契约稳定性**：本文件的脚本名、参数名、退出码、manifest 字段名、错误中文消息、报告骨架字段视为 v1 冻结。新增可选字段允许（消费方必须忽略未知字段）；删改字段或改退出码语义需要升到 v2。备份工具的元信息清单与目录分层参照独立备份工具的成熟做法 [R51]，但不引入其加密仓库与快照链。

## 2 接口契约（CLI / stdout / 退出码）

### 2.1 连接与环境变量

连接参数读取顺序：命令行参数 > 环境变量 > 下表默认值。环境变量名与冻结 §10.2 一致；G 只把 `PGPORT` 默认值改为 `55433`。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PGHOST` | `127.0.0.1` | 本机演练实例 |
| `PGPORT` | `55433` | G 专用；D 轮为 `55432`，不得串用 |
| `PGDATABASE` | `yxs` | PG 源库名 |
| `PGUSER` | `yxs` | PG 用户名 |
| `PGPASSWORD` | （无默认，必填于环境） | 密码不写进命令行参数与文档；日志中连接串密码替换为 `***` |
| `YXS_G_BACKUP_DIR` | `<repo>/.scratch/run/G/g_backups` | 备份产物根目录 |
| `YXS_G_SAMPLE` | `20` | 每表抽样行数，可被 `--sample` 覆盖 |

受保护目录判定：源路径解析后命中 `%APPDATA%`、`~/.learning-agent`、`<repo>/.learning-agent` 之一时，脚本不执行备份或删除，退出码 1。演练对象只能是 `.scratch/run/G/` 下的副本。

### 2.2 `backup-sqlite.sh`（SQLite 在线备份）

命令形态（在仓库根执行）：

```powershell
bash tools/backup/backup-sqlite.sh --source .scratch/run/G/home/data/learning.db
```

| 参数 | 必填 | 类型 | 默认 | 边界与说明 |
|---|---|---|---|---|
| `--source <path>` | 是 | 路径 | — | SQLite 库副本路径；命中受保护目录 → 退出码 1 |
| `--out <dir>` | 否 | 目录 | `$YXS_G_BACKUP_DIR` | 备份根目录；不存在则递归创建 |
| `--host <name>` | 否 | 字符串 | 本机短名 | 命名目录第一段；非 `[a-z0-9-]` 字符归一为 `-` |
| `--method <auto\|backup\|vacuum>` | 否 | 枚举 | `auto` | `auto`：先试 `.backup`，失败回退 `VACUUM INTO`；`backup` 仅在线备份；`vacuum` 仅 `VACUUM INTO` |
| `--label <text>` | 否 | 字符串 | 空 | 自由备注，写入 `manifest.source.label`，不参与校验 |

stdout 逐行输出：`[backup-sqlite] source=<path>`、`[backup-sqlite] method=<backup|vacuum>`、`[backup-sqlite] artifact=<file>`、`[backup-sqlite] bytes=<n> sha256=<hex>`、`[backup-sqlite] quick_check=ok`、`[backup-sqlite] tables=<n>`。备份完成后必须跑 `quick_check`（§3.5），并写出 manifest 与抽样基线。

### 2.3 `restore-sqlite.sh`（SQLite 恢复 + 双档校验）

```powershell
bash tools/backup/restore-sqlite.sh --backup .scratch/run/G/g_backups/.../learning.db.sqlite --target .scratch/run/G/home/restored/learning.db
```

| 参数 | 必填 | 类型 | 默认 | 边界与说明 |
|---|---|---|---|---|
| `--backup <file>` | 是 | 路径 | — | 快照文件；不存在或打不开 → 退出码 2 |
| `--target <path>` | 是 | 路径 | — | 恢复目标文件；父目录不存在则递归创建 |
| `--manifest <file>` | 否 | 路径 | 快照同目录 `manifest.json` | 用于行数、抽样哈希与 sha256 复算核对 |
| `--integrity <quick\|full>` | 否 | 枚举 | `full` | `full`：quick_check 通过后再跑 integrity_check；`quick`：只跑快档（仅排查用，报告标注未跑全档） |
| `--sample <n>` | 否 | 整数 1..1000 | `$YXS_G_SAMPLE`（20） | 每表抽样比对行数 |

恢复前必须删除目标路径旁残留的 `<target>-wal`、`<target>-shm`；恢复后先 `quick_check`，`full` 模式下再 `integrity_check`（§3.5）。

### 2.4 `backup-pg.sh`（PG custom 格式备份）

```powershell
bash tools/backup/backup-pg.sh --db yxs
```

| 参数 | 必填 | 类型 | 默认 | 边界与说明 |
|---|---|---|---|---|
| `--db <name>` | 否 | 库名 | `$PGDATABASE` 或 `yxs` | 只备份指定业务库；不做 `pg_dumpall` 全实例导出 |
| `--out <dir>` | 否 | 目录 | `$YXS_G_BACKUP_DIR` | 同 §2.2 |
| `--host <name>` | 否 | 字符串 | 本机短名 | 同 §2.2 |

固定命令口径：`pg_dump --format=custom --no-owner --no-privileges --dbname=<db> --file=<artifact>`。`--no-owner` / `--no-privileges` 保证恢复到隔离库时不绑定原属主；custom 格式支持 `pg_restore -l` 列目录与选择性恢复 [R48]。备份前先做连接探测；导出后记录逐表行数与产物 sha256。

### 2.5 `restore-pg.sh`（PG 恢复到隔离新库）

```powershell
bash tools/backup/restore-pg.sh --backup .scratch/run/G/g_backups/.../yxs.dump
```

| 参数 | 必填 | 类型 | 默认 | 边界与说明 |
|---|---|---|---|---|
| `--backup <file>` | 是 | 路径 | — | custom 格式 dump；打不开或目录列表为空 → 退出码 2 |
| `--target-db <name>` | 否 | 库名 | `yxs_g_restore_<timestamp>` | 必须匹配 `^yxs_g_[a-z0-9_]+$`；脚本先 `createdb`，库已存在则退出码 1，不覆盖 |
| `--sample <n>` | 否 | 整数 1..1000 | 20 | 同 §2.3 |

**硬约束**：脚本内不得出现 `--clean`、`--if-exists`；调用方显式传入这两个参数之一 → 退出码 1。恢复只走 `pg_restore --dbname=<target-db> --no-owner --no-privileges <backup>`，不 `DROP DATABASE`、不 `DROP SCHEMA public CASCADE` 源库对象 [R49]。

### 2.6 `drill.sh`（演练编排，内部脚本）

| 参数 | 必填 | 类型 | 默认 | 边界与说明 |
|---|---|---|---|---|
| `--kind <sqlite\|pg>` | 是 | 枚举 | — | 选择演练链路 |
| `--source <path\|db>` | 是 | 路径或库名 | — | SQLite 副本路径 / PG 源库名 |
| `--sample <n>` | 否 | 整数 1..1000 | 20 | 同 §2.3 |
| `--report <file>` | 否 | 路径 | 本次备份目录下 `drill-report.md` | 报告落点；骨架字段见 §3.7 |

编排顺序固定为：备份 → 记录基线 → 删除演练数据 → 恢复 → 核对 → 写报告（§5 时序）。任一阶段失败即中断后续阶段，报告标 `FAIL` 并写明失败阶段。

### 2.7 退出码总表

| 退出码 | 含义 | 典型场景 |
|---|---|---|
| `0` | 成功 / 核对一致 | 备份完成且 quick_check 通过；恢复后双档校验与行数、抽样全绿；报告 `PASS` |
| `1` | 用法或参数错误、违反硬约束 | 缺必填参数；参数越界；源路径命中受保护目录；请求 `--clean` / `--if-exists`；目标库名不合规；目标库已存在 |
| `2` | 环境、连接、工具或数据合法性错误 | 缺 sqlite3 / pg_dump / pg_restore 客户端；PG 连不上；源库打不开；schema 版本非 7；表集合缺失；备份命令本身失败 |
| `3` | 校验不一致 | quick_check / integrity_check 非 `ok`；行数不等；抽样字段不等；产物 sha256 复算不符；表集合不一致 |

退出码 3 只属于校验与核对阶段；备份/恢复命令的执行失败归 2。同一脚本不混用两套语义。

## 3 数据结构（命名 / manifest / 抽样 / 校验档位）

### 3.1 备份产物命名规则（`host/path/timestamp`）

目录与文件名模板（`<root>` = `$YXS_G_BACKUP_DIR`）：

```text
<root>/<host>/<pathSlug>/<timestamp>/
  manifest.json                      # 本份备份的元信息清单
  <dbName>.<ext>                     # 快照 / dump 产物
  samples/<table>.json               # 基线抽样记录（每表一份）
  drill-report.md                    # 演练报告实例（仅 drill.sh 产出）
```

| 段 | 规则 | 示例 |
|---|---|---|
| `<host>` | `--host` 或本机短名；小写，非 `[a-z0-9-]` 归一为 `-` | `dev-laptop` |
| `<pathSlug>` | 源绝对路径去掉盘符与前导分隔符，目录分隔符、点、下划线外字符替换为 `-`，折叠连续 `-`，全部小写 | `.scratch/run/G/home/data/learning.db` → `scratch-run-g-home-data-learning-db` |
| `<timestamp>` | UTC，`YYYYMMDDTHHMMSSZ`，秒级 | `20261119T143012Z` |
| SQLite 产物名 | `<dbName>.sqlite`；`dbName` 取自 `packages/shared/src/brand.ts:13` 的 `learning.db` | `learning.db.sqlite` |
| PG 产物名 | `<dbName>.dump`，custom 格式 | `yxs.dump` |
| 抽样文件 | `samples/<table>.json`；表名保留 schema 原小写 | `samples/chapters.json` |

命名分层参照 restic 按主机与路径组织仓库的思路 [R51]；时间戳取 UTC 避免本机时区漂移导致同一次演练出现两个目录名。

### 3.2 `manifest.json` 字段表

| 字段 | 类型 | 可空 | 来源 | 示例值 |
|---|---|---|---|---|
| `manifestVersion` | string | 否 | 固定 `"1"` | `"1"` |
| `backupId` | string | 否 | `<host>-<pathSlug>-<timestamp>` | `dev-laptop-scratch-run-g-home-data-learning-db-20261119T143012Z` |
| `kind` | enum `sqlite` / `pg` | 否 | 脚本类型 | `"sqlite"` |
| `source.host` | string | 否 | §3.1 `<host>` | `"dev-laptop"` |
| `source.path` | string | 否 | SQLite 为源库绝对路径；PG 为库名 | `".scratch/run/G/home/data/learning.db"` |
| `source.dbName` | string | 否 | 文件名 / 库名 | `"learning.db"` |
| `source.schemaVersion` | int | 是 | SQLite `PRAGMA user_version`；PG 为 `null` | `7` |
| `source.label` | string | 是 | `--label` | `"drill baseline"` |
| `createdAt` | string | 否 | ISO-8601 UTC 带 `Z` | `"2026-11-19T14:30:12.000Z"` |
| `tool.name` | string | 否 | 脚本名 | `"backup-sqlite.sh"` |
| `tool.version` | string | 否 | 工具自身版本 | `"0.1.0"` |
| `tool.clientVersions` | object | 是 | 客户端 `--version` 输出首行 | `{"sqlite3":"3.45.1"}` |
| `artifact.fileName` | string | 否 | §3.1 产物名 | `"learning.db.sqlite"` |
| `artifact.format` | enum `sqlite-copy` / `custom` | 否 | 备份方法 | `"sqlite-copy"` |
| `artifact.bytes` | int | 否 | 产物字节数（`stat`） | `204800` |
| `artifact.sha256` | string | 否 | 产物文件 sha256 hex，64 位 | `"9f2c…e71a"` |
| `tables[]` | array | 否 | 备份前逐表读取 | 见 §3.3 |
| `checks.quickCheck` | enum `ok` / `fail` / `skipped` | 否 | 快档校验结果 | `"ok"` |
| `checks.integrityCheck` | enum `ok` / `fail` / `skipped` / `null` | 否 | 全档校验结果；备份侧为 `null` | `null` |
| `drillRef` | string | 是 | 关联演练报告路径 | `"./drill-report.md"` |

### 3.3 逐表条目与抽样记录

`tables[]` 每个元素：

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `name` | string | 否 | 表名，与 `packages/db/src/index.ts:92-441` 登记集合一致 |
| `rows` | int | 否 | 备份前 `SELECT count(*)` 行数 |
| `sizeBytes` | int | 是 | 表占用字节估算；SQLite 可由 `dbstat` 汇总，PG 由 `pg_relation_size`；取不到置 `null` |
| `sha256` | string | 否 | 排序后逐行摘要：每行拼 `<pk>|<col>=<value>` 文本，整表 sha256 hex；两侧同一口径 |

`samples/<table>.json` 结构：

```json
{
  "table": "chapters",
  "primaryKey": ["id"],
  "sampleSize": 20,
  "rows": [{ "pk": ["ch01"], "values": { "id": "ch01", "number": 1, "title": "…" } }]
}
```

### 3.4 20 条抽样的确定性规则

1. **排序键**：按主键升序取前 `n`（默认 20）。单列主键按该列；复合主键按主键列声明顺序逐列升序，如 `question_kps` 的 `(question_id, kp_id)`（`packages/db/src/index.ts:177`）。
2. **小表全量**：表内行数 ≤ `n` 时全表纳入比对，不抽样。
3. **同一 SQL**：备份前基线与恢复后核对使用同一条排序 SQL 文本；两侧按主键集合配对，逐列比较。
4. **取值口径**：`REAL` 列两侧差值 ≤ `1e-9`（相对误差）视为相等；JSON 列先解析再比较；`TEXT` 原样比较，不做 trim；`NULL` 只与 `NULL` 相等。
5. **无主键例外**：本 schema 全部业务表均有主键；若将来出现无主键表，登记到例外清单——SQLite 按 `rowid` 升序、PG 按 `ctid` 升序，并在抽样记录里写明 `sortKey`；**不使用随机抽样**。固定 seed 随机抽样仅作为无稳定排序键时的备选，必须在 manifest 记录 `samplingMethod` 与 seed 值。
6. **抽样可复现**：同一备份产物重复跑核对，选出的 20 条主键集合必须一致；不允许依赖物理存储顺序。

### 3.5 SQLite 校验档位（`quick_check` 与 `integrity_check` 阶段）

| 档位 | 执行阶段 | 说明 |
|---|---|---|
| `PRAGMA quick_check` | ① 备份产物落盘后（`backup-sqlite.sh` 内）；② 恢复完成后第一步（`restore-sqlite.sh` 内） | 快门槛：检查页结构与明显损坏，扫描成本低；备份侧用它确认产物可打开 |
| `PRAGMA integrity_check` | 仅 ② 恢复完成后、`quick_check=ok` 之后 | 全量门槛：逐页交叉校验；备份源库侧不跑，避免长扫描持锁影响在线副本 |

- 校验结果解析：首行文本为 `ok` 判通过；非 `ok` 时取首条结果行写入错误消息与报告。
- `--integrity quick` 跳过全档，但 manifest 的 `checks.integrityCheck` 必须记 `skipped`，报告标注「未跑全档校验」。
- 两档 pragma 的语义边界以 SQLite 官方文档为准 [R47]；脚本不自行扩展校验规则。

### 3.6 PG 恢复目标库命名与硬约束

- **目标库名**：默认 `yxs_g_restore_<timestamp>`（`<timestamp>` 同 §3.1）；`--target-db` 覆盖时必须匹配 `^yxs_g_[a-z0-9_]+$`，且库名不得为 `yxs`、`postgres`、`template0`、`template1`。
- **建库方式**：`createdb --host=<PGHOST> --port=<PGPORT> --username=<PGUSER> <target-db>`；目标库已存在 → 退出码 1，不覆盖、不清理。
- **禁止项**：恢复命令禁止 `--clean`、`--if-exists`；禁止 `DROP DATABASE <源库>`；禁止对源库 `yxs` 执行 `TRUNCATE` / `DROP TABLE`（演练删除只发生在隔离演练库 `yxs_g_drill` 或副本文件上）。
- **源库只读**：`backup-pg.sh` 期间不对源库执行任何写操作；连接失败归退出码 2。
- 恢复后核对口径与 SQLite 一致：表集合一致 → 行数 100% 比对 → 每表 20 条抽样字段比对（§3.4）。

### 3.7 `restore-drill.md` 报告骨架字段

报告分七段，字段名固定；实测值尚未跑出时填「待实测 + 测量方法」，不写虚构数值。

| 段 | 字段 | 说明 |
|---|---|---|
| 1 元信息 | `drillId`、`kind`、`startedAt`、`finishedAt`、`host`、`toolVersion`、`clientVersions`、`source` | 演练标识、类型、起止时间、工具与客户端版本、源标识 |
| 2 备份段 | `artifact`、`bytes`、`sha256`、`elapsedMs`、`checks`、`manifestRef` | 产物名、大小、哈希、备份耗时、校验档位结果、manifest 路径 |
| 3 删除段 | `target`、`method`、`deletedAt`、`rowsBefore`、`irreversibleNote` | 删除对象、方式（drop-file / truncate / drop-table）、时间、删除前行数、不可逆声明 |
| 4 恢复段 | `targetDb` / `targetPath`、`elapsedMs`、`restoreCommand`（密码脱敏）、`exitCode` | 恢复目标、恢复耗时、脱敏命令、退出码 |
| 5 核对段 | `tables[]`（`name`、`rowsBaseline`、`rowsAfter`、`sampleSize`、`sampleResult`、`hashResult`）、`firstDiff` | 逐表基线/恢复后行数、抽样与哈希结果、首处差异定位 |
| 6 结论 | `verdict`（`PASS` / `FAIL`）、`failedStage`、`reproduceCommand` | 总结论、失败阶段、可复跑命令 |
| 7 附录 | 环境变量脱敏表、stdout/stderr 摘录、已知限制 | 排查留痕；密码与连接串脱敏 |

耗时测量方法：阶段前后各取一次 UTC 时间戳，差值记毫秒；大小取产物 `stat` 字节数；哈希复算与备份时同一算法。报告骨架参照备份工具「每次演练留一份可审计记录」的惯例 [R50]。

## 4 错误与消息

错误码与退出码对应 §2.7；中文消息逐字如下，`<…>` 为运行时替换位。消息只进 stdout/stderr 文本，不附带英文堆栈；内部命令错误细节只写进工具自身日志行，不抛给调用方。

| 退出码 | 触发条件 | 中文消息（逐字） | 调用方应做什么 |
|---|---|---|---|
| 1 | 缺 `--source`（sqlite 备份） | `缺少必填参数 --source：SQLite 源库路径。` | 补源库副本路径后重跑 |
| 1 | 缺 `--backup` | `缺少必填参数 --backup：备份产物路径。` | 补快照 / dump 路径后重跑 |
| 1 | 缺 `--target`（sqlite 恢复） | `缺少必填参数 --target：恢复目标路径。` | 补目标路径后重跑 |
| 1 | 源文件不存在 | `找不到源数据库文件：<path>。` | 确认副本已复制到 `.scratch/run/G/` 下 |
| 1 | 路径命中受保护真实目录 | `源路径位于受保护的真实数据目录，请改用 .scratch/run/G/ 下的副本：<path>。` | 先复制副本到 scratch，再对副本操作 |
| 1 | `--sample` 非 1..1000 整数 | `--sample 必须是 1 到 1000 的整数。` | 调整抽样行数 |
| 1 | 请求 `--clean` / `--if-exists` | `禁止在恢复时使用 --clean；恢复目标必须是新建的隔离库。` | 去掉该参数；脚本固定恢复到新库 |
| 1 | 目标库名不合规 | `目标库名只能以 yxs_g_ 开头，后跟小写字母、数字或下划线：<name>。` | 改用默认时间戳库名或合规前缀名 |
| 1 | 目标库已存在 | `目标库已存在，为避免覆盖未执行恢复：<name>。` | 换库名，或确认后手工清理隔离库 |
| 2 | 客户端工具缺失 | `未找到 <tool>（sqlite3 / pg_dump / pg_restore），请先安装并确认在 PATH 中。` | 安装对应客户端后重跑 |
| 2 | PG 连接失败 | `无法连接 PostgreSQL：<原因>。请检查 PGHOST、PGPORT、PGUSER、PGPASSWORD。` | 确认 `yxs-pg-g` 实例在 `55433` 可达 |
| 2 | 源库打不开 | `打开源数据库失败：<原因>。` | 检查副本是否完整、是否被占用 |
| 2 | 备份命令失败 | `备份命令失败：<command>：<原因>。` | 看工具日志行定位客户端报错 |
| 2 | 备份产物无法打开 | `备份产物无法打开：<file>：<原因>。` | 重新生成备份；勿对损坏产物做恢复 |
| 2 | schema 版本不符 | `源库 schema 版本为 <v>，预期 7；请先在桌面端或 seed 流程跑齐本地迁移。` | 先跑齐本地迁移再备份 |
| 2 | 源库缺表 | `源数据库缺少表 <table>。` | 核对副本是否来自完整 seed 流程 |
| 3 | 快档校验失败 | `备份产物快速校验未通过：<file>：<首条结果>。` | 丢弃该产物，重新备份 |
| 3 | 全档校验失败 | `恢复库完整性检查未通过：<首条结果>。` | 检查快照与边车残留；必要时换备份恢复 |
| 3 | 行数不一致 | `行数不一致：表 <table> 备份前 <n> 行，恢复后 <m> 行。` | 按首处差异表排查恢复是否截断 |
| 3 | 抽样字段不等 | `抽样不一致：表 <table> 主键 <pk> 列 <column> 备份前=<…> 恢复后=<…>。` | 核对该行列值与类型映射 |
| 3 | 产物哈希不符 | `备份产物哈希不一致：文件 <file> 记录 sha256=<…>，复算=<…>。` | 产物可能被改动或损坏，重新备份 |
| 3 | 表集合不一致 | `表集合不一致：备份前有 <table>，恢复后缺失。` | 核对恢复日志是否跳过该表 |
| 0（提示） | 演练前置备份未校验通过 | `未执行删除：上一份备份校验未通过，演练已中止以保护数据。` | 先修复备份，再重跑演练 |

消息中的表名、列名、主键列名取自 schema 登记集合，不使用内部索引名；错误原因只给客户端命令的异常摘要，不打印整行数据与连接串密码 [R7]。

## 5 事件与序列

### 5.1 SQLite 演练时序

```text
t0  准备副本：把 seed 库复制到 .scratch/run/G/home/data/learning.db（不碰真实数据目录）
t1  backup-sqlite.sh
      ├─ 校验源路径非受保护目录、schemaVersion=7
      ├─ .backup 在线快照（失败回退 VACUUM INTO）→ 产物落盘
      ├─ quick_check 快档校验
      ├─ 逐表读行数、生成 samples/<table>.json 基线摘要
      └─ 写 manifest.json（bytes / sha256 / tables / checks）
t2  记录基线：manifest 中的行数与抽样哈希作为核对基准
t3  删除演练副本：关闭连接 → 删除主文件及 -wal / -shm 边车（或按表 DROP TABLE）
      └─ 删除前后行数、方式、时间写入报告删除段；此步不可逆
t4  restore-sqlite.sh
      ├─ 清理目标路径旁残留 -wal / -shm
      ├─ 恢复快照到 target
      ├─ quick_check → （full）integrity_check
      └─ 复算产物 sha256，与 manifest 比对
t5  核对：逐表行数比对 → 每表前 20 条抽样字段比对 → 表集合比对
t6  生成 drill-report.md：七段骨架填实测值，verdict=PASS/FAIL
```

### 5.2 PG 演练时序

```text
t1  backup-pg.sh
      ├─ 连接探测（PGHOST/PGPORT/PGUSER/PGPASSWORD）
      ├─ pg_dump --format=custom --no-owner --no-privileges → yxs.dump
      ├─ pg_restore -l 列目录确认产物可读
      └─ 写 manifest（逐表行数、bytes、sha256、clientVersions）
t2  基线：逐表行数与抽样记录落 samples/
t3  删除隔离演练库 yxs_g_drill 内业务表数据（TRUNCATE 全表 或 DROP 后重建空 schema）
      └─ 只作用于隔离演练库；源库 yxs 不执行任何写操作
t4  restore-pg.sh
      ├─ createdb yxs_g_restore_<timestamp>（已存在则退出码 1）
      ├─ pg_restore --no-owner --no-privileges（无 --clean）
      └─ 连接恢复库做核对准备
t5  核对：表集合 → 行数 100% → 每表 20 条抽样字段比对
t6  生成 drill-report.md；源库 yxs 行数在报告附录中复核为不变
```

### 5.3 失败事件与中断规则

- 任一阶段失败：后续阶段不再执行；报告 `verdict=FAIL`，`failedStage` 记失败阶段，`firstDiff` 记首处差异。
- 退出码归类：环境/连接/命令失败归 2；校验不一致归 3；参数与硬约束归 1。
- 中间产物保留在本次备份目录，不自动清理，便于排查；报告附录摘录失败阶段的 stdout/stderr。
- 删除阶段前置条件：上一份备份必须 `quick_check=ok` 且 sha256 可复算；不满足则中止删除并输出 §4 末条提示消息。

PG 导出与恢复的管线形态参照成熟 PG 复制工具的「先导出目录清单、再按目标库恢复」结构 [R52]；但本轮不引入其流式订阅与增量复制能力。

## 6 兼容与版本

- **manifest 演进**：`manifestVersion="1"`。消费方必须忽略未识别字段；新增可选字段不升版本；删除/改名字段、改退出码语义、改抽样排序键规则视为破坏性变更，升 v2 并在报告登记。元信息清单向后兼容的做法参照独立备份工具的 manifest 结构 [R51]。
- **SQLite 快照兼容**：单文件快照用同代或更高版本 sqlite3 可打开；不承诺跨大版本回灌，不在演练中验证降级打开。
- **PG dump 兼容**：custom 格式要求 `pg_restore` 版本 ≥ `pg_dump` 版本；跨大版本恢复属于升级场景，本轮不覆盖。
- **schema 硬校验**：`source.schemaVersion` 非 7 时退出码 2；表集合与 `packages/db/src/index.ts:92-441` 登记清单不一致时按 §4 表集合错误处理。
- **环境变量兼容**：变量名沿用冻结 §10.2，不新造私有变量名；G 专用默认值（`PGPORT=55433`、备份目录）只在脚本内兜底，不覆盖显式环境变量。
- **运行环境**：脚本为 bash 语法；Windows 下经 Git Bash 或 WSL 执行，前置客户端版本要求写进 `tools/backup/README.md`；工具自身无 Node 依赖（`02-ownership-and-parallel.md` §3）。
- **与 D 轮的兼容边界**：G 不读取 D 轮迁移产物作为前置；若 D 已在 `55432` 起库，G 连接串不得指向 `55432`，两套配置互不引用。

## 7 契约测试映射（给 G 轮自测与 E 轮对照）

| 契约点 | 用例编号 | 断言 |
|---|---|---|
| 备份不用文件复制 | `CT-G-01` | 脚本静态扫描无 `cp` 在线库文件；备份期间写入副本的一行数据存在于快照 |
| manifest 字段齐全 | `CT-G-02` | 解析 manifest，§3.2 必填字段非空；`artifact.sha256` 可对产物复算一致 |
| 校验档位阶段正确 | `CT-G-03` | quick_check 出现在备份后与恢复后；integrity_check 只出现在恢复后；备份侧 `integrityCheck=null` |
| PG 硬约束 | `CT-G-04` | 恢复命令行不含 `--clean` / `--if-exists`；目标库名前缀 `yxs_g_`；演练后源库 `yxs` 行数不变 |
| 行数 + 抽样核对 | `CT-G-05` | 全绿退出 0；人为改坏恢复后一行正文 → 退出 3，首处差异带表名、主键、列名、两侧取值 |
| 受保护路径拒绝 | `CT-G-06` | 源路径指向 `.learning-agent` / `%APPDATA%` → 退出 1 + 逐字中文消息 |
| 报告骨架齐全 | `CT-G-07` | 报告含 §3.7 七段字段；耗时、大小、校验结果三栏均有实测值或「待实测 + 测量方法」 |
| 资源隔离 | `CT-G-08` | 配置与日志只出现 `55433` / `yxs-pg-g` / `g_backups`；不出现 `55432` / `yxs-pg-d` |
| 边车残留清理 | `CT-G-09` | 恢复后目标目录无 `<db>-wal`、`<db>-shm`；残留场景下双档校验不报脏状态 |
| 哈希不符检出 | `CT-G-10` | 改动 manifest 中记录的 sha256 → 退出 3 + `备份产物哈希不一致` 消息 |
| 抽样确定性 | `CT-G-11` | 同一产物重复核对两次，选出的主键集合完全一致；小表全量纳入比对 |

用例编号一个编号一条断言，失败原因写进断言文本，便于报告直接指到「哪一条契约点挂了」；测试组织方式参照契约测试的分层惯例 [R36]，本轮自测不引入第三方测试框架。

## 参考

- [R7] OWASP REST Security Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html — 支撑 §4 错误消息不泄漏堆栈、整行数据与连接串密码 — 采用最小信息披露；不引入 API key 体系。
- [R45] SQLite Online Backup API — https://www.sqlite.org/backup.html — 支撑 §2.2 `.backup` 方法与 §5.1 时序 t1 — 采用在线备份一致性语义；不引入 C API 绑定。
- [R46] SQLite `VACUUM INTO` — https://www.sqlite.org/lang_vacuum.html — 支撑 §2.2 兜底方法与既有打包先例 — 作为 `.backup` 不可用时的等价快照；不作常规首选。
- [R47] SQLite `PRAGMA integrity_check` — https://www.sqlite.org/pragma.html#pragma_integrity_check — 支撑 §3.5 两档校验的阶段划分 — 采用 quick_check 快门槛 + integrity_check 全量门槛；备份侧不跑全档。
- [R48] `pg_dump` — https://www.postgresql.org/docs/current/app-pgdump.html — 支撑 §2.4 custom 格式与 `--no-owner` / `--no-privileges` 口径 — 采用 `-Fc`；不用 plain SQL 格式。
- [R49] `pg_restore` — https://www.postgresql.org/docs/current/app-pgrestore.html — 支撑 §2.5 与 §3.6 禁用 `--clean` 硬约束 — 恢复到全新隔离库；不清理源库对象。
- [R50] pgBackRest — https://pgbackrest.org/ — 支撑 §3.7 演练报告留痕与 §5 失败中断规则 — 借鉴「备份必须可验证、每次演练可审计」；不引入其 repo 与归档服务端。
- [R51] restic — https://github.com/restic/restic — 支撑 §3.1 `host/path/timestamp` 命名分层 — 借鉴目录组织与元信息清单；不引入加密仓库与去重快照链。
- [R52] dimitri/pgcopydb — https://github.com/dimitri/pgcopydb — 支撑 §5.3 PG 导出/恢复管线对照 — 借鉴目录清单先行、目标库独立指定；不引入流式复制。
- [R53] gabfl/pg_dump-to-s3 — https://github.com/gabfl/pg_dump-to-s3 — 支撑 §2.4 Shell 工具结构与 manifest 字段对照 — 借鉴 dump 产物 + 元信息清单；不做远程上传。
- [R54] stefanprodan/mgob — https://github.com/stefanprodan/mgob — 支撑 §5.3 失败分类与状态留痕 — 借鉴备份前后状态记录与失败阶段标记；不引入调度与通知。
- [R36] JavaScript Testing Best Practices — https://github.com/goldbergyoni/javascript-testing-best-practices — 支撑 §7 用例编号与断言组织 — 采用「一条编号一条断言、避免固定等待」；不引入其工具链。
