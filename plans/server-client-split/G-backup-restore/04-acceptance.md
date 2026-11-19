# G · 备份与恢复 · 验收

> 轮次：G · 备份与恢复
> 文档角色：04-acceptance
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1
> 契约权威：[`02-contract.md`](02-contract.md) §2 接口、§3 数据结构、§4 错误消息、§5 时序
> 写权：[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1（`tools/backup/**`）
> 一句话：14 条 AC 全部可命令复现；每条都能追到 `02-contract.md` 的契约点与 `03-implementation.md` 的对应小节，靠「我觉得对」的不算过。

## 1 验收口径

**过 = 下列三组同时成立**：

1. **硬指标**：SQLite 备份产物通过 `quick_check`、与源库按 `packages/db/src/index.ts:92-441` 登记集合逐表行数一致；恢复后 `integrity_check` 通过；演练「备份 → 删隔离副本 → 恢复」后行数全等且 10 张核心表各 20 条样本字段与整表摘要一致；PG `pg_dump -Fc` 可被 `pg_restore` 列出 TOC，恢复只落 `yxs_g_` 前缀隔离新库；manifest 的 `artifact.sha256` 与产物可复算对账（02 §3.2、§3.6）。
2. **反向验证**：§5 的 5 个 mutation 每个都能让指定 AC 变红；改回后变绿。
3. **证据**：每条 AC 在 `.scratch/run/G/evidence/` 留下命令原文、stdout、manifest 与比对结果，可复跑。

不可替代项（不能用「手工看了一眼库能打开」代替）：在线备份分支（禁止 `cp` 运行中库）、恢复侧 `integrity_check`、20 条确定性样本比对、PG 新库恢复、`--clean` 拒绝、删除前置条件闸。

退出码只分四档（02 §2.7）：`0` 成功/核对一致；`1` 用法或参数错误、违反硬约束；`2` 环境、连接、工具或数据合法性错误；`3` 校验不一致。细分原因写进中文消息与报告附录，不占用额外退出码。

「可机器判定的才算验收」这条口径来自测试实践：断言写成可执行检查，而不是人工观察 [R36]；备份类工具的成熟做法也是把「恢复验证」作为交付闭环的一部分，而不只交付一个 dump 文件 [R52]。

## 2 前置条件

### 2.1 隔离数据准备（PowerShell 7）

```powershell
cd E:\Documents\GitHub\YingXiaoShang

# 只在 .scratch/run/G/ 下造副本；禁止触碰 .learning-agent / %APPDATA%
New-Item -ItemType Directory -Force .scratch\run\G\home\data, .scratch\run\G\g_backups, .scratch\run\G\evidence | Out-Null
Copy-Item .scratch\sample-home\data\learning.db .scratch\run\G\home\data\learning.db -Force

# 基线库存在性确认（无副本则跳过数据类 AC，标 skipped）
Test-Path .scratch\run\G\home\data\learning.db

# 工具链自检：逐个确认是否在 PATH，结果写进证据目录的 env.txt
foreach ($c in 'bash','sqlite3','python','pg_dump','pg_restore','gzip') {
  $p = Get-Command $c -ErrorAction SilentlyContinue
  "{0} => {1}" -f $c, $(if ($p) { $p.Source } else { 'NOT FOUND' })
}
python -c "import sqlite3; print('stdlib sqlite3', sqlite3.sqlite_version)"
```

备份产物根目录为 `.scratch/run/G/g_backups`（环境变量 `YXS_G_BACKUP_DIR`，02 §2.1）；不得在 `.scratch/run/G/backups` 这类旧目录下落产物。

### 2.2 执行环境（`.sh` 脚本的现实约束）

脚本形态是 `.sh`，实际执行环境为 **Git Bash / WSL / CI Linux**；本机 Windows + PowerShell 7 按下面方式调用：

| 环境 | 调用方式 | 适用 AC |
|---|---|---|
| Git Bash / WSL 已安装 | PowerShell 里 `bash -lc 'tools/backup/backup-sqlite.sh --source .scratch/run/G/home/data/learning.db --out .scratch/run/G/g_backups'` | 全部 SQLite AC |
| 未装 bash | `python -c` 走标准库 `sqlite3` 兜底分支完成备份/校验，并用 Python 读 manifest 确认结果 | AC-G-01..06、11、13、14 的本机替代路径 |
| PG 实例 | `yxs-pg-g` 容器，宿主端口 `55433`（与 D 轮 `55432` 隔离，[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §3）；`pg_dump`/`pg_restore` 在容器内或匹配版本的 PG 客户端中执行 | AC-G-07、08、12 的 PG 部分 |

本机 2026-11-19 实测：`bash`、`sqlite3`、`pg_dump`、`pg_restore`、`gzip` 均不在 PATH；Python 3.13.18 + stdlib sqlite3 3.53.1 可用。

**缺则跳过并标记**：

- 无 PG 实例（`55433` 不可达）：AC-G-07、08、12 的 PG 部分跳过，证据目录标 `skipped: PG unreachable`，不得伪造通过。
- 无可用 SQLite 副本：依赖数据内容的 AC-G-03、05、06 跳过；结构类 AC（参数拒绝、前置条件闸、manifest 字段、sha256 对账）仍执行。
- 无 bash 且 Python 兜底也不可用：SQLite 备份类 AC 标 `skipped: no backup runtime`，只保留失败路径 AC。

PG 连接环境变量（02 §2.1、冻结契约 §10.5）：`PGHOST=127.0.0.1`、`PGPORT=55433`、`PGDATABASE=yxs`、`PGUSER=yxs`、`PGPASSWORD` 从环境读，不写进命令行与 manifest。SQLite 在线备份对运行时的最低要求（CLI 或标准库备份 API）见 Online Backup API 说明 [R45]。

### 2.3 基线数据采集

备份成功后、删除动作前，比对器（03 §3.9）在只读连接下导出两份基线文件，落 `.scratch/run/G/evidence/AC-G-05/`：

- `baseline-rowcounts.json`：`packages/db/src/index.ts:92-441` 登记集合逐表的 `count(*)`，写入 manifest `tables[].rows`；
- `samples/<table>.json`：10 张核心表各 20 条确定性排序样本（表名、主键、抽样行值与整表摘要），排序键取主键，无主键表退化为 rowid/ctid 并记录 `sortKey`（02 §3.4）。

只读连接口径：SQLite 用 `file:<path>?mode=ro` URI 打开；PG 用只读账号或默认只读查询，比对过程不执行任何 `INSERT/UPDATE/DELETE/DDL`。基线文件是 AC-G-05、AC-G-06 的对照基准；恢复后复校结果与它逐字段比对，不与人工记忆比对。

若副本为空库（种子未跑）：行数全 0 仍可跑结构类 AC，但样本指纹为空集合，AC-G-06 标 `skipped: empty sample set`，不判失败。

## 3 用例清单

下表每条 AC 对应 `02-contract.md` 契约点与 `03-implementation.md` 实现小节：SQLite 在线分支见 03 §3.2，两档校验见 03 §3.4，PG 新库恢复见 03 §3.7，抽样比对见 03 §3.9；断言一律写成可执行检查与可观察输出 [R36]。

| 编号 | 操作步骤 | 期望输出 / 通过判据 | 失败判据 | 执行环境 | 证据文件 |
|---|---|---|---|---|---|
| AC-G-01 | 对 `.scratch/run/G/home/data/learning.db` 跑 `backup-sqlite.sh --source .scratch/run/G/home/data/learning.db --out .scratch/run/G/g_backups` | 退出 0；备份产物落盘且 `artifact.bytes > 0`；同目录生成 `manifest.json`，含 `manifestVersion="1"`、`kind="sqlite"`、`artifact.fileName/bytes/sha256`、`tables[]`、`checks` 段 | 退出非 0；无 manifest；缺 `sha256`/`bytes`/`tables` 字段 | Git Bash/WSL；PowerShell 用 `python -c` 读 manifest 复核 | `AC-G-01/manifest.json`、`cmd.txt`、`stdout.txt` |
| AC-G-02 | 对备份副本执行 `PRAGMA quick_check`（备份脚本内置，manifest `checks.quickCheck` 留痕；备份侧 `checks.integrityCheck=null`） | `quick_check` 返回单行 `ok`；`checks.quickCheck="ok"`；`checks.integrityCheck=null` | 返回非 `ok`；脚本未跑 quick_check 就封盘；备份侧误记 `integrityCheck` 结果 | 同上 | `AC-G-02/quick-check.txt` |
| AC-G-03 | 比对源库与备份副本登记集合逐表 `count(*)`（表清单见 `packages/db/src/index.ts:92-441`） | 逐表行数全等；行数写入 `tables[].rows`；表集合两侧一致 | 任一表不等；表集合漂移未记录 | Python stdlib 跨两库只读比对 | `AC-G-03/rowcounts.json` |
| AC-G-04 | `restore-sqlite.sh --backup <快照> --target .scratch/run/G/home/restored/learning.db` 恢复到新路径，默认 `--integrity full`，恢复后执行 `PRAGMA integrity_check` | 退出 0；`quick_check` 与 `integrity_check` 均返回 `ok`；目标旁无残留 `-wal`/`-shm`；源库路径未被覆盖 | `integrity_check` 非 ok；恢复落点等于源库路径；目标目录残留边车文件 | Git Bash/WSL；Python 兜底复核 | `AC-G-04/integrity.txt`、`restore-record.json` |
| AC-G-05 | 演练闭环：`drill.sh --kind sqlite --source <副本>` 备份 → 记录基线 → 删隔离副本 → 恢复 → 复校行数；PG 演练在隔离库 `yxs_g_drill` 内删数据 | 恢复后逐表行数与基线全等；`drill-report.md` 含七段骨架（02 §3.7）：删除方式、恢复耗时、`checks`、`verdict=PASS` | 行数不等；报告缺删除方式或耗时；删除动作作用到源库；`verdict` 非 PASS | Git Bash/WSL；PG 演练在 `yxs_g_drill` 库 | `AC-G-05/drill-report.md`、`baseline.json`、`restored-rowcounts.json` |
| AC-G-06 | 10 张核心表（`chat_sessions`、`chat_messages`、`memory_facts`、`memory_episodes`、`artifacts`、`question_attempts`、`evidence`、`student_profiles`、`news_articles`、`knowledge_points`）各取 `--sample 20` 条确定性排序样本，源库与恢复库比对字段与整表摘要 | 每表 20 条样本全等；`samples/<table>.json` 含 `primaryKey`/`sampleSize`/`rows`；同一产物重复核对两次主键集合一致 | 任一表字段不等；样本条数 < 20；两次抽样集合不一致 | Python 指纹比对（SQLite/PG 同源） | `AC-G-06/samples.json` |
| AC-G-07 | `backup-pg.sh --db yxs` 执行 `pg_dump --format=custom --no-owner --no-privileges` | 退出 0；dump 文件可被 `pg_restore -l` 列出 TOC；manifest 含 `artifact.sha256`、`tool.clientVersions`、`tables[]` | TOC 列不出；manifest 缺客户端版本段；误用 plain 格式 | `yxs-pg-g` 容器内或 PG 客户端；不可达则 skipped | `AC-G-07/toc.txt`、`manifest.json` |
| AC-G-08 | `restore-pg.sh --backup <dump>` 恢复到默认生成的 `yxs_g_restore_<timestamp>` 新库；恢复前后各查源库行数 | 新库恢复成功；源库 `yxs` 行数前后一致；目标库名匹配 `^yxs_g_[a-z0-9_]+$` 且 ≠ `yxs` | 恢复打到源库；源库行数变化；复用既有库 | 同上 | `AC-G-08/restore.log`、`source-rowcounts-before.json`、`source-rowcounts-after.json` |
| AC-G-09 | 构造一份前置条件不满足的备份（`quickCheck=fail` 或 sha256 不可复算），跑 `drill.sh` 删除阶段 | 删除中止，stdout 输出 `未执行删除：上一份备份校验未通过，演练已中止以保护数据。`；退出 0 提示；删除前后源库/副本行数与文件 `LastWriteTime` 不变 | 执行了 `DELETE`/`DROP`/文件删除；产物目录出现被删数据痕迹；消息缺失 | Git Bash/WSL；PowerShell 比对行数与 `LastWriteTime` | `AC-G-09/abort-plan.txt`、`before-after.json` |
| AC-G-10 | 反例：对运行中（带 `-wal` 侧车）的库直接 `cp` 成快照，再走 quick_check 与行数比对 | 反例产物在校验或行数比对处变红（预期失败，作为「不能 `cp`」的对照证据留存） | 反例竟然全绿（说明校验口径没覆盖半写状态）；或跳过反例不留痕 | Python 只读打开副本构造对照 | `AC-G-10/cp-counterexample.txt` |
| AC-G-11 | 重算备份产物 sha256 与 manifest `artifact.sha256` 比对；再人为改坏产物一字节后复算 | 未篡改：哈希相等，退出 0；篡改后：比对不等，退出码 3，消息 `备份产物哈希不一致：文件 <file> 记录 sha256=<…>，复算=<…>。` | 篡改后仍判等；manifest 缺哈希字段；退出码非 3 | PowerShell `Get-FileHash -Algorithm SHA256`；Python `hashlib` 复核 | `AC-G-11/sha256-ok.txt`、`sha256-tampered.txt` |
| AC-G-12 | PG 恢复场景：(a) 命令行带 `--clean`；(b) `--target-db yxs`（源库名，不合规）；(c) `--target-db` 指向已存在的隔离库 | (a) 退出码 1 + 消息 `禁止在恢复时使用 --clean；恢复目标必须是新建的隔离库。`；(b) 退出码 1 + 消息 `目标库名只能以 yxs_g_ 开头，后跟小写字母、数字或下划线：<name>。`；(c) 退出码 1 + 消息 `目标库已存在，为避免覆盖未执行恢复：<name>。`；三种情况都不动既有库 | 任一情况执行了恢复/清理；退出码为 0；库名比对放行 | PG 客户端/容器；不可达则 skipped | `AC-G-12/reject-clean.txt`、`reject-name.txt`、`reject-exists.txt` |
| AC-G-13 | `--source` 指向真实数据目录（`<repo>/.learning-agent` 或 `%APPDATA%` 下路径） | 退出码 1 + 消息 `源路径位于受保护的真实数据目录，请改用 .scratch/run/G/ 下的副本：<path>。`；无产物落盘 | 接受真实路径；备份目录出现真实库副本 | PowerShell 拼真实路径后经 `bash -lc` 调用 | `AC-G-13/realpath-reject.txt` |
| AC-G-14 | 人为制造校验失败（如截断备份产物后跑校验） | 退出码 3；快档失败消息 `备份产物快速校验未通过：<file>：<首条结果>。`；半成品产物保留在本次备份目录，未被自动删除 | 失败后产物被清掉；退出码 0；报告仍标 `PASS` | Git Bash/WSL 或 Python 兜底 | `AC-G-14/failed-manifest.json`、`stdout.txt` |

### 3.1 契约追溯

每条 AC 追到 `02-contract.md` 契约点（§7 自测编号 CT-G-01..11）与 `03-implementation.md` 小节；字段级口径以 02 §3.2/§3.3 为准。

| AC 组 | 02 契约点（CT-G 编号） | 冻结契约 / 仓内依据 | 03 实现小节 |
|---|---|---|---|
| AC-G-01..04 | CT-G-02 manifest 字段齐全；CT-G-03 校验档位阶段正确；CT-G-09 边车残留清理 | §10.2 环境变量；§10.3 数据目录含 `-wal`/`-shm`；`docs/requirements/R17-local-data.md:80-81` 在线备份要求 | §3.2 分支选择、§3.4 两档校验、§3.5 SQLite 恢复 |
| AC-G-05、06 | CT-G-05 行数 + 抽样核对；CT-G-11 抽样确定性 | README「演练：备份 → 真删测试库 → 恢复 → 校验行数和 20 条抽样记录」；02 §3.4 抽样规则 | §3.9 行数与指纹、§3.10 演练规程、§3.11 不可逆保护 |
| AC-G-07、08、12 | CT-G-04 PG 硬约束；CT-G-08 资源隔离 | §10.5 PostgreSQL（`postgres:16-alpine`、库 `yxs`、用户 `yxs`）；§10.2 PG 环境变量；ownership §3 端口 55433 / 容器 `yxs-pg-g` | §3.6 PG 备份、§3.7 PG 新库恢复与硬约束 |
| AC-G-09、13 | CT-G-06 受保护路径拒绝；CT-G-08 资源隔离 | ownership §2 硬规则：不得写真实数据目录；只动 `.scratch/run/<轮次>/` 副本 | §3.11 不可逆保护、§5 路径校验、§6 退出码 1 |
| AC-G-10、11、14 | CT-G-01 备份不用文件复制；CT-G-10 哈希不符检出 | `scripts/package-desktop.mjs:52-58` 既有 `VACUUM INTO` 先例；R17 §4 备份要求 | §3.3 WAL 侧车处理、§3.8 manifest 与 sha256、§6 失败处理 |

用例写法遵循「一条 AC 一个可观察结果 + 明确失败判据」；每条 AC 注明执行环境，并给一条在 PowerShell 侧也能确认结果的复核路径（读 manifest、`Get-FileHash`、Python 只读查询）。

## 4 证据

- **落点**：`.scratch/run/G/evidence/<AC-G-编号>/`，每条 AC 一个目录。
- **固定文件**：
  - `cmd.txt`：实际执行的命令原文（sh 命令与 PowerShell 复核命令分开写，不混排）；
  - `stdout.txt` / `stderr.txt`：退出码与原始输出；
  - `manifest.json`：备份脚本封盘的清单（AC-G-01/02/07/11/14 相关）；
  - `rowcounts.json`、`samples.json`：行数与抽样比对结果；
  - `drill-report.md`：AC-G-05 演练报告，七段骨架含时间、源、产物 sha256、删除方式、恢复耗时、校验结果。
- **复跑命令骨架**（Git Bash/WSL）：

```sh
cd /e/Documents/GitHub/YingXiaoShang
bash tools/backup/backup-sqlite.sh --source .scratch/run/G/home/data/learning.db \
  --out .scratch/run/G/g_backups
```

- **PowerShell 复核骨架**（不依赖 bash）：

```powershell
cd E:\Documents\GitHub\YingXiaoShang
python -c "import json,pathlib; m=json.loads(pathlib.Path('.scratch/run/G/evidence/AC-G-01/manifest.json').read_text(encoding='utf-8')); print(m['kind'], m['artifact']['sha256'][:12], m['checks']['quickCheck'])"
(Get-FileHash -Algorithm SHA256 .scratch/run/G/g_backups\<artifact>).Hash.ToLower()
```

- 证据存「命令原文 + 输出原文」而不是截图，失败可在 CI 复盘；结构化结果落 JSON 与 12-Factor 的日志观一致 [R6]。
- 复跑要求：所有 AC 可在同一 `.scratch/run/G/` 副本上重复跑；第二次跑前清理 `g_backups/` 与 `restored/`，不依赖「第一次跑才过」。
- **manifest 示例结构**（AC-G-01/07/11/14 对账字段以此为准；值为待实测占位结构，不预填哈希与体积；字段名冻结自 02 §3.2）：

```json
{
  "manifestVersion": "1",
  "backupId": "dev-laptop-scratch-run-g-home-data-learning-db-20261119T143012Z",
  "kind": "sqlite",
  "source": { "host": "dev-laptop", "path": ".scratch/run/G/home/data/learning.db", "dbName": "learning.db", "schemaVersion": 7, "label": null },
  "createdAt": "2026-11-19T14:30:12.000Z",
  "tool": { "name": "backup-sqlite.sh", "version": "0.1.0", "clientVersions": { "sqlite3": "3.45.1" } },
  "artifact": { "fileName": "learning.db.sqlite", "format": "sqlite-copy", "bytes": 0, "sha256": "" },
  "tables": [ { "name": "chat_sessions", "rows": 0, "sizeBytes": null, "sha256": "" } ],
  "checks": { "quickCheck": "ok", "integrityCheck": null },
  "drillRef": null
}
```

- **密码不落证据**：证据目录与 manifest 中不得出现 `PGPASSWORD` 明文；连接串里密码位置以 `***` 代替。复核命令只读字段名与 `artifact.sha256` 前缀。

## 5 反向验证（mutation）

| # | 改坏哪一处 | 预期变红的 AC | 还原后 |
|---|---|---|---|
| M1 | 把 SQLite 备份分支换成对运行中库的文件复制（`cp learning.db backup.db`，不带 `-wal`/`-shm`） | AC-G-02、AC-G-03、AC-G-05 | 变绿 |
| M2 | 去掉 manifest 里的 `artifact.sha256` 字段（或封盘后删除 manifest） | AC-G-11、AC-G-01 | 变绿 |
| M3 | 抽样条数从 20 改为 1（`--sample 1` 或脚本内 `LIMIT 1`） | AC-G-06（覆盖判据：样本 < 20 即红） | 变绿 |
| M4 | 移除 `--clean`/`--if-exists` 拒绝清单，让 `pg_restore` 透传该参数 | AC-G-12 | 变绿 |
| M5 | 移除删除前置条件闸（备份 `quickCheck=fail` 或 sha256 不符时仍执行删除） | AC-G-09、AC-G-13 | 变绿 |

执行约定：

```powershell
cd E:\Documents\GitHub\YingXiaoShang
git diff --stat                # 确认只改动了 tools/backup/ 预期文件
# 手工改坏 → 跑对应 AC → 记录失败输出 → 还原文件 → 再跑 → 记录通过输出
git status --porcelain         # 除 .scratch 与 plans 目录外应为空
```

每个 mutation 的记录要求：改坏后跑对应 AC，把失败输出原文存进该 AC 证据目录的 `mutation-<M#>.txt`（含退出码、第一处差异）；还原后再跑一次，存 `mutation-<M#>-restored.txt`，两次输出对照留痕。

mutation 判据沿用 killed/survived 口径：用例变红 = killed；仍绿 = survived，说明这条契约没被覆盖到 [R52]。本工具不引入 Stryker 运行时，5 个 mutation 手工维护。

对照说明：M1 对应的仓内正面证据是 `scripts/package-desktop.mjs:52-58`——既有打包脚本用 `VACUUM INTO` 取一致副本，注释明确「without the WAL sidecar」；文件复制的半写风险在 `docs/requirements/R17-local-data.md:80-81` 同样写明：只复制 `.db` 会丢最近写入。

## 6 排查表

| 症状 | 最可能原因 | 一条命令确认 |
|---|---|---|
| 备份脚本退出码 2，提示缺 SQLite/PG 客户端 | PATH 无 `sqlite3`/`pg_dump`/`pg_restore`，Python stdlib 也不可用 | `python -c "import sqlite3; print(sqlite3.sqlite_version)"`；`Get-Command sqlite3`、`Get-Command pg_dump` |
| `quick_check` 报 `database disk image is malformed` | 产物是半写副本（反例 `cp` 产物）或源库侧车未并入 | 对照 AC-G-10；检查 manifest `tool.name` 与备份方法是否为在线分支 |
| 行数比对某表不等（退出码 3） | 源库在备份期间被写；或副本与源不是同一 schema 版本 | `python -c "import sqlite3; c=sqlite3.connect('.scratch/run/G/home/data/learning.db'); print(c.execute('PRAGMA user_version').fetchone())"`；对比两侧 `tables[].rows` |
| `pg_dump`/`pg_restore` 报版本不匹配 | 客户端 major 与服务端 major 不一致 | `pg_dump --version`；`psql -h 127.0.0.1 -p 55433 -U yxs -c "SHOW server_version;"` |
| `createdb` 报库已存在（退出码 1） | 时间戳后缀撞名或复用了旧恢复库 | `psql -lqt -h 127.0.0.1 -p 55433 -U yxs | findstr yxs_g_restore`；换后缀重跑 |
| 指纹不等但行数相等（退出码 3） | 主键排序不确定、列类型序列化差异、浮点/空串口径不一致 | 看 `samples/<table>.json` 第一处差异的表名与主键；核对 `ORDER BY` 主键是否稳定 |
| 备份中途退出码 2（磁盘不足/备份命令失败） | 目标盘剩余空间低于预估 1.5×，或 `pg_dump`/备份命令非零退出 | `df -P .scratch/run/G/g_backups`（Git Bash/WSL）；`Get-PSDrive C`（PowerShell） |
| PG 连接失败，退出码 2 | `PGHOST/PGPORT/PGUSER/PGPASSWORD` 缺失或实例未起 | `Test-NetConnection 127.0.0.1 -Port 55433`；核对环境变量名与 `yxs-pg-g` 容器状态 |
| 恢复后业务表打不开 | 恢复库 schema 版本高于本支支持版本（应归退出码 2） | 读恢复库 `PRAGMA user_version`，对照 `packages/db/src/index.ts:74` 的 `SCHEMA_VERSION = 7` |
| manifest 缺失或字段为空 | 封盘前校验失败被跳过；脚本提前退出未清理现场 | 查 `stdout.txt` 退出码；按 03 §6 失败处理表对号入座 |
| 证据目录出现密码明文 | 密码被写进命令行、日志或 manifest | `Select-String -Path .scratch\run\G\evidence\* -Pattern "PGPASSWORD="`；核对脚本只从环境读密码 |
| PG 恢复后新库表数为 0 | dump 误用 plain 格式，或 `pg_restore` 连错库 | `pg_restore -l <dump>` 看 TOC；核对 `--dbname` 指向新建 `yxs_g_` 隔离库而非源库 |
| 演练报告缺恢复耗时 | 脚本未记录开始/结束时间戳 | 查 `drill-report.md` 是否有 `elapsedMs`/耗时字段；对照 03 §7 测量方法 |

排查表按「症状 → 最可能原因 → 一条确认命令」组织；PG 版本类症状必须落到客户端/服务端版本原文，不凭感觉判断 [R49]。

## 7 自检输出

文档自检是交活前最后一道机器闸：它只查形式（齐不齐、节数、引用分布、行号引用、占位词），查不到内容对不对——内容由 §3 的 14 条 AC 负责。这种「机器查形式、人查语义」的分工是测试实践的底线 [R36]。

```powershell
cd E:\Documents\GitHub\YingXiaoShang
python plans\server-client-split\00-master\check-docs.py --round G
```

四份齐备后的实跑输出（2026-11-19，口径对齐后复跑）：

```text
仓库根：E:\Documents\GitHub\YingXiaoShang
检查轮次：G
行数统计：
  G-*: 1167 行 / 4 份

全部通过：轮次齐全、节数达标、每节有引用、参考清单与本地行号引用都对得上。
退出码：0
```

退出码 `0`（2026-11-19 口径对齐后复跑）。

说明：

- `01-scope.md`、`02-contract.md` 由并行子代理撰写；本轮四份齐备后自检已全部通过。若后续 01/02 再被改动导致报缺档/缺引用，由主代理在四份齐备时按上面命令重跑复核。
- 若后续 01/02 再被改动，主代理按上面命令重跑 `check-docs.py --round G` 复核；最终行数统计以最后一次为准。

## 参考

- [R36] JavaScript Testing Best Practices — https://github.com/goldbergyoni/javascript-testing-best-practices — 支撑 §1 可机器判定口径、§3 用例写法与 §7 自检分工 — 采用可执行断言，不用人工观察。
- [R45] SQLite Online Backup API — https://www.sqlite.org/backup.html — 支撑 §3 AC-G-01/02 在线备份一致性 — 采用在线备份 API；不采用运行中文件复制。
- [R47] SQLite `PRAGMA integrity_check` — https://www.sqlite.org/pragma.html#pragma_integrity_check — 支撑 §3 AC-G-02/04 两档校验 — quick_check 备份侧、integrity_check 恢复侧。
- [R48] `pg_dump` — https://www.postgresql.org/docs/current/app-pgdump.html — 支撑 §3 AC-G-07 custom 格式与版本探测 — 采用 `--format=custom`。
- [R49] `pg_restore` — https://www.postgresql.org/docs/current/app-pgrestore.html — 支撑 §3 AC-G-08/12 新库恢复与版本排查 — 禁止 `--clean` 打既有库。
- [R51] restic — https://github.com/restic/restic — 支撑 §4 证据命名与时间戳目录 — 借鉴命名；不引入加密仓库。
- [R52] databasus — https://github.com/databasus/databasus — 支撑 §1 「备份后做恢复验证」闭环与 §5 killed/survived 口径 — 借鉴恢复验证；不引入 Web UI/PITR。
- [R53] pgbackrest GitHub — https://github.com/pgbackrest/pgbackrest — 支撑 §3 AC-G-11 校验产物可追溯 — 借鉴 checksum/verify 留痕。
- [R6] 12-Factor Logs — https://12factor.net/logs — 支撑 §4 结构化证据落盘到 stdout/文件 — 直接采用；不引入日志聚合服务。
