# G 轮备份 / 恢复 / 演练工具

`tools/backup/` 下交付一套手工可重复执行的备份、恢复与恢复演练工具：

- SQLite 在线一致性快照（不复制运行中的库文件），恢复后双档完整性校验；
- PostgreSQL custom 格式快照，恢复到新建的隔离库；
- `drill.sh` 编排「备份 → 基线 → 删除前置闸 → 删隔离副本 → 恢复 → 复校 → 出报告」闭环。

所有演练对象只落在 `.scratch/run/G/` 隔离副本与隔离 PG 库；真实数据目录一律拒绝。

## 1. 文件清单

| 文件 | 角色 |
|---|---|
| `backup-sqlite.sh` | SQLite 在线备份：`.backup` / Python `Connection.backup()` 优先，`VACUUM INTO` 兜底；写 manifest 与抽样基线 |
| `restore-sqlite.sh` | 从快照恢复到目标路径；清理残留边车；`quick_check` + `integrity_check` 双档校验；行数 / 抽样核对 |
| `backup-pg.sh` | `pg_dump --format=custom --no-owner --no-privileges` 导出业务库；写 manifest、逐表行数与 sha256 |
| `restore-pg.sh` | `pg_restore` 到 `yxs_g_` 前缀新建隔离库；拒绝清理类开关；行数 / 抽样核对；源库行数前后复核 |
| `drill.sh` | 演练编排：六阶段固定函数 `stage_backup` `stage_baseline` `stage_delete` `stage_restore` `stage_verify` `stage_report` |
| `src/common.sh` | 公共函数与内嵌 Python 引擎：日志、退出码、参数校验、slug、时间戳、哈希、受保护路径判定、指纹 / 比对 / manifest / report 子命令 |
| `restore-drill.md` | 演练规程、不可逆保护、失败中断规则、七段报告骨架字段表 |
| `README.md` | 本文件：前置工具、环境变量、用法、排查、已知限制 |

## 2. 前置工具与版本要求

| 工具 | 要求 | 缺失时的分支 / 退出码 |
|---|---|---|
| bash | 5.x（Git Bash 5.2 或 WSL / CI Linux） | 脚本为 bash 语法，不在 PowerShell 内联执行 |
| Python | 3.11+（标准库 `sqlite3`、`hashlib`、`json`） | 无 sqlite3 CLI 时走 Python 标准库在线备份；Python 也不可用归退出码 2 |
| sqlite3 CLI | 可选；在 PATH 时优先用其 `.backup` 在线快照 | 不在 PATH 时自动回退 Python `Connection.backup()`，再回退 `VACUUM INTO` |
| PG 客户端（`pg_dump` / `pg_restore` / `psql` / `createdb`） | 仅 PG 链路需要；客户端 major 版本不得低于服务端 major（对接 `postgres:16` 实例） | 缺任一命令归退出码 2；不可达归退出码 2 |

本机 2026-11-20 实测：`bash` 不在 PATH，需经 Git Bash 调用；`sqlite3`、`pg_dump`、`pg_restore`、
`psql`、`docker` 均不在 PATH；Python 3.13 + 标准库 sqlite3 可用。

## 3. 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PGHOST` | `127.0.0.1` | PG 演练实例主机 |
| `PGPORT` | `55433` | G 轮专用 PG 端口 |
| `PGDATABASE` | `yxs` | PG 源库名；恢复目标禁止等于它 |
| `PGUSER` | `yxs` | PG 用户名 |
| `PGPASSWORD` | 无默认，必填于环境 | 密码只从环境读，不写命令行参数、不进 manifest 与日志；日志中密码位置记 `***` |
| `YXS_G_BACKUP_DIR` | `<repo>/.scratch/run/G/g_backups` | 备份产物根目录 |
| `YXS_G_SAMPLE` | `20` | 每表抽样行数，可被 `--sample` 覆盖（合法 1..1000） |
| `LEARNING_AGENT_HOME` | `<repo>/.learning-agent` | 受保护目录判定时识别真实 home |
| `YXS_KEEP_TMP` | 未设（关闭） | 调试开关：仅当显式设为非空时，退出时保留临时目录（含装配出的 `spec.json`）供排查；不设即按默认清理。只用于排障，不参与任何正常演练路径 |
| `YXS_REUSE_MANIFEST` | 未设（关闭） | 自检复用入口：仅当显式指向一个既有 manifest 文件时，`stage_backup` 跳过本次备份、直接载入该清单；不设即走正常备份流程。只服务于 AC-G-09 删除闸反例（需要一份「前置条件不满足的 manifest」）；02 §2.6 的 drill 参数表没有接收既有备份的入参，闭环参数无法表达复用既有清单，故保留此环境变量入口；它只读既有产物，不重复实现备份 / manifest 逻辑 |

