# 备份 / 恢复演练规程（restore-drill.md）

本文件规定 `drill.sh` 的演练步骤、不可逆保护边界、失败中断规则与演练报告七段骨架字段。
编排由 `tools/backup/drill.sh` 执行；备份、恢复动作分别由 `backup-sqlite.sh` / `restore-sqlite.sh` /
`backup-pg.sh` / `restore-pg.sh` 完成，本规程不重复实现备份、校验、哈希、manifest 与比对逻辑。

## 1. 适用范围与对象

- 演练对象只能是 `.scratch/run/G/` 下的 SQLite 副本，或 G 轮隔离 PG 演练库 `yxs_g_drill`。
- 真实数据目录（`%APPDATA%`、`~/.learning-agent`、`<repo>/.learning-agent`、`$LEARNING_AGENT_HOME`）
  一律拒绝作为备份源或删除目标，命中即退出码 1。
- SQLite 业务库为 `data/learning.db`；`auth.db` 与 `artifacts/`、`exports/`、`raw/`、`spill/`
  文件产物不在本轮备份范围。
- PG 源库为 `yxs`，全程只读；恢复只落新建的 `yxs_g_` 前缀隔离库。

## 2. 八步演练规程

时序对应 `plans/server-client-split/G-backup-restore/02-contract.md` §5.1（SQLite）与 §5.2（PG）。

### 2.1 步骤总览

| 步 | 阶段函数（固定名） | 动作 | 产物 / 留痕 |
|---|---|---|---|
| 1 | 准备（脚本外 / 前置） | 建隔离目录：`.scratch/run/G/home/`、`.scratch/run/G/g_backups/`、`.scratch/run/G/evidence/`；把 seed 库复制为演练副本，不碰真实数据目录 | 演练副本 |
| 2 | `stage_backup` | 调 `backup-sqlite.sh`（SQLite）或 `backup-pg.sh`（PG）；产物 + manifest 落 `g_backups/` | 快照 / dump、`manifest.json`、`samples/<table>.json` 基线 |
| 3 | `stage_baseline` | 载入 manifest：`tables[].rows` 行数与 `samples/<table>.json` 指纹作为核对基准 | 基线行数、基线抽样 |
| 4 | 删除前预检（前置闸） | 确认上一份备份 `checks.quickCheck == "ok"`，且产物 sha256 经 `yxs_py hash` 复算与 `artifact.sha256` 一致 | 闸口通过 / 中止 |
| 5 | `stage_delete` | 仅删除隔离对象：SQLite 关闭连接后删主文件及 `-wal` / `-shm` 边车（drop-file），或按表删；PG 只在 `yxs_g_drill` 内 TRUNCATE / 重建空 schema | 删除对象、方式、时间、删除前行数 |
| 6 | `stage_restore` | SQLite 调 `restore-sqlite.sh` 到目标路径；PG 先 `createdb yxs_g_restore_<timestamp>` 再 `pg_restore` | 恢复库 / 恢复目标库 |
| 7 | `stage_verify` | 表集合一致 → 行数 100% 比对 → 每表前 `--sample` 条抽样字段与整表摘要比对（`yxs_py compare`） | 逐表核对结果、首处差异 |
| 8 | `stage_report` | 按 §5 七段骨架填实测值，落 `--report` 指定文件；`verdict=PASS/FAIL` | `drill-report.md` |

### 2.2 SQLite 时序（§5.1）

