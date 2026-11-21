# G · 备份与恢复 · 实现方案

> 轮次：G · 备份与恢复
> 文档角色：03-implementation
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1
> 写权：[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1（`tools/backup/**` 归 G）
> 一句话：五个 shell/Python 脚本把「SQLite 在线快照 + PG custom 格式导出 → 校验 → 恢复到新库/临时路径 → 隔离演练删后恢复」做成可命令复现、失败可定位、半成品可追溯的闭环。

## 1 目录与模块

目录树（均在 `tools/backup/` 下，G 轮唯一写权范围，见 [`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1）：

```text
tools/backup/
  backup-sqlite.sh        # SQLite 在线备份：选方法 → 落快照 → quick_check → 写 manifest
  restore-sqlite.sh       # SQLite 恢复到 --target 路径 → 双档校验 → 行数/样本比对
  backup-pg.sh            # PostgreSQL pg_dump -Fc → 连接探测 → sha256 → 写 manifest
  restore-pg.sh           # PostgreSQL 恢复到隔离新库；拒绝 --clean、拒绝打源库
  drill.sh                # 内部编排：备份 → 基线 → 删除演练数据 → 恢复 → 核对 → 写报告
  restore-drill.md        # 演练规程与报告骨架（02-contract §3.7 七段字段）
  src/common.sh           # 可选公共函数库：参数解析、退出码、中文消息、路径安全、manifest/指纹共用函数
```

职责边界（与 `02-contract.md` §2.2–§2.6 对齐）：

| 文件 | 只干 | 不许干 |
|---|---|---|
| `backup-sqlite.sh` | 只读打开源库；写备份目录下的快照与 manifest | 不删源库、不写源库目录、不复制 `-wal`/`-shm` 当快照 |
| `restore-sqlite.sh` | 把快照恢复到 `--target` 指定路径；双档校验恢复库 | 不覆盖正在被服务打开的源库；不自动停业务进程 |
| `backup-pg.sh` | 经 `pg_dump` 对指定源库做一致性快照；写 manifest | 不连源库以外的业务库；不输出明文密码到日志 |
| `restore-pg.sh` | 新建隔离目标库并 `pg_restore` 进去；校验行数与样本 | 不传 `--clean`/`--if-exists`；不恢复到源库名 |
| `drill.sh` | 按 §3.10 时序编排五个阶段，失败即中断并写报告 | 不跳过备份校验直接删数据；不把删除动作作用到源库 |
| `restore-drill.md` | 规定演练步骤、不可逆保护、报告骨架字段 | 不是可执行脚本本身；编排由 `drill.sh` 按本规程串联 |
| `src/common.sh` | 退出码常量（0/1/2/3）、`fail()` 中文消息、`sha256_file()`、指纹函数、路径白名单校验 | 不直接调业务库；不含环境相关的硬编码路径 |

产物命名借鉴快照式备份仓库的 `host/path/timestamp` 惯例：`<db-name>-<YYYYMMDDTHHMMSS>.<ext>`，同一目录内按时间戳天然排序，便于后续保留策略裁剪 [R51]。README 原始清单里的 `backup.sh`/`restore.sh`/`drill.sh`/`lib/*.sh` 分组方式与上表一一对应：`backup-sqlite.sh` + `backup-pg.sh` 对应 `backup.sh` 按库型拆分，`restore-drill.md` 对应 `drill.sh` 的规程与 `drill-report.md` 的报告落点；分组以本文件为准，README 保持原样不改写。

## 2 依赖与构建

### 2.1 运行时依赖（不引入新运行时）

| 依赖 | 用途 | 缺失时的分支 |
|---|---|---|
| `sqlite3` CLI | SQLite `.backup` 在线快照 [R45] | 回退 Python 标准库 `sqlite3`；再不行回退 `VACUUM INTO` [R46] |
| Python 3（标准库 `sqlite3`、`hashlib`、`json`、`argparse`/`shutil`） | 无 CLI 时的备份兜底、manifest 生成、行数与样本指纹比对 | 本机已核实 Python 3.13.18、stdlib sqlite3 3.53.1 可用 |
| `pg_dump` / `pg_restore` | PostgreSQL custom 格式导出与恢复 [R48][R49] | 本机 PATH 未安装；从 `yxs-pg-g` 容器内执行，或装匹配版本的 PG 客户端 |
| `gzip`（可选） | 快照压缩；缺省时落未压缩文件，manifest 标注 `compressed: false` | 不把压缩做成硬前置 |
| shell | `bash` 4+ | 脚本是 `.sh`，不在 PowerShell 内联执行 |

不引入 Node 依赖、不进 pnpm workspace：`tools/backup/` 不在 `pnpm-workspace.yaml` 的三条 glob 内（[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §2），也不需要 `pnpm install`。

### 2.2 执行环境说明（Windows 现实约束）

- 脚本形态是 `.sh`，**实际执行环境**为 Git Bash、WSL 或 CI Linux；仓库本机是 Windows + PowerShell 7，验收时按下面两种方式之一调用：
  - Git Bash / WSL 已安装：在 PowerShell 里 `bash -lc 'tools/backup/backup-sqlite.sh --source ... --out ...'`；
  - 未装 bash：SQLite 分支用 `python -c` 走标准库兜底完成同一步骤并读 manifest 确认结果；PG 分支在 `yxs-pg-g` 容器内执行。
- 本机 2026-11-19 实测：`bash`、`sqlite3`、`pg_dump`、`pg_restore`、`gzip` 均不在 PATH（命令 `Get-Command` 逐一核实）；Python 3.13.18 在 PATH。因此本机验收 SQLite 走 Python 兜底分支，PG 相关 AC 依赖容器或标记 `skipped`，不伪造通过。
- 隔离数据目录：所有备份/演练对象只能是 `.scratch/run/G/` 下的副本；备份产物根目录为 `.scratch/run/G/g_backups`（环境变量 `YXS_G_BACKUP_DIR`）；真实数据目录（`%APPDATA%`、`~/.learning-agent`、`<repo>/.learning-agent`）在路径校验阶段直接拒绝（见 §5、§6）。

### 2.3 构建与自检

本目录无编译步骤。交付前跑文档自检：

```powershell
cd E:\Documents\GitHub\YingXiaoShang
python plans\server-client-split\00-master\check-docs.py --round G
```

## 3 关键实现

### 3.1 通用约定：manifest、命名、dry-run

每次备份在产物同目录写 `manifest.json`，字段以 `02-contract.md` §3.2 为准（恢复与演练都以它为对账依据）：

```json
{
  "manifestVersion": "1",
  "backupId": "dev-laptop-scratch-run-g-home-data-learning-db-20261119T143012Z",
  "kind": "sqlite",
  "source": { "host": "dev-laptop", "path": ".scratch/run/G/home/data/learning.db", "dbName": "learning.db", "schemaVersion": 7, "label": null },
  "createdAt": "2026-11-19T14:30:12.000Z",
  "tool": { "name": "backup-sqlite.sh", "version": "0.1.0", "clientVersions": { "sqlite3": "3.45.1" } },
  "artifact": { "fileName": "learning.db.sqlite", "format": "sqlite-copy", "bytes": 0, "sha256": "" },
  "tables": [ { "name": "chapters", "rows": 0, "sizeBytes": null, "sha256": "" } ],
  "checks": { "quickCheck": "ok", "integrityCheck": null },
  "drillRef": null
}
```

- `createdAt` 用 UTC ISO 8601 带 `Z`；`artifact.bytes`（产物字节数）与 `artifact.sha256` 在产物写完后、封 manifest 前计算；manifest 自身不被哈希。
- `tables[]` 逐表登记 `name` / `rows`（备份前 `SELECT count(*)`）/ `sizeBytes?` / 整表摘要 `sha256`；抽样基线另落 `samples/<table>.json`（§3.9）。
- `checks.quickCheck` 取值 `ok / fail / skipped`；`checks.integrityCheck` 备份侧为 `null`，恢复侧记 `ok / fail / skipped`（§3.4）。
- 校验没过的产物保留不删，在报告与 stdout 标失败阶段；manifest 不另设私有 `status` 字段，结论由退出码与 `checks` 段表达（§6）。
- 删除阶段前置条件：上一份备份 `quickCheck=ok` 且 sha256 可复算；不满足则中止删除并输出 02 §4 末条提示消息（§3.11）。

### 3.2 SQLite 备份分支选择

源库是 WAL 模式运行中的 `learning.db`，仓内已有在线快照的先例：`scripts/package-desktop.mjs:52-58` 用 `VACUUM INTO` 取一致副本，注释写明「writes a consistent copy without the WAL sidecar」——这就是「不能 `cp` 正在写的库」的仓内证据。方法由 `--method auto|backup|vacuum` 选择（默认 `auto`，契约见 02 §2.2）：

| 序 | 条件 | 分支 | 说明 |
|---|---|---|---|
| 1 | `sqlite3` CLI 在 PATH，点命令 `.backup` 可用（首跑把 `sqlite3 --version` 记入 `tool.clientVersions`） | `.backup` 在线备份 | 走 Online Backup API，读写并发下拿到一致性快照 [R45] |
| 2 | 无 CLI，但 Python ≥ 3.11 且 stdlib sqlite3 可用 | Python `Connection.backup()` | 同一套在线备份 API 的标准库封装；`--method backup` 走此路径 |
| 3 | `--method vacuum`，或在线分支均不可用 | `VACUUM INTO` | 单文件一致副本，不带 WAL 侧车 [R46] |
| — | 任何分支都不可用 | 退出码 2 | 未找到客户端工具；不允许退回文件复制 |

`.backup` 分支伪代码：

```sh
# backup-sqlite.sh（--method backup / auto 首试）
sqlite3 "$SRC_DB" ".backup '$DST_DB'"
# 退出码非 0 → 记日志；auto 下回退 VACUUM INTO；仍失败走 §6 退出码 2
```

Python 兜底伪代码（在线 API 的标准库封装）：

```python
import sqlite3
src = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True)
dst = sqlite3.connect(str(dst_path))
with dst:
    src.backup(dst)
src.close(); dst.close()
```

`VACUUM INTO` 兜底伪代码（对齐仓内既有写法 `scripts/package-desktop.mjs:56`）：

```sh
sqlite3 "$SRC_DB" "VACUUM INTO '$DST_DB'"
```

### 3.3 `-wal` / `-shm` 处理

- 三个在线分支产出的都是单文件自包含快照；**不**把 `learning.db-wal`、`learning.db-shm` 复制进备份目录。在线备份 API 会把 WAL 中已提交内容并入快照 [R45]；`VACUUM INTO` 同理不带侧车（`scripts/package-desktop.mjs:52-53` 注释）。
- 若源库被判定为「必须整目录复制」的离线场景（本工具不提供该分支，仅作反例说明），三件套 `.db`/`-wal`/`-shm` 必须一起复制，只复制 `.db` 会丢最近写入（`docs/requirements/R17-local-data.md:80-81`）。
- 备份前探测同目录是否存在 `-wal` 侧车并把侧车字节数记进 manifest `source` 段；侧车很大时在报告里提示「快照前建议落盘 checkpoint」，但不主动对源库执行 `PRAGMA wal_checkpoint`（那是写操作，越出只读边界，见 §4）。
- 恢复侧清理：`restore-sqlite.sh` 写快照前，先删除目标路径旁残留的 `<target>-wal`、`<target>-shm`；恢复后目标目录不得残留边车文件（02 §2.3、CT-G-09）。

### 3.4 校验：`quick_check` 与 `integrity_check` 的时机

| 校验 | 时机 | 范围 | 不通过的处理 |
|---|---|---|---|
| `PRAGMA quick_check` | ① 备份产物落盘后（`backup-sqlite.sh` 内）；② 恢复完成后第一步（`restore-sqlite.sh` 内） | 快门槛：页结构与明显损坏 [R47] | 退出码 3；产物保留待复盘，manifest `checks.quickCheck=fail` |
| `PRAGMA integrity_check` | 仅 ② 恢复完成后、`quick_check=ok` 之后；备份源库侧不跑 | 全量门槛：逐页交叉校验 [R47] | 退出码 3；恢复库标记损坏，源备份不删；`--integrity quick` 时记 `skipped` |

伪代码：

```sh
# 备份后（副本上）
sqlite3 "$DST_DB" "PRAGMA quick_check;"   # 期望单行 ok
# 恢复后（恢复库上）：先 quick_check，full 模式再 integrity_check
sqlite3 "$RESTORED_DB" "PRAGMA quick_check;"
sqlite3 "$RESTORED_DB" "PRAGMA integrity_check;"
```

Python 等价：`con.execute("PRAGMA quick_check").fetchone()[0] == "ok"`。两档分开：备份侧只用 `quick_check` 控时长；全档 `integrity_check` 只在恢复侧跑，避免长扫描持锁影响在线副本（02 §3.5）。校验结果解析：首行文本为 `ok` 判通过；非 `ok` 取首条结果行写入错误消息与报告。

### 3.5 SQLite 恢复

- 命令参数（02 §2.3）：`--backup <file>`（必填，快照文件）、`--target <path>`（必填，恢复目标文件）、`--manifest <file>`（默认快照同目录 `manifest.json`）、`--integrity <quick|full>`（默认 `full`）、`--sample <n>`（默认 `$YXS_G_SAMPLE`=20）。
- 恢复前置：`--backup` 不存在或打不开 → 退出码 2（`备份产物无法打开：<file>：<原因>。`）；目标父目录不存在则递归创建；恢复前清理目标旁残留 `-wal`/`-shm`。
- 恢复步骤：清理边车残留 → 写快照到 `--target` → `quick_check` → `full` 模式再 `integrity_check` → 复算产物 sha256 与 manifest 比对 → 行数比对 → 样本指纹比对。
- 仓内库有 `application_id` 与 `user_version` 门禁（`packages/db/src/index.ts:841-853`）：`source.schemaVersion` 非 7 → 退出码 2，消息 `源库 schema 版本为 <v>，预期 7；请先在桌面端或 seed 流程跑齐本地迁移。`；不绕开门禁，也不修改库内 PRAGMA。

### 3.6 PG 备份（`pg_dump -Fc`）

命令参数（02 §2.4）：`--db <name>`（默认 `$PGDATABASE` 或 `yxs`，不做 `pg_dumpall` 全实例导出）、`--out <dir>`（默认 `$YXS_G_BACKUP_DIR`）、`--host <name>`（命名目录段）。连接走 `PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD`，见 §5。

固定命令口径：

```sh
pg_dump --format=custom --no-owner --no-privileges \
  --dbname="$DB_NAME" --file="$ARTIFACT"
```

- 选 `--format=custom`：支持 `pg_restore -l` 列目录与选择性恢复，比 plain SQL 更适合「恢复到新库再校验」的闭环 [R48]；不选 plain 格式。
- `--no-owner --no-privileges`：目标库角色可能与源库不一致，避免恢复卡在所有权赋值上。
- 连接探测先行：连不上 → 退出码 2（`无法连接 PostgreSQL：<原因>。请检查 PGHOST、PGPORT、PGUSER、PGPASSWORD。`）；`pg_dump` 客户端缺失 → 退出码 2（`未找到 <tool>（sqlite3 / pg_dump / pg_restore），请先安装并确认在 PATH 中。`）。
- 版本记录：`pg_dump --version`（客户端）首行写入 `tool.clientVersions`；服务端 `SHOW server_version` 记入报告附录；客户端/服务端跨大版本属升级场景，本轮不覆盖（02 §6）。
- 导出后用 `pg_restore -l` 确认产物 TOC 可读；备份期间源库是一致性快照，`pg_dump` 不对源库执行任何写操作 [R48]；不执行 `pg_dump --clean`，也不产出 plain 脚本。

### 3.7 PG 恢复：只到新库，拒绝 `--clean`

命令参数（02 §2.5）：`--backup <file>`（必填，custom 格式 dump）、`--target-db <name>`（默认 `yxs_g_restore_<timestamp>`）、`--sample <n>`（默认 20）。

恢复编排：

```sh
NEWDB="yxs_g_restore_$(date +%Y%m%dT%H%M%SZ)"
createdb --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" "$NEWDB"
pg_restore --dbname="$NEWDB" --no-owner --no-privileges "$DUMP_FILE"
```

实现层的硬约束：

1. **拒绝 `--clean` / `--if-exists`**：脚本内不得出现这两个开关；调用方显式传入之一 → 退出码 1，消息 `禁止在恢复时使用 --clean；恢复目标必须是新建的隔离库。`；`pg_restore` 调用行永远不含它们。`--clean` 会在恢复前删目标库对象，打到既有库上等于毁库 [R49]。
2. **目标库名合规**：`--target-db` 必须匹配 `^yxs_g_[a-z0-9_]+$`，且不得为 `yxs`、`postgres`、`template0`、`template1`；不合规 → 退出码 1，消息 `目标库名只能以 yxs_g_ 开头，后跟小写字母、数字或下划线：<name>。`。
3. **拒绝覆盖既有库**：`createdb` 报已存在时不降级为连接既有库继续恢复；退出码 1，消息 `目标库已存在，为避免覆盖未执行恢复：<name>。`。
4. **禁止源库写操作**：不 `DROP DATABASE <源库>`，不对源库 `yxs` 执行 `TRUNCATE` / `DROP TABLE`；演练删除只发生在隔离演练库 `yxs_g_drill` 或副本文件上（02 §3.6）。

恢复后在新库上跑表集合 → 行数 → 样本字段比对（§3.9）；源库行数在备份前与恢复后各取一次，在报告附录复核为不变。

### 3.8 manifest 生成与 sha256

```sh
sha256sum "$ARTIFACT" | awk '{print $1}'
```

- 哈希对象是备份产物本身；字节数取 `stat`，分别写入 `artifact.fileName` / `artifact.bytes` / `artifact.sha256`（02 §3.2）。
- manifest 内容：`manifestVersion`、`backupId`、`kind`、`source` 段、`createdAt`、`tool` 段、`artifact` 段、`tables[]`（`name`/`rows`/`sizeBytes?`/`sha256`）、`checks` 段、`drillRef`；不另设私有 `status` 字段。
- 恢复侧对账：重算产物 sha256，与 `artifact.sha256` 比对；不一致 → 退出码 3，消息 `备份产物哈希不一致：文件 <file> 记录 sha256=<…>，复算=<…>。`，不进入恢复。

### 3.9 行数比对与 20 条抽样指纹

表清单来自 `packages/db/src/index.ts:92-441` 登记集合；核心抽样表取学生可见的 10 张：`chat_sessions`、`chat_messages`、`memory_facts`、`memory_episodes`、`artifacts`、`question_attempts`、`evidence`、`student_profiles`、`news_articles`、`knowledge_points`。

行数 SQL（SQLite 与 PG 同形），结果写进 `tables[].rows`：

```sql
SELECT count(*) FROM <table>;
```

抽样规则（02 §3.4，确定性、可复现）：

1. **排序键**：按主键升序取前 `n`（`--sample`，默认 `$YXS_G_SAMPLE`=20，合法 1..1000）；复合主键按列声明顺序逐列升序（如 `question_kps` 的 `(question_id, kp_id)`，`packages/db/src/index.ts:177`）。
2. **小表全量**：表内行数 ≤ `n` 时全表纳入比对，不抽样。
3. **同一 SQL**：备份前基线与恢复后核对使用同一条排序 SQL 文本；两侧按主键集合配对，逐列比较。
4. **取值口径**：`REAL` 列两侧差值相对误差 ≤ `1e-9` 视为相等；JSON 列先解析再比较；`TEXT` 原样比较不 trim；`NULL` 只与 `NULL` 相等。
5. **无主键例外**：本 schema 业务表均有主键；将来出现无主键表，SQLite 按 `rowid`、PG 按 `ctid` 升序并在抽样记录写明 `sortKey`；不使用随机抽样。

```sql
-- SQLite / PG 通用形态；<pk> 取表主键
SELECT * FROM <table> ORDER BY <pk> ASC LIMIT <n>;
```

整表摘要指纹（写入 `tables[].sha256`）：每行拼 `<pk>|<col>=<value>` 文本，整表 sha256 hex；两侧同一口径。抽样记录落 `samples/<table>.json`：

```json
{
  "table": "chapters",
  "primaryKey": ["id"],
  "sampleSize": 20,
  "rows": [{ "pk": ["ch01"], "values": { "id": "ch01", "number": 1, "title": "…" } }]
}
```

- 比对口径：备份前基线 vs 备份副本；基线 vs 恢复库。表集合一致 → 行数 100% 比对 → 样本字段比对；任一表不等，报告定位到「表名 + 主键 + 列名 + 两侧取值」（02 §4 消息口径）。
- PG 侧取数用 `COPY (SELECT ... ORDER BY <pk> ASC LIMIT <n>) TO STDOUT WITH (FORMAT csv, HEADER false)`，落临时 CSV 后交 Python 计算摘要。

### 3.10 演练规程（`restore-drill.md`）

`drill.sh` 参数（02 §2.6）：`--kind <sqlite|pg>`（必填）、`--source <path|db>`（必填）、`--sample <n>`（默认 20）、`--report <file>`（默认本次备份目录下 `drill-report.md`）。固定时序，顺序即报告章节：

1. **建隔离目录**：`.scratch/run/G/home/`、`.scratch/run/G/g_backups/`、`.scratch/run/G/evidence/`；源库只取 `.scratch/sample-home/data/learning.db` 的副本。
2. **备份**：跑 `backup-sqlite.sh`（SQLite 演练）或 `backup-pg.sh`（PG 演练），产物 + manifest 落 `g_backups/`。
3. **基线快照**：`tables[].rows` 行数与 `samples/<table>.json` 指纹作为核对基准。
4. **删除前预检**：确认上一份备份 `quickCheck=ok` 且 sha256 可复算；不满足则中止删除，输出 §3.11 的保护消息，后续阶段不再执行。
5. **删除演练数据（仅隔离对象）**：SQLite 关闭连接后删除主文件及 `-wal`/`-shm` 边车，或按表 `DROP TABLE`；PG 演练只在隔离演练库 `yxs_g_drill` 内 `TRUNCATE` 全表或 `DROP` 后重建空 schema。删除前后行数、方式、时间写入报告删除段。
6. **恢复**：SQLite `restore-sqlite.sh` 到新临时路径；PG `createdb yxs_g_restore_<timestamp>` 后 `pg_restore`。
7. **复校**：表集合一致 → 行数逐表相等 → 每表 `--sample` 条样本字段与摘要指纹逐表相等。
8. **出报告**：按 02 §3.7 七段骨架填实测值（时间、源、产物 sha256、删除方式、恢复耗时、校验结果、`verdict=PASS/FAIL`），落 `--report` 指定文件。

### 3.11 不可逆保护

- **删除前置条件**：上一份备份必须 `quickCheck=ok` 且 sha256 可复算；不满足则不执行任何删除，消息 `未执行删除：上一份备份校验未通过，演练已中止以保护数据。`（02 §4 末条）。
- **目标隔离闸**：路径必须在 `.scratch/run/G/` 白名单内；PG 删除只作用于 `yxs_g_drill` 这类带 `drill` 后缀的隔离库，不能是 `$PGDATABASE` 源库 `yxs`；源库全程只读。
- **留痕**：删除动作执行前在 stdout 打印计划（对象、方式、预估行数、不可撤销提示）；日志记录时间、命令行（密码脱敏）；中间产物保留在本次备份目录，不自动清理。
- **受保护目录拒绝**：源路径解析后命中 `%APPDATA%`、`~/.learning-agent`、`<repo>/.learning-agent` 之一 → 退出码 1，消息 `源路径位于受保护的真实数据目录，请改用 .scratch/run/G/ 下的副本：<path>。`，不执行备份或删除。

## 4 数据读写

| 操作 | 读 | 写 | 事务/边界 |
|---|---|---|---|
| SQLite 备份 | 源库以 `mode=ro` URI 只读打开 | `g_backups/` 下快照、manifest | 在线备份 API 内部页级一致性；工具自身不开写事务 [R45] |
| SQLite 恢复 | 备份快照 | `--target` 路径新库；报告所需 `restore.json` | 不覆盖源库；恢复库校验通过前不改名替换任何在跑库 |
| PG 备份 | 源库（`pg_dump` 一致性快照） | `g_backups/` dump、manifest | 不在源库建临时表、不写源库业务表 |
| PG 恢复 | dump 文件 | 新建 `yxs_g_restore_<ts>` 隔离库 | `pg_restore` 在新库内执行；遇错即停，不回写源库 |
| 演练删除 | 基线行数/指纹 | 仅 `.scratch/run/G/` 副本、`yxs_g_drill` 库 | 删除前过备份校验预检；源库全程只读 |

- 源库门禁：`packages/db/src/index.ts:841-853` 的 `application_id`/`user_version` 校验属于业务库启动逻辑；备份工具不绕开门禁，也不修改库内 PRAGMA。
- 并发假设：备份期间业务可能在写；在线分支依赖备份 API 的一致性保证 [R45]，不靠「停服务再复制」。恢复与演练必须在业务停写或隔离副本上做。
- 日志不落敏感信息：PG 连接串里密码在日志中替换为 `***`，命令行历史不出现 `PGPASSWORD` 明文（`PGPASSWORD` 只从环境读）。

## 5 配置

### 5.1 环境变量（与冻结表一致）

| 变量 | 默认 | 作用 | 谁设 |
|---|---|---|---|
| `PGHOST` | `127.0.0.1` | PG 主机 | 调用方 / 容器 compose |
| `PGPORT` | `55433` | G 轮专用 PG 端口（D 轮为 55432，不得串用，[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §3） | 调用方 |
| `PGDATABASE` | `yxs` | 源库名；恢复目标禁止等于它 | 调用方 |
| `PGUSER` | `yxs` | PG 用户 | 调用方 |
| `PGPASSWORD` | 无（必填于环境） | 密码；不写命令行参数、不进 manifest | 调用方 |
| `YXS_G_BACKUP_DIR` | `<repo>/.scratch/run/G/g_backups` | 备份产物根目录 | 调用方 / 脚本兜底 |
| `YXS_G_SAMPLE` | `20` | 每表抽样行数，可被 `--sample` 覆盖 | 调用方 / 脚本兜底 |
| `LEARNING_AGENT_HOME` | `<repo>/.learning-agent` | 受保护目录判定时识别真实 home | 调用方 |

PG 连接口径来自冻结契约 §10.5：`postgres:16-alpine`、库 `yxs`、用户 `yxs`，密码来自环境（示例值 `yxs_local_pw` 仅本地演练用，不写进脚本默认值）。`PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD` 是 `pg_dump`/`pg_restore` 原生识别的标准连接变量，脚本不另造连接参数名 [R48]。

### 5.2 命令行参数表

| 参数 | 适用脚本 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `--source <path>` | `backup-sqlite.sh`、`drill.sh` | 是 | — | SQLite 库副本路径；命中受保护目录 → 退出码 1 |
| `--out <dir>` | `backup-sqlite.sh`、`backup-pg.sh` | 否 | `$YXS_G_BACKUP_DIR` | 备份根目录；不存在则递归创建 |
| `--host <name>` | `backup-sqlite.sh`、`backup-pg.sh` | 否 | 本机短名 | 命名目录第一段；非 `[a-z0-9-]` 归一为 `-` |
| `--method <auto\|backup\|vacuum>` | `backup-sqlite.sh` | 否 | `auto` | `auto` 先 `.backup` 失败回退 `VACUUM INTO`；`backup` 仅在线备份；`vacuum` 仅 `VACUUM INTO` |
| `--label <text>` | `backup-sqlite.sh` | 否 | 空 | 自由备注，写入 `manifest.source.label`，不参与校验 |
| `--backup <file>` | `restore-sqlite.sh`、`restore-pg.sh` | 是 | — | 快照文件 / custom 格式 dump |
| `--target <path>` | `restore-sqlite.sh` | 是 | — | 恢复目标文件；父目录不存在则递归创建 |
| `--manifest <file>` | `restore-sqlite.sh` | 否 | 快照同目录 `manifest.json` | 行数、抽样哈希与 sha256 复算核对 |
| `--integrity <quick\|full>` | `restore-sqlite.sh` | 否 | `full` | `full`：quick_check 后再 integrity_check；`quick`：只跑快档，报告标注未跑全档 |
| `--sample <n>` | 恢复/比对/演练共用 | 否 | `$YXS_G_SAMPLE`（20） | 每表抽样行数，合法 1..1000 |
| `--db <name>` | `backup-pg.sh` | 否 | `$PGDATABASE` 或 `yxs` | 只备份指定业务库，不做 `pg_dumpall` |
| `--target-db <name>` | `restore-pg.sh` | 否 | `yxs_g_restore_<timestamp>` | 必须匹配 `^yxs_g_[a-z0-9_]+$`；不得为 `yxs`/`postgres`/`template0`/`template1` |
| `--kind <sqlite\|pg>` | `drill.sh` | 是 | — | 选择演练链路 |
| `--report <file>` | `drill.sh` | 否 | 本次备份目录下 `drill-report.md` | 报告落点 |

参数解析集中在 `src/common.sh`；缺必填参数、参数越界、未知开关 → 退出码 1 + 中文一行，不产生半成品。

## 6 失败处理

退出码只分四档（02 §4）：`0` 成功；`1` 用法/参数错误、违反硬约束；`2` 环境/连接/工具/数据合法性；`3` 校验不一致。细分原因写进中文消息与报告附录，不占用额外退出码。失败路径统一：退出码 + stdout 中文一行 + 报告记录分类；内部英文错误只进日志，不进中文消息。

**退出码 1：用法/参数错误、违反硬约束**

| 失败场景 | 中文消息（逐字照 02 §4） | 半成品处理 |
|---|---|---|
| 缺 `--source` | `缺少必填参数 --source：SQLite 源库路径。` | 无产物 |
| 缺 `--backup` | `缺少必填参数 --backup：备份产物路径。` | 无产物 |
| 缺 `--target` | `缺少必填参数 --target：恢复目标路径。` | 无产物 |
| 源文件不存在 | `找不到源数据库文件：<path>。` | 无产物 |
| 命中受保护真实目录 | `源路径位于受保护的真实数据目录，请改用 .scratch/run/G/ 下的副本：<path>。` | 无产物 |
| `--sample` 非 1..1000 整数 | `--sample 必须是 1 到 1000 的整数。` | 无产物 |
| 恢复带 `--clean`/`--if-exists` | `禁止在恢复时使用 --clean；恢复目标必须是新建的隔离库。` | 无产物 |
| 目标库名不合规 | `目标库名只能以 yxs_g_ 开头，后跟小写字母、数字或下划线：<name>。` | 无产物 |
| 目标库已存在 | `目标库已存在，为避免覆盖未执行恢复：<name>。` | 不动既有库 |

**退出码 2：环境/连接/工具/数据合法性**

| 失败场景 | 中文消息（逐字照 02 §4） | 半成品处理 |
|---|---|---|
| 客户端工具缺失 | `未找到 <tool>（sqlite3 / pg_dump / pg_restore），请先安装并确认在 PATH 中。` | 无产物 |
| PG 连接失败 | `无法连接 PostgreSQL：<原因>。请检查 PGHOST、PGPORT、PGUSER、PGPASSWORD。` | 无产物 |
| 源库打不开（占用/损坏/句柄） | `打开源数据库失败：<原因>。` | 已建临时目录保留待排查 |
| 备份命令失败（含磁盘不足、`pg_dump` 非零退出） | `备份命令失败：<command>：<原因>。` | 半成品保留在本次备份目录，manifest 不封 |
| 备份产物打不开 | `备份产物无法打开：<file>：<原因>。` | 半成品保留 |
| schema 版本非 7 | `源库 schema 版本为 <v>，预期 7；请先在桌面端或 seed 流程跑齐本地迁移。` | 无产物 |
| 源库缺表 | `源数据库缺少表 <table>。` | 无产物 |

**退出码 3：校验不一致**

| 失败场景 | 中文消息（逐字照 02 §4） | 半成品处理 |
|---|---|---|
| 快档校验未通过 | `备份产物快速校验未通过：<file>：<首条结果>。` | 产物保留，报告 `verdict=FAIL` |
| 全档完整性未通过 | `恢复库完整性检查未通过：<首条结果>。` | 恢复库保留，源备份不删 |
| 行数不等 | `行数不一致：表 <table> 备份前 <n> 行，恢复后 <m> 行。` | 产物与恢复库保留 |
| 抽样字段不等 | `抽样不一致：表 <table> 主键 <pk> 列 <column> 备份前=<…> 恢复后=<…>。` | 产物与恢复库保留 |
| 产物哈希不符 | `备份产物哈希不一致：文件 <file> 记录 sha256=<…>，复算=<…>。` | 不进入恢复；产物保留 |
| 表集合不一致 | `表集合不一致：备份前有 <table>，恢复后缺失。` | 产物与恢复库保留 |

重试口径：环境/命令类失败（码 2）可排查后手动重试；校验失败（码 3）不自动重试——先复盘保留下来的产物，不要重跑覆盖证据；客户端缺失或连不上（码 2）先补齐工具链与连接再跑。校验类工具的「可验证、可追溯」设计参照成熟备份仓库把校验结果作为一等产物的做法 [R53]。

## 7 性能与资源

| 指标 | 测量方法 | 预期量级 |
|---|---|---|
| 备份耗时 | 脚本内记录开始/结束时间戳（`date +%s.%N` 或 Python `time.perf_counter()`），写进演练报告与 manifest 时间字段 | 待实测；不以仓库现有库大小外推耗时 |
| 产物体积 | `artifact.bytes`（未压缩）与压缩后字节数分别记录；`gzip` 前后对比 | 待实测；样本库 `.scratch/sample-home/data/learning.db` 约 3.4 MB 级，仅作 fixtures 参照，不作为性能承诺 |
| 压缩比 | 压缩后 / 未压缩字节比 | 待实测；`gzip` 缺失时在报告标注未压缩 |
| 恢复耗时 | 恢复开始到复校完成的时间差，写进演练报告 | 待实测 |
| 内存 | 在线备份 API 按页流式拷贝；Python 指纹逐条读抽样行/表，不整库载入 | 预期与库体积无关的常数级缓冲；待实测确认 |
| 磁盘余量 | 备份前 `df -P` 取可用字节，与源体积 ×1.5 比较；PG 源体积取 `pg_database_size('yxs')` | 不足即退出码 2（备份命令失败），不写到一半失败 |

不编造数字：以上所有耗时、体积、压缩比在首次演练后回填报告；验收只断言「测量字段存在且为数值」，不断言具体阈值。快照命名与保留期思路参照快照备份工具的时间戳目录约定 [R51]；保留策略（留几份、多久清）本轮不实现，只在 manifest 里留 `createdAt` 供后续裁剪，这与只取「备份必须可验证」而不引入整套仓库体系的取舍一致 [R50]。增量备份、去重、加密仓库不在本轮范围 [R57]。

## 8 实施顺序（每步都能验证）

1. **脚手架与公共函数库**：`src/common.sh` 落地参数解析、退出码常量、`fail()` 中文消息、路径白名单、`sha256_file()`。验证：`bash tools/backup/src/common.sh --help`（或 `source` 后调 `fail` 看退出码 1）。
2. **SQLite 在线备份主分支**：`.backup` + quick_check + manifest 封盘。验证：对 `.scratch/run/G/` 副本备份，重算 sha256 与 manifest 相等，`quick_check=ok`。
3. **SQLite 兜底分支**：Python `backup()` 与 `VACUUM INTO` 回退；在去掉 PATH 里 `sqlite3` 的模拟环境下跑通。验证：manifest `tool` 段与报告记录对应方法分支。
4. **SQLite 恢复与复校**：`--target` 路径恢复 → 双档校验 → 行数比对。验证：恢复库校验全过，源库路径未被写。
5. **PG 备份**：`pg_dump -Fc` + 连接探测 + manifest。验证：dump 文件可被 `pg_restore -l` 列出 TOC；manifest `tool.clientVersions` 记录客户端版本。
6. **PG 恢复到新库**：`createdb` + `pg_restore`；硬拒绝（`--clean`/`--if-exists`、库名不合规、既有库、源库名）。验证：各拒绝场景分别返回退出码 1 与对应中文消息。
7. **共用比对器**：表清单逐表行数 + 10 张核心表 `--sample` 条指纹，SQLite/PG 同源。验证：基线副本与恢复副本比对全等；人为改一行后能定位到表、主键与列。
8. **演练闭环与报告模板**：`drill.sh` 编排 + `restore-drill.md` 规程落地，删除前置条件闸与隔离目标闸；跑通「备份 → 删隔离副本 → 恢复 → 复校」全流程。验证：报告含时间、源、产物 sha256、删除方式、恢复耗时、校验结果；§3.10 八步齐全。

分步拆法遵循「先能跑通一条库型、再补兜底、最后串演练」的小步可回退原则；CLI 形态（子命令 + 环境变量连接）参照成熟数据库备份/恢复工具的命令组织，但不引入其运行时与远程仓库体系 [R54]。

## 参考

- [R45] SQLite Online Backup API — https://www.sqlite.org/backup.html — 支撑 §3.2/§3.3/§4 在线备份一致性与 WAL 处理 — 直接采用在线备份 API；不采用运行中文件复制。
- [R46] SQLite `VACUUM INTO` — https://www.sqlite.org/lang_vacuum.html — 支撑 §3.2 第三兜底分支 — 采用单文件一致副本；不把它当主分支。
- [R47] SQLite `PRAGMA integrity_check` — https://www.sqlite.org/pragma.html#pragma_integrity_check — 支撑 §3.4 两档校验时机 — 采用 quick_check 备份侧、integrity_check 恢复侧。
- [R48] `pg_dump` — https://www.postgresql.org/docs/current/app-pgdump.html — 支撑 §3.6 custom 格式与一致性快照 — 采用 `--format=custom --no-owner`；不用 plain 脚本。
- [R49] `pg_restore` — https://www.postgresql.org/docs/current/app-pgrestore.html — 支撑 §3.7 新库恢复与 `--clean` 风险 — 采用新库恢复；禁止 `--clean` 打既有库。
- [R50] pgBackRest — https://pgbackrest.org/ — 支撑 §7 「备份要可验证」的口径 — 借鉴校验一等产物；不引入其 repo/归档体系。
- [R51] restic — https://github.com/restic/restic — 支撑 §1 产物命名与 §7 时间戳目录 — 借鉴 `db-timestamp` 命名；不引入加密去重仓库。
- [R52] databasus — https://github.com/databasus/databasus — 支撑 §3.7 「备份后做 restore 验证」的闭环形态 — 借鉴恢复验证思路；不引入其 Web UI 与 PITR。
- [R53] pgbackrest GitHub — https://github.com/pgbackrest/pgbackrest — 支撑 §6 校验结果作为可追溯产物 — 借鉴 checksum/verify 记录；不引入并行归档。
- [R54] django-pgclone — https://github.com/AmbitionEng/django-pgclone — 支撑 §8 CLI 组织与 dump/restore 成对形态 — 借鉴命令拆分；不引入 ORM 绑定。
- [R55] mgob — https://github.com/stefanprodan/mgob — 支撑 §7 备份报告字段（耗时/通知/指标口径） — 借鉴报告字段；不引入调度与 S3 上传。
- [R56] pgdumplib — https://github.com/gmr/pgdumplib — 支撑 §3.6 custom 格式可被工具解析的结构依据 — 借鉴格式认知；不在 Python 侧解析 dump。
- [R57] borg — https://github.com/borgbackup/borg — 支撑 §7 增量/去重属后续范围的边界判断 — 明确本轮不做增量与加密。
- [R58] rsync — https://github.com/RsyncProject/rsync — 支撑 §3.3 文件级复制为何不能替代在线快照 — 仅作对照反例；本工具不调用。