连接参数读取顺序：命令行参数 > 环境变量 > 上表默认值。显式环境变量优先，脚本内兜底不覆盖已设值。

`PGHOST` / `PGPORT` / `PGDATABASE` / `PGUSER` 的默认值由 `src/common.sh` 统一给出并 **export**：
`pg_dump` / `pg_restore` / `psql` / `createdb` 是独立子进程，只认环境变量（libpq）。若不导出，
未显式设置这些变量的机器上子进程会静默回落到 `5432` 与本地同名用户，本轮的 `55433` 契约就失效了。

## 4. 用法示例（Git Bash，仓库根执行）

```bash
cd /e/Documents/GitHub/YingXiaoShang

# SQLite 在线备份（副本路径；产物落 $YXS_G_BACKUP_DIR）
bash tools/backup/backup-sqlite.sh --source .scratch/run/G/home/data/learning.db

# SQLite 恢复到隔离目标路径（双档校验 + 基线核对）
bash tools/backup/restore-sqlite.sh \
  --backup .scratch/run/G/g_backups/<host>/<pathSlug>/<timestamp>/learning.db.sqlite \
  --target .scratch/run/G/home/restored/learning.db

# PG custom 格式备份（源库默认 $PGDATABASE）
bash tools/backup/backup-pg.sh --db yxs

# PG 恢复到新建隔离库（默认库名 yxs_g_restore_<timestamp>）
bash tools/backup/restore-pg.sh --backup .scratch/run/G/g_backups/<host>/<pathSlug>/<timestamp>/yxs.dump

# SQLite 演练闭环：备份 → 基线 → 删隔离副本 → 恢复 → 复校 → 报告
bash tools/backup/drill.sh --kind sqlite \
  --source .scratch/run/G/home/data/learning.db \
  --sample 20

# PG 演练闭环（需实例可达、客户端在 PATH）
bash tools/backup/drill.sh --kind pg --source yxs --sample 20
```

`drill.sh` 参数：

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `--kind sqlite\|pg` | 是 | — | 选择演练链路 |
| `--source <path\|db>` | 是 | — | SQLite 副本路径 / PG 源库名 |
| `--sample <n>` | 否 | `20` | 每表抽样行数，1..1000 |
| `--report <file>` | 否 | 本次备份目录下 `drill-report.md` | 演练报告落点 |
| `--restore-target <path>` | 否（sqlite） | `.scratch/run/G/home/restored/learning.db` | SQLite 恢复目标路径；命中受保护目录、等于 `--source`、或是既有目录 → 退出码 1 |

`restore-sqlite.sh` 的 `--target` 同样有三道闸，全部在任何 `rm` / `mkdir` / `cp` 之前执行：

1. 命中受保护真实数据目录（`%APPDATA%`、`~/.learning-agent`、`<repo>/.learning-agent`、`$LEARNING_AGENT_HOME`）→ 退出码 1；
2. 与 `--backup` 指向同一文件（归一后相等或 `-ef` 成立）→ 退出码 1；
3. 目标是既有目录 → 退出码 1。

理由：恢复会先删目标旁的 `-wal` / `-shm` 边车再覆盖主文件。目标若落在真实数据目录，边车里未 checkpoint
的写入会随边车一起消失，不可恢复；`--backup` 与 `--target` 相同时 `cp` 会以 "are the same file" 失败，
但边车已经删了，留下半途状态。宁可误拒，也不误放。

## 5. 退出码

| 码 | 含义 | 典型场景 |
|---|---|---|
| `0` | 成功 / 核对一致；前置闸保护中止也以 0 退出 | 备份完成且 quick_check 通过；恢复后双档校验与行数、抽样全绿；备份校验未过，演练中止删除 |
| `1` | 用法或参数错误、违反硬约束 | 缺必填参数；参数越界；源路径命中受保护目录；**恢复目标命中受保护目录 / 等于备份产物 / 是既有目录**；PG 目标库名不合规或已存在 |
| `2` | 环境、连接、工具或数据合法性错误 | 缺客户端；PG 连不上；源库打不开；schema 版本非 7；表集合缺失；备份命令失败；`restore-sqlite.sh` 产物打不开；`cp` / `mkdir` / `rm` 失败；隔离演练库建库或灌入失败；演练库内没有可删除的业务表 |
| `3` | 校验不一致 | quick_check / integrity_check 非 ok；行数不等；抽样字段不等；产物 sha256 复算不符；表集合不一致；`pg_restore -l` 列不出 TOC；`compare` 核对不符；**隔离演练库 TRUNCATE 后仍有行** |

裁决口径（不按「一律 2 / 一律 3」归类）：恢复产物打不开归 2；PG custom 备份 TOC 列不出归 3；行数 / 抽样 / 哈希 / 表集合核对不符归 3。

## 6. 排查