```text
t0  准备副本：把 seed 库复制到 .scratch/run/G/home/data/learning.db（不碰真实数据目录）
t1  backup-sqlite.sh
      ├─ 校验源路径非受保护目录、schemaVersion=7
      ├─ 在线快照（CLI .backup → Python Connection.backup() → VACUUM INTO 兜底）→ 产物落盘
      ├─ quick_check 快档校验
      ├─ 逐表读行数、生成 samples/<table>.json 基线摘要
      └─ 写 manifest.json（bytes / sha256 / tables / checks）
t2  记录基线：manifest 中的行数与抽样哈希作为核对基准
t3  删除演练副本：关闭连接 → 删除主文件及 -wal / -shm 边车（或按表 DROP TABLE）
      └─ 删除前后行数、方式、时间写入报告删除段；此步不可逆
t4  restore-sqlite.sh
      ├─ 清理目标路径旁残留 -wal / -shm
      ├─ 恢复快照到 target
      ├─ quick_check →（full）integrity_check
      └─ 复算产物 sha256，与 manifest 比对
t5  核对：逐表行数比对 → 每表前 N 条抽样字段比对 → 表集合比对
t6  生成 drill-report.md：七段骨架填实测值，verdict=PASS/FAIL
```

### 2.3 PostgreSQL 时序（§5.2）

```text
t1  backup-pg.sh
      ├─ 连接探测（PGHOST/PGPORT/PGUSER/PGPASSWORD）
      ├─ pg_dump --format=custom --no-owner --no-privileges → yxs.dump
      ├─ pg_restore -l 列目录确认产物可读
      └─ 写 manifest（逐表行数、bytes、sha256、clientVersions）
t2  基线：逐表行数与抽样记录落 samples/
t3  删除隔离演练库 yxs_g_drill 内业务表数据（TRUNCATE 全表 或 DROP 后重建空 schema）
      ├─ 库不存在则 createdb yxs_g_drill，并把本次备份 pg_restore 进去（空库没有可删对象，删了不证明任何事）
      ├─ 表清单由 psql 现查并落临时文件（错误进 $?，不用进程替换吞错）
      ├─ 逐表 TRUNCATE，删除后复算总行数必须为 0，否则判 FAIL
      └─ 只作用于隔离演练库；源库 yxs 不执行任何写操作
t4  restore-pg.sh
      ├─ createdb yxs_g_restore_<timestamp>（已存在则退出码 1）
      ├─ pg_restore --no-owner --no-privileges（无 --clean）
      └─ 连接恢复库做核对准备
t5  核对：表集合 → 行数 100% → 每表 N 条抽样字段比对
t6  生成 drill-report.md；源库 yxs 行数在报告附录中复核为不变
```

## 3. 不可逆保护

1. **删除前置闸**：进入删除阶段前，上一份备份必须 `checks.quickCheck == "ok"`，且产物 sha256
   用 `yxs_py hash --path` 复算结果与 manifest `artifact.sha256` 一致。任一不满足，不执行任何删除，
   逐字打印：`未执行删除：上一份备份校验未通过，演练已中止以保护数据。`，并以退出码 0 中止演练。
   中止时报告取值：`verdict=FAIL`、`failedStage=stage_delete`、`method=null`、`deletedAt=null`，
   「前置闸未通过、未执行删除、副本文件与行数未变」写入 `irreversibleNote`；不使用冻结枚举之外的取值。
2. **目标隔离闸**：
   - SQLite 删除目标必须位于 `<repo>/.scratch/run/G/` 白名单内；`yxs_is_protected` 命中的路径直接退出码 1。
   - SQLite 恢复目标（`--restore-target`，默认 `.scratch/run/G/home/restored/learning.db`）同样过保护闸：
     命中受保护目录、等于 `--source`、或是既有目录 → 退出码 1，且在**任何** `rm` / `mkdir` / `cp` 之前拦下。
     原因：恢复会先删目标旁的 `-wal` / `-shm`，边车里未 checkpoint 的写入会随之丢失。
   - PG 删除只允许作用于隔离演练库 `yxs_g_drill`；源库 `yxs` 全程只读，不执行 `TRUNCATE` / `DROP TABLE`。
   - PG 删除阶段先确认演练库存在（不存在则 `createdb` 并 `pg_restore` 灌入本次备份），再枚举表清单，
     TRUNCATE 后复算总行数必须为 0；任何一步失败都判 `verdict=FAIL`，`method` / `deletedAt` 记 `null`。
