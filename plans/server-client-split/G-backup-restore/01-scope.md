# G · 备份与恢复 · 范围与边界

> 轮次：G · 备份 / 恢复 / 演练工具
> 文档角色：01-scope
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1（§10.2 环境变量、§10.3 数据目录、§10.5 PostgreSQL）
> 写权：[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1 文件矩阵、§3 运行期资源
> 一句话：在 `tools/backup/` 下交付一套「SQLite 在线快照 + PG custom 格式快照 + 删数据后恢复核对演练」的手工可重复工具，所有演练对象只落在 `.scratch/run/G/` 隔离副本上。

## 1 目标

1. **SQLite 在线一致性备份**：对 `.scratch/run/G/` 下的 `learning.db` 副本产出一致性快照，优先走 sqlite3 `.backup` 在线备份，不可用时以 `VACUUM INTO` 兜底；**禁止**用文件复制（`cp`）拷贝正在写入的库文件。
   判断标准：备份期间在副本里写入一行尚未 checkpoint 的数据，快照打开后该行存在；备份产物能被独立打开并通过 `quick_check`。在线备份 API 之所以不能被文件复制替代，是因为复制过程可能拿到半写页与未合并的 WAL 状态 [R45]。
2. **SQLite 恢复与双档完整性校验**：把快照恢复到指定目标路径，恢复完成后先跑 `quick_check` 快门槛，再跑 `integrity_check` 全量门槛；任一档位返回非 `ok` 即判失败。
   判断标准：恢复库逐表行数与备份前基线一致；故意损坏快照后恢复，脚本以非零退出码失败并打印首条校验结果。完整性检查的两档划分依据 SQLite 官方 pragma 文档 [R47]。
3. **PostgreSQL 一致性备份**：对隔离实例 `yxs-pg-g`（宿主端口 `55433`）上的 `yxs` 库执行 `pg_dump --format=custom`，产物落 `.scratch/run/G/g_backups`，并记录大小、sha256、耗时与逐表行数。
   判断标准：dump 文件能被 `pg_restore -l` 列出目录清单；manifest 中的 `bytes` 与 `sha256` 可复算。custom 格式支持并行恢复与选择性恢复，是本轮选定的导出格式 [R48]。
4. **PostgreSQL 恢复到隔离新库**：`pg_restore` 只恢复到带时间戳的新建库，脚本内**硬编码不使用 `--clean`**，不得覆盖已有库；恢复后做行数与抽样核对。
   判断标准：演练后源库 `yxs` 行数不变；恢复目标库名形如 `yxs_g_restore_<timestamp>`；命令行静态检查不含 `--clean` / `--if-exists`。恢复到新库而非清理旧库，是 `pg_restore` 文档对生产数据的基本安全口径 [R49]。
5. **可重复的恢复演练**：按「备份 → 真删演练数据 → 恢复 → 逐表行数 + 20 条样本核对」走完整闭环，产出演练报告，含耗时、产物大小、校验结果与首处差异。
   判断标准：`restore-drill.md` 报告骨架字段齐全；全绿时退出码 0，任一核对项失败时退出码 3 并指出第一张不一致的表。成熟备份体系把「定期演练恢复」当作备份有效性的唯一证明，而不是只看备份命令跑没跑过 [R50]。
6. **产物可追溯**：每份备份带一份 manifest，记录源标识、时间、格式、文件大小、sha256、逐表行数与校验档位结果；目录按 `host/path/timestamp` 三层组织。
   判断标准：任意一份备份仅凭 manifest 即可还原出源主机、源路径、schema 版本与校验值；备份目录命名规则与文件名模板在 `02-contract.md` §2 写死。这种按主机/路径/时间分层的目录组织借鉴自独立备份工具的仓库布局 [R51]。

目标排序是「先保证快照一致性，再保证恢复可校验，最后才谈演练报告」：在线备份口径先行 [R45]，恢复校验紧随 [R47]，PG 侧再对齐 `pg_dump` / `pg_restore` 的安全用法 [R48][R49]。

## 2 非目标

| 不做 | 为什么不做 |
|---|---|
| 不做定时调度、cron 任务或常驻备份服务 | 调度与 compose 归 C 轮（`services/deploy/**` 唯一 owner）；G 只交付手动可重复执行的脚本，不写定时配置 [R50] |
| 不做增量备份、WAL 归档或连续备份（PITR） | 本轮只做全量快照；连续归档需要保留 WAL 序列与回放工具链，超出本轮工具范围 |
| 不引入加密仓库、去重仓库或异地复制体系 | 不落地 restic / pgBackRest 的仓库服务端；只借鉴它们的命名分层与「备份必须可验证」思路 [R50][R51] |
| 不做旧备份的自动保留与清理策略 | 本轮只在 manifest 里记录产物元信息；保留轮次、过期删除属于后续运维策略，不在脚本内实现删除动作 |
| 不备份 `auth.db` | 登录与 token 表是 A 轮在服务端自建的独立库（冻结 §3.4），冻结 §10.5 明确迁移与备份口径只针对业务库 `learning.db` / PG `yxs` |
| 不备份 `artifacts/`、`exports/`、`raw/`、`spill/` 等文件产物 | 本轮覆盖对象是数据库；学生产物文件按学生/月分目录存放（`docs/requirements/R17-local-data.md:52-55`），文件级备份另立议题 |
| 不改 `packages/db`、不切换运行时数据源、不做 SQLite → PG 迁移 | schema 定义归共享包只读引用；迁移工具是 D 轮 `tools/migrate-pg/**` 的职责，G 只消费库与副本，不回写方言映射 |
| 不写 compose 文件、不编排容器网络与数据卷生命周期 | compose 归 C 轮；G 对接一个已经存在的 PG 实例，容器名 `yxs-pg-g` 与端口 `55433` 是对接事实，不是 G 负责拉起的编排资源 |
| 不对真实用户数据目录执行备份或删除 | 受保护目录（`%APPDATA%`、`~/.learning-agent`、`<repo>/.learning-agent`）一律拒绝；演练对象只能是 `.scratch/run/G/` 下的副本与隔离 PG 库 |
| 不做备份文件的版本兼容转换（跨大版本 PG dump 回灌） | 本轮客户端工具版本与实例版本同代；跨版本恢复属于升级场景，不在演练闭环内 |

## 3 真实依据（现状代码）

> 以下证据全部来自 2026-11-19 工作区代码，行号当场用 `Select-String` 与 Python 行数口径核对。备份口径、表集合、删除边界都从这些事实推出。

| # | 位置 | 现在是什么 | 为什么与本轮相关 |
|---|---|---|---|
| 1 | `scripts/package-desktop.mjs:52-58` | 打包脚本先 `rmSync` 旧种子库，注释写明「VACUUM INTO writes a consistent copy without the WAL sidecar」（`:52-53`），`:56` 执行 `sourceDb.exec(\`VACUUM INTO …\`)`，`:58` 在 `finally` 里 `sourceDb.close()` | 这是仓库内已有的「一致性复制」先例，直接证明不能用 `cp` 拷在线库；G 的 SQLite 备份口径沿用同一条原理 [R46] |
| 2 | `packages/db/src/index.ts:92-441` | 38 张 `STRICT` 表的 `CREATE TABLE`，含单列 `TEXT PRIMARY KEY`、复合主键、`NOT NULL`、`DEFAULT` 与外键 `ON DELETE CASCADE` | 备份/核对的表名集合、主键列清单、抽样排序键全部以这段 schema 为准；STRICT 约束保证抽样比对时空值类型口径稳定 [R22] |
| 3 | `packages/db/src/index.ts:831-834` | `new DatabaseSync(this.dbPath)` 后依次 `PRAGMA foreign_keys = ON`、`PRAGMA journal_mode = WAL`、`PRAGMA busy_timeout = 5000` | 运行时库处于 WAL 模式，同目录伴随 `learning.db-wal` 与 `learning.db-shm` 边车文件；只复制主 `.db` 文件会丢掉 WAL 里尚未 checkpoint 的写入 |
| 4 | `packages/db/src/index.ts:93` | `chapters` 表定义为 `id TEXT PRIMARY KEY, number INTEGER …`；其余多数业务表同样以 `id TEXT PRIMARY KEY` 为键，少数表为复合主键（如 `question_kps` 的 `PRIMARY KEY (question_id, kp_id)`，`:177`） | 抽样确定性规则的排序键来源：单列主键按 `id` 升序，复合主键按全部主键列升序；核对时两侧用同一 SQL 文本配对 |
| 5 | `docs/requirements/R17-local-data.md:47-56` | 数据目录布局：`<LEARNING_AGENT_HOME>/data/learning.db`（运行时伴随 `-wal` / `-shm`）、`artifacts/<studentId>/<YYYY-MM>/`、`exports/`、`raw/<source>/<articleId>.html`、`spill/` | 备份对象与目录边界以此为准；G 只备 `data/learning.db`，文件产物目录不在本轮范围 |
| 6 | `docs/requirements/R17-local-data.md:78-82` | 需求原文已写明备份要求：必须做 SQLite 在线备份（`sqlite3 learning.db ".backup backup.db"` 或 `VACUUM INTO 'backup.db'`）；关库后整目录复制必须带上 `-wal` 与 `-shm`；不要用 `RESET_DB=1` 重置学习记录 | 本轮脚本口径直接落实这条需求；`-wal`/`-shm` 处置与删除禁令在 §7 风险表逐条对应验证方法 |
| 7 | `docs/requirements/R17-local-data.md:124` | 现状差距第 6 条：「无自动备份：没有备份按钮，也没有升级前提示；只能靠手工命令」 | 这是本轮要补的能力缺口：交付手工即可重复跑的备份、恢复与演练脚本，不做界面按钮 |
| 8 | `pipeline/seed-db.ts:46` | `if (process.env.RESET_DB === '1') db.resetDomainData()` | 现有重置手段是 seed 流程里的全量重置开关；演练删除不得复用这个开关，必须在隔离库/副本上显式执行删除动作并在报告留痕 |
| 9 | `apps/desktop/src/main/index.ts:69-77` | 首跑时若 `appHome/data/learning.db` 不存在（`dbPath` 定义在 `:71`），从 `process.resourcesPath/seed/learning.db` 或 `app.getAppPath()/seed/learning.db` 找到种子库复制过去 | 确认运行时数据源路径布局为 `<appHome>/data/learning.db`；G 的源路径校验与目录快照 slug 都按这个相对布局生成 |
| 10 | `packages/shared/src/brand.ts:13` | `dbFile: 'learning.db'`，业务主库文件名由品牌常量定义 | 脚本默认查找的文件名口径以此为准；不接受把 `auth.db` 等其他文件当成业务库传入 |
| 11 | `plans/server-client-split/00-master/01-frozen-contracts.md:409-418` | 冻结 §10.3 容器内数据目录：`data/learning.db`（含 `-wal` / `-shm`）、`data/auth.db`、`artifacts/<studentId>/<YYYY-MM>/`、`exports/`；并注明 `data/data/learning.db` 这一层是有意沿用桌面端布局 | 备份范围只圈定业务库文件；`auth.db` 与产物目录排除出本轮备份清单；路径快照 slug 按既有相对布局生成 |
| 12 | `plans/server-client-split/00-master/01-frozen-contracts.md:436-440` | 冻结 §10.5：`postgres:16-alpine`、库 `yxs`、用户 `yxs`、`jsonb` / `bigint` / `double precision` / `text` 类型对应；迁移只针对 `learning.db`，`auth.db` 不在范围 | PG 备份与恢复演练对接的实例版本、库名、用户名以此为准；G 不新增 PG 侧业务索引、视图或触发器 |

这 12 条共同指向一件事：**现状的数据模型、WAL 形态与目录布局都已经冻结在既有代码与需求文档里**，本轮是把已有的「一次性打包取种子」做法 [R46] 扩展成一套可重复、可校验、可演练的备份工具，而不是重新设计存储结构。

## 4 与现行为的差异（有意变更）

| 项 | 现状 | G 轮契约 | 影响谁 |
|---|---|---|---|
| 备份方式 | 打包脚本一次性 `VACUUM INTO` 取种子库（`scripts/package-desktop.mjs:56`），不记录产物元信息 | 交付可重复跑的备份脚本，SQLite 走 `.backup` 优先、`VACUUM INTO` 兜底；每份产物带 manifest（源、时间、大小、sha256、逐表行数） | 演练执行者；后续若做自动调度直接复用脚本与 manifest |
| 文件复制口径 | 需求文档提醒关库整目录复制要带边车（`R17-local-data.md:81`），但仓库内没有可执行工具 | 在线库一律禁止 `cp` 主文件；若走文件级复制只能在库已关闭且 `-wal`/`-shm` 一并带走时进行，脚本不提供这条路径 | 实现者不得图省事改成 `cp`；验收有静态检查 |
| 恢复后校验 | 现状无恢复路径，也无完整性校验口径 | 恢复后固定双档：先 `quick_check`，通过后 `integrity_check`；非 `ok` 即退出码 3 | 验收者按档位结果判过；E 轮契约测试可复用档位断言 |
| 数据删除 | 学习记录重置依赖 `RESET_DB=1`（`pipeline/seed-db.ts:46`），仅靠文档约束 | 演练删除只在 `.scratch/run/G/` 副本与隔离 PG 库上显式执行；受保护目录直接拒绝（退出码 1）；删除前后行数写入报告 | 演练执行者；防止误删真实数据 |
| PG 侧备份 | 现状 PG 仅作为 D 轮迁移目标，无备份与恢复演练 | 55433 / `yxs-pg-g` 隔离实例；`pg_dump -Fc` 导出，`pg_restore` 到时间戳新库；禁止 `--clean` 打源库 | D 与 G 并行时端口、库名互不交叉 |

> 这 5 条差异不是顺手改改，而是拆分后「数据可运维」必须成立的语义，逐条写进 `02-contract.md` 对应章节，并由 G 轮自测用例（`02-contract.md` §7）断言。

其中「禁止 `--clean` 打已有库」属于恢复操作的底线安全约束：`pg_restore` 的 `--clean` 会在恢复前 DROP 目标库对象，一旦目标名指向生产库就是不可逆覆盖 [R49]；本轮用「恢复到全新隔离库」从根上规避这条路径。

## 5 产物清单

> 全部落在写权矩阵归 G 的 `tools/backup/**`（`02-ownership-and-parallel.md` §1）。下表前 5 项为本轮必交产物，其余为内部辅助文件。

```text
tools/backup/
  backup-sqlite.sh      【必交】SQLite 在线备份：.backup 优先、VACUUM INTO 兜底；写 manifest 与抽样基线
  restore-sqlite.sh     【必交】从快照恢复到目标路径；清理残留边车；quick_check + integrity_check 双档校验
  backup-pg.sh          【必交】pg_dump --format=custom 导出 yxs；写 manifest、逐表行数与 sha256
  restore-pg.sh         【必交】pg_restore 到隔离时间戳新库；硬编码禁用 --clean；行数 + 抽样核对
  restore-drill.md      【必交】演练报告骨架（字段模板）+ 最近一次演练实例的落点说明
  drill.sh              内部编排：备份 → 记录基线 → 删除演练数据 → 恢复 → 核对 → 生成报告
  lib/common.sh         共享函数：中文日志、退出码、manifest 读写、抽样 SQL、sha256 复算、受保护路径判断
  README.md             用法、前置工具版本、环境变量表、复跑命令
```

**文件职责一览**：

| 文件 | 角色 | 主要输入 | 主要输出 | 失败归类（退出码） |
|---|---|---|---|---|
| `backup-sqlite.sh` | SQLite 在线备份 | 副本路径、备份目录、方法选择 | 快照文件、`manifest.json`、抽样基线 JSON | 参数/路径违规归 1；打不开/命令失败归 2；快档校验不过归 3 |
| `restore-sqlite.sh` | SQLite 恢复 + 双档校验 | 快照文件、目标路径、manifest | 恢复库、校验结果、核对记录 | 参数归 1；产物损坏归 2；校验/行数/抽样不符归 3 |
| `backup-pg.sh` | PG custom 格式备份 | 连接环境变量、库名、备份目录 | `yxs.dump`、`manifest.json`、逐表行数 | 参数归 1；连接/导出失败归 2；产物目录列表不可读归 3 |
| `restore-pg.sh` | PG 隔离新库恢复 | dump 文件、目标库名、抽样数 | 新库、行数/抽样核对记录 | 请求 `--clean` / 库名违规归 1；建库/恢复失败归 2；核对不符归 3 |
| `restore-drill.md` | 演练规程与报告骨架 | 四段脚本的中间产物 | 七段字段的演练报告实例 | 不直接退出；编排失败由 `drill.sh` 归类 |
| `drill.sh` | 演练编排器（内部） | `--kind`、`--source`、抽样数、报告路径 | 完整闭环记录与 `drill-report.md` | 沿用上表归类；删除阶段前置不满足则中止 |
| `lib/common.sh` | 共享函数库 | — | 参数解析、中文日志、退出码常量、manifest 读写、指纹与 sha256 复算、受保护路径判断 | 不独立退出 |
| `README.md` | 使用说明 | — | 前置工具版本、环境变量表、复跑命令、已知限制 | — |

**同时新增（不改动）**：无。除上述 `tools/backup/**` 与 `.scratch/run/G/` 下的演练产物外，不碰任何既有文件。备份实例产物（dump、快照、manifest、抽样 JSON、报告实例）统一落 `.scratch/run/G/g_backups/<host>/<path-slug>/<timestamp>/`，不进仓库版本库。

目录分层按「主机 / 源路径 / 时间戳」组织，命名与文件名模板在契约里写死 [R51]；PG 导出选用 custom 格式而非 plain SQL，以便 `pg_restore` 选择性恢复与并行回灌 [R48]。Shell 工具自身不引入 Node 依赖（`02-ownership-and-parallel.md` §3：`tools/backup` 无 Node 依赖），只调系统客户端命令。

## 6 并行边界

1. **只读依赖**：G 只读引用 `packages/db/src/index.ts` 的 schema 与主键清单、`packages/shared/src/brand.ts` 的文件名常量、冻结契约与需求文档；不 `import` 共享包代码、不改一行 `packages/**`。表名集合若与 schema 漂移，按 §7 风险 7 的版本校验处理。
2. **写权唯一**：本轮所有新建文件只落在 `tools/backup/**`；manifest、抽样、报告实例只写 `.scratch/run/G/`。`packages/**`、`apps/**`、`docs/**`、`services/**`、`tools/migrate-pg/**`、`tools/contract-tests/**`、`tools/loadtest/**` 全部只读。
3. **运行时资源**：PG 宿主端口 `55433`（G 专用，与 D 的 `55432` 不交叉）；容器名 `yxs-pg-g`；临时根目录 `.scratch/run/G/`；备份目录 `.scratch/run/G/g_backups/`；PG 源库 `yxs`，恢复目标库 `yxs_g_restore_<timestamp>`；不删 `.scratch/` 下其他轮次目录。
4. **不依赖他轮产物**：开工不需要 A 的服务端、D 的迁移结果、E 的契约测试或 F 的压测产物先完成。演练源数据由 G 自己在 `.scratch/run/G/` 下准备 seed 库副本；D 迁移后的 PG 库可作为可选输入，但工具不以 D 产物为前置条件。
5. **冲突裁决**：端口被占时按冻结 §3 的 +100 规则退避（`55433 → 55533 → 55633`），并在演练报告写明实际端口；发现 `tools/backup/` 下存在非 G 改动，只在报告里登记「外部改动」并重新验证，不擅自回滚别人的文件；契约口径与冻结文件冲突时，按 `02-ownership-and-parallel.md` §5 走契约例外申请，不在脚本里私自放宽。

**五条自证（每条对应上面一项，验收时可逐条核对）**：

1. **只读依赖自证**：`tools/backup/**` 内脚本对 `packages/**` 只做路径与表名读取，不出现 `require` / `import` 共享包代码；交付后 `git status --porcelain packages apps docs services` 为空。
2. **写权唯一自证**：本轮新建文件清单与 §5 产物表逐条一致；manifest、抽样、报告实例只出现在 `.scratch/run/G/`；全仓搜索 `tools/backup` 之外无本轮新增路径。
3. **运行时资源自证**：配置与日志只出现 `55433`、`yxs-pg-g`、`g_backups`、`.scratch/run/G/`；不出现 D 轮的 `55432`、`yxs-pg-d`、`yxs-pg` 卷名；端口占用时按 +100 退避并在报告写明实际端口。
4. **不依赖他轮产物自证**：在没有 `apps/server` 运行、没有 D 轮迁移库的前提下，仅凭 `.scratch/run/G/` 下自准备的 seed 副本即可跑完 SQLite 备份—恢复—核对闭环；PG 链路对接的是 G 自己的隔离实例，不读 D 的库与产物。
5. **冲突裁决自证**：发现非 G 改动只登记不回滚；契约与冻结文件冲突时走例外申请；脚本内不私自放宽受保护目录、`--clean` 拒绝清单与 schema 版本校验三条硬约束。

与 D 的边界最容易踩线：两者都连 PG，但端口、容器名、库名前缀全部分开（D：`55432` / `yxs-pg-d`；G：`55433` / `yxs-pg-g`），且 D 不做 `pg_dump` / `pg_restore`，G 不做 SQLite → PG 装载。连接参数读取顺序与环境变量名沿用冻结 §10.2，只把端口默认值改成 G 专用值。隔离实例 + 独立备份目录的组织方式参照成熟备份代理按任务隔离资源的做法 [R54]，端口退避与外部改动登记则按冻结 `02-ownership-and-parallel.md` §5 执行。

## 7 未知与风险

| # | 风险 | 怎么验证这个风险是否发生 |
|---|---|---|
| 1 | **WAL 边车文件未一并备份**：若误用文件复制，只带走 `learning.db` 而 `-wal` 未合并，最近写入会丢；在线备份命令生成一致性副本可规避这条路径 [R45] | 备份前在副本里写入一行未 checkpoint 的数据，备份后打开快照核对该行是否存在；manifest 记录源库 `journal_mode` 与备份方法（`backup` / `vacuum`）；若快照缺行，判风险发生，回退检查是否走了文件复制 |
| 2 | **恢复后 `-wal` / `-shm` 残留**：目标路径旁混入旧边车文件，SQLite 可能读到与新快照不一致的状态；双档校验是识别这类脏状态的最后一道门槛 [R47] | 恢复前删除目标路径旁的 `*-wal`、`*-shm`；恢复完成后列出目录确认无残留；随后双档校验通过才算恢复成功；校验非 `ok` 时按残留边车或快照损坏分别在报告标注 |
| 3 | **PG 恢复到已有库的覆盖风险**：`--clean`、`--if-exists` 或恢复到同名库可能覆盖现有对象与数据；`pg_restore` 的清理语义在恢复目标选错时不可逆 [R49] | 脚本固定 `createdb` 新建时间戳库；静态检查恢复命令行不含 `--clean` / `--if-exists`；演练后重新连接源库 `yxs` 核对行数与基线一致；脚本收到显式 `--clean` 参数直接退出码 1 |
| 4 | **演练删数据不可逆**：真删之后若恢复失败，副本/隔离库数据即丢失 | 删除前必须存在一份校验通过、sha256 可复算的备份；删除动作、删除前后行数写入报告；演练对象仅限 `.scratch/run/G/` 副本与隔离 PG 库；路径命中受保护目录时退出码 1，不执行任何删除 |
| 5 | **本机缺少 sqlite3 / pg_dump / pg_restore 客户端**：Windows 环境可能未装 PG 客户端与 sqlite3 CLI，脚本无法执行 | 脚本启动先探测 `sqlite3 --version`、`pg_dump --version`、`pg_restore --version`；缺失时退出码 2 + 中文消息，列出缺少的工具；前置版本要求写进 `README.md`，实测版本号回填 manifest 的 `tool` 段 |
| 6 | **备份大小与耗时无基线**：本轮不虚构产物大小、备份耗时、恢复耗时等数值 | manifest 与报告只记录实测 `bytes`、`elapsedMs`；首次演练实测后回填基线，后续演练与基线对比；测量方法：命令前后各取一次 UTC 时间戳，差值记毫秒，文件大小取 `stat` 字节数 |
| 7 | **schema 版本漂移**：`packages/db` 将来升到 8 版或增删表，表集合与抽样清单漏表 | 备份前读 `PRAGMA user_version`，与预期版本 7 比对；表清单与 schema 登记集合双向核对；版本不符或表集合缺失时退出码 2，不生成「看似成功」的备份 |
| 8 | **PG 实例未就绪或密码未注入**：`PGPASSWORD` 未设、实例未起，`pg_dump` 直接失败 | 备份前先跑一次连接探测（`pg_isready` 或等价查询）；失败时退出码 2，中文消息提示检查 `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD`；连接串出现在日志里时密码替换为 `***` |
| 9 | **scratch 目录空间不足或被并行清理**：`.scratch/run/G/` 与其他轮次共用磁盘，备份写到一半空间不足会留下半成品；其他轮次清理 `.scratch/` 时误删 G 目录也会导致基线丢失 | 备份前检查目标目录剩余空间（预估 ≥1.5× 源库大小）；半成品目录保留不自动删，manifest 标失败；报告附录记录磁盘余量；不删 `.scratch/` 下其他轮次目录，也不依赖他人保留 G 目录 |
| 10 | **演练期间源副本被并发写入**：备份与演练闭环期间若有进程打开副本写入，快照与基线可能漂移，核对时出现「行数对不上」的假失败 | 备份前探测源库占用；演练闭环期间不启动业务进程写副本；manifest 记录备份方法与源库 `journal_mode`；复核时先排除并发写入，再判数据不一致 |

风险 3 与 4 是本轮仅有的两条不可逆路径，设计上用「隔离新库 + 副本对象 + 删前必有校验通过的备份」三重约束兜住；其余风险都可以通过脚本内前置探测与报告留痕在演练当场暴露。

## 参考

- [R22] SQLite STRICT tables — https://www.sqlite.org/stricttables.html — 支撑 §3 第 2 条 STRICT 表与空值类型口径 — 采用 STRICT 约束下的抽样比对口径；不改动共享包 schema。
- [R45] SQLite Online Backup API — https://www.sqlite.org/backup.html — 支撑 §1 目标 1 与 §3 第 1 条「为什么不能 `cp` 在线库」 — 采用在线备份一致性语义；不引入其 C API 绑定，脚本走 sqlite3 CLI 的 `.backup` 命令。
- [R46] SQLite `VACUUM INTO` — https://www.sqlite.org/lang_vacuum.html — 支撑 §3 第 1 条既有先例与 §1 目标 1 的兜底方法 — 采用 `VACUUM INTO` 作为无在线备份支持时的等价快照；不把它当成常规首选。
- [R47] SQLite `PRAGMA integrity_check` — https://www.sqlite.org/pragma.html#pragma_integrity_check — 支撑 §1 目标 2 与 §7 风险 2 的双档校验 — 采用 `quick_check` + `integrity_check` 两档；备份侧不跑全量校验以免长锁源库。
- [R48] `pg_dump` — https://www.postgresql.org/docs/current/app-pgdump.html — 支撑 §1 目标 3 与 §5 产物格式 — 采用 `--format=custom`；不用 plain SQL 格式（无法选择性恢复与并行回灌）。
- [R49] `pg_restore` — https://www.postgresql.org/docs/current/app-pgrestore.html — 支撑 §1 目标 4、§4 差异表与 §7 风险 3 — 采用「恢复到新库」口径；禁止 `--clean` 打生产库。
- [R50] pgBackRest — https://pgbackrest.org/ — 支撑 §1 目标 5 的「演练证明备份有效」与 §2 非目标 — 借鉴备份可验证、有保留概念；不引入其 repo 体系与归档服务端。
- [R51] restic — https://github.com/restic/restic — 支撑 §1 目标 6 与 §5 的 `host/path/timestamp` 目录分层 — 借鉴目录组织与元信息清单；不引入加密仓库、去重快照链。
- [R52] dimitri/pgcopydb — https://github.com/dimitri/pgcopydb — 支撑 §5 PG 工具链对照（`pg_dump | pg_restore` 管线形态） — 借鉴「导出目录清单可列、恢复目标可指定」的组织；不引入其流式复制与订阅能力。
- [R53] gabfl/pg_dump-to-s3 — https://github.com/gabfl/pg_dump-to-s3 — 支撑 §5 备份脚本与 manifest 字段的对照 — 借鉴「dump 产物 + 元信息清单」的 Shell 工具结构；不做 S3 上传与远程留存。
- [R54] stefanprodan/mgob — https://github.com/stefanprodan/mgob — 支撑 §6 并行边界与 §7 风险 8 的报告/探测思路 — 借鉴备份前后状态留痕与失败分类；不引入其调度、通知与 Prometheus 上报。