| 症状 | 最可能原因 | 一条命令确认 |
|---|---|---|
| 备份退出码 2，提示缺客户端 | PATH 无 sqlite3 / pg_dump / pg_restore，Python stdlib 也不可用 | `command -v python sqlite3 pg_dump pg_restore psql`；SQLite 版本以备份日志 `clientVersions` 记录为准 |
| `quick_check` 报镜像损坏 | 产物是半写副本，或源库边车未并入 | 对照备份方法（在线分支 vs 文件复制）；检查 manifest `tool.name` 与备份方法 |
| 行数比对某表不等（码 3） | 备份期间源库被写；或副本与源不是同一 schema 版本 | 读副本 `PRAGMA user_version`；对比两侧 `tables[].rows` |
| `pg_dump` / `pg_restore` 报版本不匹配 | 客户端 major 与服务端 major 不一致 | `pg_dump --version`；`psql -h 127.0.0.1 -p 55433 -U yxs -c "SHOW server_version;"` |
| `createdb` 报库已存在（码 1） | 时间戳后缀撞名或复用旧恢复库 | `psql -lqt -h 127.0.0.1 -p 55433 -U yxs` 查 `yxs_g_` 前缀库；换后缀重跑 |
| 恢复被拒「恢复目标位于受保护的真实数据目录」（码 1） | `--target` 落在 `%APPDATA%` / `.learning-agent` 下；MSYS 写法（`/c/...`）与 Windows 原生写法（`C:\...`）已统一归一后比较 | 把目标改到 `.scratch/run/G/` 下；确认 `APPDATA` 与目标同源 |
| 恢复被拒「恢复目标不能等于备份产物」（码 1） | `--backup` 与 `--target` 指向同一文件（含 `./x`、`/c/...`、符号链接等等价写法） | 换一个目标路径；这条闸在 `cp` 之前，不会留下半途边车 |
| PG 演练报「没有可删除的业务表」（码 2） | 隔离演练库 `yxs_g_drill` 建好了但灌库失败，或备份本身是空库 | 查 `pg_restore --dbname=yxs_g_drill` 的报错；确认源库有业务表 |
| 指纹不等但行数相等（码 3） | 主键排序不确定、列类型序列化差异、浮点 / 空串口径不一致 | 看 `samples/<table>.json` 首处差异的表名与主键；核对排序键是否稳定 |
| PG 连接失败，退出码 2 | `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` 缺失或实例未起 | 探测 `127.0.0.1:55433` 连通性；核对环境变量名与 `yxs-pg-g` 容器状态 |
| 报告缺耗时字段 | 阶段开始 / 结束时间戳未记录 | 查报告 `elapsedMs`；口径为阶段前后 UTC 时间差（毫秒） |
| 证据目录出现密码明文 | 密码被写进命令行、日志或 manifest | 检索 `PGPASSWORD=`；脚本只从环境读密码，连接串密码位置记 `***` |

## 7. 已知限制

- 本机无 PG 客户端与 docker：PG 链路在本环境只能验证参数与守卫路径，连库类动作记
  `skipped: no PG client/server`，不伪造 PASS；在装有匹配版本 PG 客户端且 `yxs-pg-g` 可达的环境复跑。
- Windows 上必须经 Git Bash 或 WSL 执行 `.sh` 脚本；PowerShell 只负责调用与只读复核，不内联跑 shell 逻辑。
- SQLite 链路在无 sqlite3 CLI 时走 Python 标准库 `Connection.backup()` 在线备份分支；
  不允许用文件复制（`cp`）拷贝正在写入的库。
- 本轮只做全量快照，不做增量备份、WAL 归档 / PITR、加密仓库、去重仓库与异地复制；
  不做旧备份自动保留与清理策略。
- 跨大版本 PG dump 回灌、SQLite 降级打开不在本轮覆盖范围。
- 报告核对段的 `sampleSize` 由 `drill.sh` 装配为 `min(rowsBaseline, --sample)`（空表记 0、小表全量、大表取 `--sample`）；`yxs_py compare` 本身不回传该字段，`sampleResult` / `hashResult` 仍取 compare 真实结果。
- `--sample` 的校验与取值统一走 `src/common.sh` 的 `yxs_sample`：结果只经全局 `YXS_SAMPLE_OUT` 回传、不向 stdout echo；禁止用命令替换捕获 `yxs_sample` 的输出（`yxs_die` 在子 shell 里只终止子 shell，父脚本会拿到空值），调用后从 `YXS_SAMPLE_OUT` 读取。
- spec JSON 由 `drill.sh` 单次 heredoc 一次性写完整；合法性校验由统一入口 `yxs_py report` 内部 `json.load` 完成（按 §0.6，脚本内不绕过 `yxs_py` 直接调 Python 解释器），校验失败归退出码 2，临时 spec 可用 `YXS_KEEP_TMP=1` 保留排查。