3. **删除方式受限**：SQLite 只允许 drop-file（删主文件及 `-wal` / `-shm` 边车）或对隔离演练库删表；
   绝不对真实数据目录或源库动手。
4. **留痕**：删除动作执行前在日志打印计划（对象、方式、基线行数、不可撤销提示）；删除时间、方式、
   删除前行数写入报告删除段；中间产物保留在本次备份目录，不自动清理。
5. **PG 恢复硬约束**：恢复目标必须是新建的 `yxs_g_` 前缀隔离库；恢复命令不带 `--clean` / `--if-exists`；
   不 `DROP DATABASE`、不清理源库对象。

## 4. 失败中断规则（§5.3）

- 任一阶段失败：后续阶段不再执行；报告 `verdict=FAIL`，`failedStage` 记失败阶段，`firstDiff` 记首处差异。
- 退出码归类：
  - `1` 用法 / 参数错误、违反硬约束（缺必填参数、参数越界、命中受保护目录、PG 目标库名不合规或已存在等）；
  - `2` 环境、连接、工具或数据合法性错误（缺客户端、PG 连不上、源库打不开、schema 版本不符、表集合缺失、备份命令失败）；
  - `3` 校验不一致（quick_check / integrity_check 非 ok、行数不等、抽样字段不等、产物哈希不符、表集合不一致）。
- 中间产物保留在本次备份目录，不自动清理，便于排查；报告附录摘录失败阶段的 stdout / stderr。
- 删除前置条件不满足时按 §3 第 1 条中止，退出码 0，副本文件与行数保持不变。
- 校验类失败（码 3）不自动重试：先复盘保留下来的产物，不要重跑覆盖证据。

## 5. 演练报告七段骨架字段表（§3.7）

字段名冻结；未跑到的字段记 `null` 或标注测量方法，不写虚构数值。耗时取阶段前后 UTC 时间戳差值（毫秒），
大小取产物 `stat` 字节数，哈希复算与备份时同一算法。

| 段 | 字段 | 含义 / 测量口径 |
|---|---|---|
| 1 元信息 | `drillId` | 演练标识，取 manifest `backupId` |
| 1 元信息 | `kind` | `sqlite` / `pg` |
| 1 元信息 | `startedAt` | 演练开始 UTC ISO-8601（毫秒位固定 `.000`） |
| 1 元信息 | `finishedAt` | 演练结束 UTC ISO-8601 |
| 1 元信息 | `host` | 本机短名归一化后的 slug |
| 1 元信息 | `toolVersion` | 工具自身版本（`yxs_version`） |
| 1 元信息 | `clientVersions` | 客户端版本（sqlite3 CLI 或 Python stdlib sqlite；PG 为 pg_dump / pg_restore / psql 首行） |
| 1 元信息 | `source` | 源标识：SQLite 路径 / PG 库名，含 dbName、schemaVersion、label |
| 2 备份段 | `artifact` | 产物文件名 |
| 2 备份段 | `bytes` | 产物字节数（`stat`） |
| 2 备份段 | `sha256` | 产物 sha256 hex，64 位 |
| 2 备份段 | `elapsedMs` | 备份阶段前后 UTC 时间差（毫秒） |
| 2 备份段 | `checks` | `quickCheck` / `integrityCheck` 档位结果 |
| 2 备份段 | `manifestRef` | manifest.json 落点 |
| 3 删除段 | `target` | 删除对象（副本路径 / 隔离演练库名） |
| 3 删除段 | `method` | `drop-file` / `truncate` / `drop-table`；未执行删除（前置闸中止）记 `null` |
| 3 删除段 | `deletedAt` | 删除时间 UTC ISO-8601；未执行删除记 `null` |
| 3 删除段 | `rowsBefore` | 删除前行数（manifest 基线汇总） |
| 3 删除段 | `irreversibleNote` | 不可逆声明：只动隔离对象、源库与受保护目录未触碰、恢复依赖校验通过的快照 |
| 4 恢复段 | `targetDb` / `targetPath` | PG 恢复目标库名 / SQLite 恢复目标路径（按库型其一） |
| 4 恢复段 | `elapsedMs` | 恢复阶段前后 UTC 时间差（毫秒） |
| 4 恢复段 | `restoreCommand` | 脱敏后的恢复命令；密码位置写 `***` |
| 4 恢复段 | `exitCode` | 恢复脚本退出码 |
| 5 核对段 | `tables[]` | 逐表条目：`name`、`rowsBaseline`、`rowsAfter`、`sampleSize`、`sampleResult`、`hashResult`；`sampleSize = min(rowsBaseline, --sample)`，空表记 0，小表全量纳入；`sampleResult` / `hashResult` 取 `compare` 真实结果 |
| 5 核对段 | `firstDiff` | 首处差异定位（kind / table / pk / column / baseline / candidate）；全等记 `null` |
| 6 结论 | `verdict` | `PASS` / `FAIL`；前置闸保护中止仍记 `FAIL`（`failedStage=stage_delete`），退出码 0 |
| 6 结论 | `failedStage` | 失败阶段函数名；全绿记 `null` |
| 6 结论 | `reproduceCommand` | 可复跑命令（脱敏） |
| 7 附录 | `env` | 环境变量脱敏表（`PGPASSWORD` 只记是否已设置，不记明文） |
| 7 附录 | `stdout` | 阶段 stdout / stderr 摘录 |
| 7 附录 | `limitations` | 已知限制与 skip 说明 |

## 6. 最近一次演练实例落点

- 落点规则：报告与本次备份同目录，即
  `<YXS_G_BACKUP_DIR>/<host>/<pathSlug>/<timestamp>/drill-report.md`；
  `--report` 显式指定路径时以该路径为准。
- 备份产物根目录默认为 `<repo>/.scratch/run/G/g_backups`，可用 `YXS_G_BACKUP_DIR` 覆盖。

### 实跑实例（2026-11-20，Windows 本机 `desktop-8e2vlhj`，Git Bash 5.2.37，Python 3.13.18 / stdlib sqlite 3.53.1）

#### 6.1 SQLite 闭环 · 显式抽样 20（AC-G-05）

命令（仓库根执行，`YXS_G_BACKUP_DIR` 指到本轮隔离备份目录）：

```bash
YXS_G_BACKUP_DIR=<repo>/.scratch/run/G/drill/g_backups \
bash tools/backup/drill.sh --kind sqlite \
  --source .scratch/run/G/drill/home/data/learning.db \
  --sample 20 \
  --restore-target .scratch/run/G/drill/home/restored/learning.db
```

实测结果：退出码 `0`；报告 `verdict: PASS`、`failedStage: null`；核对段 38 张表，
`rowsBaseline` 合计 4126，`firstDiff: null`；备份 `quick_check=ok`，恢复后
`quick_check=ok`、`integrity_check=ok`，`rows=4126`、`samples=38`；附录环境变量
`YXS_G_SAMPLE=20`。逐表 `sampleSize = min(rowsBaseline, 20)`，抽查：
`chapters=13`（小表全量）、`news_articles=20`（大表取抽样数）、`question_attempts=0`（空表），
38 表 `sampleSize` 均为数值、无 `None`。
报告落点：`.scratch/run/G/drill/g_backups/desktop-8e2vlhj/scratch-run-g-drill-home-data-learning-db/20261120T041235Z/drill-report.md`；
副本：`.scratch/run/G/evidence/AC-G-05/drill-report-explicit.md`；
stdout 留痕：`.scratch/run/G/evidence/AC-G-05/stdout.txt`。

#### 6.2 SQLite 闭环 · 省略 `--sample`（默认 20）

命令：

```bash
YXS_G_BACKUP_DIR=<repo>/.scratch/run/G/drill/g_backups \
bash tools/backup/drill.sh --kind sqlite \
  --source .scratch/run/G/drill/home/data/learning.db \
  --restore-target .scratch/run/G/drill/home/restored/learning.db
```

实测结果：退出码 `0`；`verdict: PASS`；38 张表、行数合计 4126、`firstDiff: null`，
`sampleSize` 38 表均为数值；未传 `--sample` 时走 `yxs_sample ""` 取 `YXS_G_SAMPLE` / 默认 20，
附录 `YXS_G_SAMPLE=20`。
报告落点：`.scratch/run/G/drill/g_backups/desktop-8e2vlhj/scratch-run-g-drill-home-data-learning-db/20261120T041552Z/drill-report.md`；
副本：`.scratch/run/G/evidence/AC-G-05/drill-report-default.md`；
stdout 留痕：`.scratch/run/G/evidence/AC-G-05/stdout-no-sample.txt`。

#### 6.3 删除前置闸中止反例（AC-G-09）

构造：取上一次通过校验的备份目录，仅将 manifest `artifact.sha256` 改为 64 个 `0`
（表级样本哈希与 `quickCheck` 保持原样，JSON 结构合法）；经自检复用入口
`YXS_REUSE_MANIFEST` 指向该 manifest，跳过本次备份直接载入清单。

命令：

```bash
YXS_G_BACKUP_DIR=<repo>/.scratch/run/G/drill/g_backups \
YXS_REUSE_MANIFEST=<tampered manifest.json> \
bash tools/backup/drill.sh --kind sqlite \
  --source .scratch/run/G/drill/home/data/learning.db \
  --sample 20 \
  --restore-target .scratch/run/G/drill/home/restored/learning.db \
  --report .scratch/run/G/evidence/AC-G-09/abort-report.md
```

实测结果：退出码 `0`；stdout 逐字打印
`未执行删除：上一份备份校验未通过，演练已中止以保护数据。`；报告
`verdict: FAIL`、`failedStage: stage_delete`、`method: null`、`deletedAt: null`、
`rowsBefore: 4126`，原因写入 `irreversibleNote`。演练副本前后不变量
`unchanged: true`（exists / length=3469312 / LastWriteTime / sha256 完全一致），
未执行任何删除。证据：`.scratch/run/G/evidence/AC-G-09/abort-plan.txt`、
`before-after.json`、`abort-report.md`、`abort-stdout.txt`。

#### 6.4 PostgreSQL 链路（本机 skipped）

本机无 `pg_dump` / `pg_restore` / `psql` / `createdb` 与 55433 实例，PG 链路只验证参数与守卫路径：
退出码 `2`（环境类），`failedStage: stage_backup`，附录
`limitations: skipped: no PG client/server`，不伪造 PASS。
证据：`.scratch/run/G/evidence/AC-G-pg/skip-report.md`、`skip-stdout.txt`。

复跑方式：在装有与 `postgres:16` 同代 PG 客户端、`yxs-pg-g` 可达（`PGHOST=127.0.0.1`、
`PGPORT=55433`）的环境，设置 `PGUSER=yxs`、`PGPASSWORD`（只从环境读）后执行：

```bash
bash tools/backup/drill.sh --kind pg --source yxs --sample 20
```

## 7. 复跑命令（Git Bash）

```bash
cd /e/Documents/GitHub/YingXiaoShang

# SQLite 演练（隔离副本）
bash tools/backup/drill.sh --kind sqlite \
  --source .scratch/run/G/home/data/learning.db \
  --sample 20

# PG 演练（需 yxs-pg-g 实例可达且 PG 客户端在 PATH）
bash tools/backup/drill.sh --kind pg --source yxs --sample 20
```

报告默认落在本次备份目录下的 `drill-report.md`；可用 `--report <file>` 改落点，
SQLite 可用 `--restore-target <path>` 指定恢复目标路径。
