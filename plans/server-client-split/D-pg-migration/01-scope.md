# D · SQLite → PostgreSQL 迁移工具 · 范围与边界

> 轮次：D · SQLite → PostgreSQL 迁移与校验工具
> 文档角色：01-scope
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1（§10.5 PostgreSQL 口径）
> 写权：[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1
> 一句话：只在 `tools/migrate-pg/` 下产出一套「可重复跑的迁移 + 可审计的校验 + 默认只打印的回滚」工具，运行时数据源仍然是 SQLite，一行共享代码都不改。

## 1 目标

1. **产出可重复执行的 SQLite → PostgreSQL 迁移工具**：把一份 `learning.db` 副本按冻结 §10.5 的映射口径导入 PG `yxs` 库；schema 映射、列约束、主键与唯一索引的逐条契约写在 `02-contract.md`。
   判断标准：`migrate.js` 对同一源库连跑两遍，`verify.js` 逐表行数不变、抽样比对全绿；不产生重复行。
2. **产出可审计的数据校验工具**：38 张表逐表行数 100% 比对，每表抽样 20 行做字段级比对，`news_articles` 额外复算 `content_hash` 与正文。
   判断标准：一致时 `verify.js` 退出码 0；人为改坏目标库一行正文后，退出码 3 并在 stdout 打印第一处差异（表名、主键、列名、两侧取值）。
3. **产出默认安全的回滚工具**：`rollback.js` 默认 `--dry-run`，只打印本轮创建的表与待执行动作，不删任何数据；只有显式 `--apply` 才清理。
   判断标准：不带参数执行 `rollback.js` 后，PG 库里的表仍然存在；dry-run 输出完整列出待删表名。
4. **迁移过程独立于运行时**：工具只读 `packages/db` 的 schema 定义作为映射依据，不把运行时连接切到 PG，不修改共享包与服务端代码。
   判断标准：交付后 `git status --porcelain packages apps` 为空；新增文件全部落在 `tools/migrate-pg/` 下。
5. **运行期资源与 G 轮隔离**：D 的 PG 实例固定用宿主端口 `55432`、容器名 `yxs-pg-d`、数据卷 `yxs-pg`、库名/用户名 `yxs`，与 G 轮的 `55433` / `yxs-pg-g` 互不抢占。
   判断标准：D 与 G 并行执行各自迁移演练时，不出现端口占用、不写对方库、不删对方卷。

迁移工具自身的「版本化、可重复执行、留校验痕迹」思路参照成熟迁移工具的组织方式 [R5]；但本轮不引入第三方迁移框架，映射规则与校验口径全部在工具内自包含，保证可审计、可 verify、可 rollback [R1]。

## 2 非目标

| 不做 | 为什么不做 |
|---|---|
| **不切换运行时数据源**：A 轮服务端运行时仍然读 SQLite `learning.db`；D 不把 `packages/db` 的连接改成 PG，不做 ORM/方言切换 | 冻结 §1 明确 `packages/**` 无人可写；运行时切 PG 是后续阶段的事，本轮只交付迁移与校验能力。迁移工具内部做方言映射，不回写共享包（`02-ownership-and-parallel.md` §2「D 改不改运行时 SQL 方言」一行已冻结） |
| **不改 `packages/db`、不碰 `apps/server`** | 写权矩阵里这两条路径 owner 为空，禁止修改；D 只读 `packages/db/src/index.ts` 提取表与列定义 [R3] |
| **不迁移 `auth.db`** | 登录与 token 表是 A 轮在 `apps/server` 自建的独立库（冻结 §3.4），冻结 §10.5 明确迁移只针对 `learning.db` |
| **不做 PG 运行时调优**：不设计分区、连接池策略、业务索引增补，也不为 JSON 列建 GIN 索引 | 本阶段 PG 库只承担迁移产物、比对与备份演练角色；`jsonb` 列当前没有按 JSON 内部结构查询的需求 [R8] |
| **不跑 docker 编排、不起 compose、不启停 PG 容器** | 容器与 compose 归 C 轮；工具只通过连接串对接一个已经存在的 PG 实例。容器名/端口/卷名是本工具对接的目标事实，不是本工具负责拉起的资源 |
| **不做在线增量同步、双写或 CDC** | 本轮是一次性快照迁移；运行时仍写 SQLite，增量同步属于未来切换阶段的议题 |
| **不做 PG 备份与恢复** | `pg_dump` / `pg_restore` / 演练脚本归 G 轮；D 只保证被迁移的数据本身可校验 [R6] |
| **不改造桌面端 Electron** | 桌面端保持可运行（冻结 §11）；H 轮的 mutation patch 与本轮无关 |

回滚口径上，本轮**禁止**对共享库使用 `TRUNCATE` 式清理；回滚只删除「本轮工具自己登记创建的表」，且默认只演练不执行 [R6]。

## 3 真实依据（现状代码）

> 以下证据全部来自 2026-11-19 工作区代码，行号当场用 `Select-String` 核对。迁移清单、映射规则与校验基线都从这些事实推出。

| # | 位置 | 现在是什么 | 为什么与本轮相关 |
|---|---|---|---|
| 1 | `packages/db/src/index.ts:92-232` | 基线 `SCHEMA`：22 张 `STRICT` 表的 `CREATE TABLE`，含主键、`NOT NULL`、`DEFAULT` 与 `REFERENCES … ON DELETE CASCADE` | PG DDL 的表名、列名、可空性、默认值、外键动作都以这段为准；STRICT 约束必须在目标库保留 [R3] |
| 2 | `packages/db/src/index.ts:236-447` | `MIGRATION_2` 至 `MIGRATION_7`：31 条 `ALTER TABLE ADD COLUMN`，外加 `competencies`、`evidence`、`growth_snapshots`、`learning_plan`、`chat_sessions`、`chat_messages`、`memory_facts`、`memory_episodes`、`artifacts`、`skills`、`turns`、`learning_states`、`summary_ledger`、`question_bank`、`kp_canonical_map`、`block_canonical_map` 共 16 张追加表 | 完整列集合 = 建表段 + 这些增量；只按基线段映射会漏掉 `profile_json`、`seq`、`payload_json`、`content_hash` 等增量列 |
| 3 | `packages/db/src/index.ts:831-834` | `new DatabaseSync(this.dbPath)`，随后 `PRAGMA foreign_keys = ON`、`journal_mode = WAL`、`busy_timeout = 5000` | 源库是 SQLite 方言、外键开启；D 不改这段连接代码，只在工具内部把外键语义翻译成 PG `FOREIGN KEY … ON DELETE CASCADE` |
| 4 | `packages/db/src/index.ts:850-931` | `PRAGMA user_version` 读版本号，按 1→7 顺序执行迁移段，最终 `user_version = 7` | 迁移前必须校验源库 schema 版本为 7；版本不符说明库没跑齐本地迁移，直接映射会漏列 |
| 5 | `pipeline/seed-db.ts:43-46` | `ctx.plugin(LearningDb, { appHome })` 装入 DB 包；`RESET_DB === '1'` 时调 `resetDomainData()` | seed 流程产出的就是 `learning.db`；本轮的源数据只能取这类库的副本，不连真实用户目录 |
| 6 | `pipeline/seed-db.ts:78-102` | 依次 `upsertChapters`、`upsertSections`、`upsertKps`、`syncBlocksForChapter`、`upsertIdeology`，并把教学指南写进 `plugin_state` | 表之间有明确写入先后；PG 导入顺序必须按父表先于子表排列，否则外键约束会挡住批量 COPY |
| 7 | `pipeline/seed-db.ts:164-184` | 收尾 `console.log(JSON.stringify({…}))`，输出 `chapters`、`knowledge_points`、`content_blocks`、`questions`、`news` 等各表计数 | `verify.js` 的行数基线可与这份 seed 摘要交叉核对；摘要里出现的表名是迁移清单的旁证 |
| 8 | `apps/desktop/src/main/index.ts:71-81` | 首跑时若 `appHome/data/learning.db` 不存在，从 `process.resourcesPath/seed/learning.db` 或 `app.getAppPath()/seed/learning.db` 找到 seed 库并 `copyFileSync` 过去 | 运行时数据源始终是这个 SQLite 文件；本轮所有工具都面向这份文件的副本工作，不替代它 |
| 9 | `packages/db/src/index.ts:2855` | `createHash('sha256').update(article.content).digest('hex')` 计算 `content_hash`；`packages/db/src/index.ts:2889` 对已存正文复算同一哈希 | `verify.js` 的哈希比对口径：对抽样 `news_articles` 行，用目标库 `content` 复算 sha256 hex，与 `content_hash` 列比对 |
| 10 | `packages/shared/src/brand.ts:13` | `dbFile: 'learning.db'`，业务主库文件名由品牌常量定义 | 源库文件名口径；工具默认查找的文件名以此为准，不另起名 |
| 11 | `packages/db/src/index.ts:815-824` | `dbPath` 字段与 `config.path ?? join(this.appHome, 'data', BRAND.dbFile)` 的解析顺序 | 工具定位源库时沿用同一相对布局：`<appHome>/data/learning.db`；不接受把 `auth.db` 等其他文件当成业务库传入 |
| 12 | `packages/db/src/index.ts:453-459` | `parseJson`：值不是字符串或 `JSON.parse` 抛错时回退到传入的默认值 | 现状对脏 JSON 宽容；本轮工具在 jsonb 装载前收紧为「解析不过即报错」，这条差异必须在 §4 写明，避免实现者照搬兜底逻辑 |
| 13 | `packages/db/src/index.ts:2831-2883` | `upsertNews` 在事务内逐篇写 `news_articles`，按 `url` 冲突更新正文与 `content_hash` | 新闻表是哈希校验的主对象；`content` 与 `content_hash` 的成对关系在迁移后必须保持一致，否则抽样复算会变红 |

这 13 条共同指向一件事：**现状的 schema、约束、哈希口径全部落在 SQLite 侧的既有代码里**，本轮是把这套已冻结的事实搬到 PG 做可校验副本，而不是重新设计数据模型。SQLite 的类型亲和性允许同一列存不同类型的值，因此映射必须按列声明走，不能按抽样值猜类型 [R4]。

## 4 与现行为的差异（有意收紧/放宽）

| 项 | 现状（SQLite 运行时） | 本轮工具契约 | 影响谁 |
|---|---|---|---|
| 数据源 | 所有业务读写经 `node:sqlite` 打开 `learning.db`（`packages/db/src/index.ts:831-834`） | 运行时**不变**，仍读 SQLite；PG 库只是迁移产物与校验对象，A 轮服务端不连接它 | A 轮服务端、H 轮桌面端；二者都不需要知道 PG 实例存在 |
| Schema 来源 | 首次打开库时按 `SCHEMA` + `MIGRATION_2..7` 现建表（`index.ts:850-931`） | 工具按代码现状一次性生成 PG DDL；不回写 `packages/db`，也不在 PG 侧复刻 `user_version` 迁移链 | 后续若 SQLite 侧再加表，需要同步更新工具的表清单与映射规则（见 §6 第 5 条裁决） |
| JSON 列 | 以 `TEXT` 存储；读取侧 `parseJson` 解析失败时回退默认值（`packages/db/src/index.ts:453-459`） | 映射为 `jsonb`；导入前逐值做 `JSON.parse` 校验，非法值直接报错退出，**不做静默兜底** [R8] | 迁移工具自身；历史脏数据会在导入阶段暴露，而不是带进 PG 后才出事 |
| 时间戳 | `TEXT` 存 `new Date().toISOString()` 的 UTC `Z` 串；未发生时用空串 `''` 占位（如 `finished_at`、`reviewed_at`、`due_at`） | 时间戳列映射为 `timestamptz`；空串 `''` 转 SQL `NULL`；非 ISO 取值按风险 §7 处理 | 校验工具按时刻比对，不按字符串逐字比对 |
| 数值类型 | `INTEGER` / `REAL` 受 SQLite 亲和性约束，列声明与实际值可能不完全一致 | 按列声明映射：`REAL` → `double precision`；`INTEGER` 默认 `bigint`，仅在实测取值范围内才允许收窄 `integer`（规则见 `02-contract.md` §3） | 迁移工具；收窄判断必须有源库 min/max 实测支撑 |
| 空串语义 | `NOT NULL DEFAULT ''` 大量用于可选文本字段 | 文本列保留 `NOT NULL` 与空串默认值；只有时间戳列把空串解释为 NULL | 校验比对时文本空串与 NULL 不等价，需分列口径 |
| 行存格式 | `WITHOUT ROWID` 用于复合主键关联表（如 `question_kps`，`index.ts:174-178`） | PG 无 `WITHOUT ROWID` 概念，忽略该子句；复合主键本身完整保留 | 无行为差异；仅 DDL 翻译时丢弃 SQLite 专有子句 |
| 幂等写入 | 业务 upsert 按业务键冲突更新（如 `news_articles` 按 `url`，`index.ts:2837-2840`） | `migrate.js` 缺省按主键 `ON CONFLICT DO UPDATE` 写冲突列；`--rebuild` 先删后建；重复跑不产生重复行 | 校验脚本可连跑两遍比对行数；不要求人工清库 |
| 外键约束 | SQLite 开启 `foreign_keys = ON`（`index.ts:832`），装载顺序由调用代码保证 | PG 侧显式建 `FOREIGN KEY … ON DELETE CASCADE`；COPY 按父表先于子表的拓扑序执行 | 工具实现者必须先定拓扑序；外键报错要能定位到具体子表 |
| 副本一致性 | 源库运行在 WAL 模式（`index.ts:833`），同目录可能存在 `-wal`、`-shm` 旁车文件 | 迁移前使用一致性副本（停写后复制，或走备份/`VACUUM INTO` 口径）；工具不直接对活库做长事务扫描 | 演练数据取自 `.scratch/run/D/` 副本；避免拷到半写状态的库导致行数偏少 |

> 这些差异全部是「搬运口径」层面的收紧：运行时行为一行没改，变严的只是进入 PG 之前的数据校验。任何把 PG 方言写回 `packages/db` 的做法都超出本轮范围。

## 5 产物清单

> 写权：`tools/migrate-pg/**` 全部归 D（`02-ownership-and-parallel.md` §1）。下列文件为本轮新建；仓库内不存在该目录，不覆盖任何已有文件。

```text
tools/migrate-pg/
  package.json        @yxs/migrate-pg，type=module；独立 pnpm install --ignore-workspace，
                       不进根 workspace、不改根 lockfile；PG 驱动为本目录唯一第三方依赖
  migrate.js          入口一：读取 SQLite 副本 → 生成 PG schema → 批量 COPY 导入；可重复跑、幂等
  verify.js           入口二：逐表行数比对 + 每表抽样 20 行字段比对 + news_articles 哈希复算
  rollback.js         入口三：默认 --dry-run 只打印；--apply 才 DROP 本轮登记创建的表
  README.md           三条命令（migrate / verify / rollback）、环境变量表、退出码表、典型报错说明
  src/schema.js       （内部）解析 db 包源码中的表/列/约束清单，生成 38 张表的目标 DDL
  src/map.js          （内部）类型映射规则：text/jsonb/bigint/double precision/timestamptz/boolean
  src/copy.js         （内部）COPY 装载通道与逐表行数汇报；JSON、时间戳、boolean 转换在此完成
  src/hash.js         （内部）sha256 hex 口径，与 db 包 `index.ts:2855` 的正文哈希保持一致
```

**同时新增（不改动）**：无。除上述目录外不写任何文件；不新增根 `package.json` 依赖，不改 `pnpm-workspace.yaml`。

`src/` 下模块是入口脚本的内部拆分，不对外暴露命令行；入口命令与写权边界以上述三个 `.js` 入口为准。模块拆分与伪代码写在后续 `03-implementation.md`，本文件只钉范围。批量导入采用 `COPY … FROM STDIN` 的 CSV 文本通道，便于在日志里逐表报告装载行数 [R2]。

**三条 README 命令**（`README.md` 必须可直接粘贴执行，工作目录为仓库根）：

```powershell
node tools/migrate-pg/migrate.js --source .scratch/run/D/learning.db
node tools/migrate-pg/verify.js --source .scratch/run/D/learning.db
node tools/migrate-pg/rollback.js --dry-run
```

## 6 并行边界

### 6.1 只读依赖

1. 只读 `packages/db/src/index.ts`：提取 38 张表的列、类型、可空、默认、主键、外键与索引；不 import 运行时实例、不调用其方法。
2. 只读 `pipeline/seed-db.ts` 与 seed 产出的计数摘要，作为表清单与行数基线的旁证。
3. 源数据库只取 `.scratch/run/D/learning.db` 副本；不打开 `%APPDATA%`、`~/.learning-agent`、`<repo>/.learning-agent` 等真实数据目录。

### 6.2 写权唯一（自证 5 条）

1. **写权唯一**：本轮新建/修改的文件全部位于 `tools/migrate-pg/`；`packages/**`、`apps/**`、`services/**`、`docs/**`、根 lockfile 一律只读。交付后除 `tools/migrate-pg/` 外无工作区改动。
2. **端口隔离**：D 使用 PG 宿主端口 `55432`；G 轮使用 `55433`（`02-ownership-and-parallel.md` §3）。两个工具各自读自己的 `PGPORT`，不共用连接池、不连对方库。
3. **容器名与卷隔离**：D 的目标容器名固定 `yxs-pg-d`、数据卷固定 `yxs-pg`；G 轮为 `yxs-pg-g`。本轮不执行 `docker compose down -v`，不删除任何卷；卷名差异在 README 命令示例中写死。
4. **不依赖他轮产物**：D 开工只需要工作区代码 + 一份 SQLite 副本；不等 A 的 `apps/server`、不等 C 的 compose、不等 G 的备份脚本、不等 E 的契约测试。并行期 PG 实例未起时，工具以「连接失败退出码 2」如实报错，不伪造校验结果。
5. **冲突裁决**：与冻结文件冲突时以 `01-frozen-contracts.md` §10.5 为准；若实测发现必须改动共享路径才能完成迁移，按 `02-ownership-and-parallel.md` §1 的约定在本节登记「需要 owner 配合的变更」与精确 diff 建议，由人裁决，不直接改。

### 6.3 运行期资源

| 项 | D 的值 | 对照 |
|---|---|---|
| PG 镜像 | `postgres:16-alpine` | 冻结 §10.5；镜像构建归 C 轮，D 不打包 |
| PG 宿主端口 | `55432` | G：`55433` |
| 容器名 | `yxs-pg-d` | G：`yxs-pg-g` |
| 数据卷 | `yxs-pg` | G 自有卷 |
| 库名 / 用户 | `yxs` / `yxs` | 密码来自环境变量，不写进代码与文档 |
| 临时数据 | `.scratch/run/D/learning.db` 副本 | 不碰 `.scratch/run/G/`、`.scratch/run/A/` |
| 安装方式 | `tools/migrate-pg/` 内 `pnpm install --ignore-workspace` | 不跑根 `pnpm install` |

回滚删除范围严格限定在工具内部登记的 38 张表名集合；不做整库 `DROP DATABASE`，不用 `TRUNCATE` 清扫共享库 [R6]。

### 6.4 与其余轮次的接触面

| 轮次 | 与 D 的接触面 | D 的姿态 |
|---|---|---|
| A（服务端骨架） | 都可能读 `learning.db`；A 的运行时连接仍是 SQLite | D 不改 `packages/db` 方言；A 不连接 D 的 PG 演练库 |
| B（新闻质量） | 只读新闻库做抽检报告 | 互不写库；B 的源库副本与 D 的 `.scratch/run/D/` 分开 |
| C（采集 Docker） | compose、容器编排、PG 镜像由 C 负责 | D 只对接已存在的 PG 实例；不写 `services/deploy/**`，不改 compose 文件 |
| E（契约测试） | 可引用 verify 的退出码与差异输出格式做断言 | E 只读 `02-contract.md` §2、§4、§3.3；不改工具代码 |
| F（压测观测） | 压测目标是服务端 stub 或 A 实例 | F 不连 D 的 PG；指标名不占用 D 实例 |
| G（备份恢复） | 两侧都碰 PostgreSQL，但实例隔离 | G 用 `55433` / `yxs-pg-g` / 自有卷；D 用 `55432` / `yxs-pg-d` / `yxs-pg`；互不 `pg_dump` 对方库 |
| H（Electron mutation） | 桌面端与自动化测试 | 无关；D 不碰 `apps/desktop` 与 mutations 目录 |
| I（小程序 mock） | 纯静态 fixtures | 无关 |

## 7 未知与风险

| # | 风险 | 怎么验证这个风险是否发生 |
|---|---|---|
| 1 | **表数与文档口径不一致**：冻结文件与 A 轮文档写「35 张表」，实测 `packages/db/src/index.ts` 内 `CREATE TABLE` 共 38 次、`CREATE VIEW` 0 次、索引 24 个（其中唯一索引 3 个）。核对分段：基线 `SCHEMA` 22 张，`MIGRATION_2/3/4` 追加 14 张后到 35 张，`MIGRATION_5` 加 `question_bank`、`MIGRATION_6` 加 `kp_canonical_map`、`block_canonical_map`，共 38 张；「35」是截至 `MIGRATION_4` 的旧口径。**结论：以代码为准**，迁移与校验清单按 38 张表生成 | 用 `Select-String -LiteralPath packages\db\src\index.ts -Pattern "CREATE TABLE"` 复跑计数；`verify.js` 启动时先比对两侧表名集合，源库缺表或目标库多表都报退出码 2，并在消息里列出缺失/多余表名 |
| 2 | **JSON 列存在非法值**：历史 `TEXT` 里可能有截断 JSON、空串混入对象列、或非 JSON 标量；`jsonb` 不接受这些值，而 SQLite 读取侧原本靠 `parseJson` 兜底回退 [R8] | 迁移前对每个 `*_json` / `value_json` / `state_json` 列逐值 `JSON.parse`；任一失败即中止该表装载，错误消息带表名、列名、主键与解析原因，退出码 2；不在工具内做静默降级或字符串包裹 |
| 3 | **时间戳时区与空串**：源时间戳是 `toISOString()` 的 UTC `Z` 串；部分列默认 `''` 表示未发生（`finished_at`、`reviewed_at`、`due_at`、`finished_at` in `turns`）。若把空串直接塞进 `timestamptz` 会报错；若把非 ISO 占位串误当时间解析，会产生错误时刻 | 抽样对每个时间戳列跑 ISO 正则 `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$`；空串 → NULL；命中非 ISO 取值的行退出码 2 并定位主键；`verify.js` 按时刻相等比对，不按字符串比对 |
| 4 | **`INTEGER` 该映射 `integer` 还是 `bigint`**：SQLite `INTEGER` 是 64 位亲和，PG `integer` 只有 32 位；直接收窄有溢出风险。冻结 §10.5 给定基线是 `bigint` | 迁移前对每个 `INTEGER` 列在源库查 `min()` / `max()`，写进迁移报告；只有实测取值落在 ±2³¹-1 内且列为小秩/计数列时，才允许在映射表里标注 `integer`，其余一律 `bigint`；取值范围未实测的列不得收窄 |
| 5 | **外键装载顺序**：PG 在约束开启时按子表先导入会违反外键；SQLite 现有数据本身满足参照完整性，但批量 COPY 顺序不对会直接失败 | `migrate.js` 按依赖拓扑排序父表先装载；先跑 `migrate` 建 schema，再分表 COPY；两遍重复执行后 `verify.js` 行数一致即说明顺序与约束成立 |
| 6 | **误写真实数据目录**：工具若直接打开本机用户库，会把演练动作带到真实数据上 | 启动时校验源路径位于 `.scratch/run/D/` 或显式 `--allow-source-outside-scratch` 才放行；命中真实目录路径时退出码 1，消息指明原因；PG 侧也只连工具登记的演练库名 |
| 7 | **SQLite 亲和性导致列内混型**：按列声明映射时，若某 `TEXT` 列历史上存过数字或布尔，PG `text` 列可容纳，但比对口径需明确按字符串归一化 [R4] | 抽样行比对前对 `text` 列做显式字符串化；发现源值类型与列声明不符时记入校验报告，不静默转换 |
| 8 | **活库副本不一致**：WAL 模式下 `-wal` 可能含未合并提交；直接复制 `.db` 主文件会丢最近写入，导致行数偏少且难以察觉 | 迁移前对副本跑 `PRAGMA quick_check` 与 `integrity_check`；优先用备份 API 或 `VACUUM INTO` 口径取一致性快照；`verify` 行数与 seed 摘要交叉核对，偏少即判不一致 |
| 9 | **长正文与 COPY 转义**：`content`、`excerpt`、`rationale` 等文本含换行、引号、反斜杠；CSV 通道转义写错会串行或截断 | 装载走标准 CSV 转义（引号包裹、双引号转义）；抽样比对显式覆盖含换行与引号的长正文行；`verify` 字段级比对能截出截断行 |
| 10 | **PG 编码与中文比对**：源库与目标库都应是 UTF-8；若目标库建成其他编码，中文标题/正文可能乱码或比对失败 | 建 schema 前检查目标库 `server_encoding` 为 `UTF8`；抽样比对中文标题与正文；哈希复算基于正文原文，编码不一致会直接表现为 `content_hash` 不符 |

## 参考

- [R1] pgloader — https://github.com/dimitri/pgloader — 支撑 §1 与 §5 的类型映射表、批量装载与统计思路 — 借鉴「SQLite→PG 映射表 + COPY 批量导入 + 行数统计」；不用它跑迁移（本轮要求可审计、可 verify、可 rollback）。
- [R2] PostgreSQL `COPY` — https://www.postgresql.org/docs/current/sql-copy.html — 支撑 §5 产物清单的批量导入通道 — 采用 `COPY … FROM STDIN WITH (FORMAT csv, HEADER true)`；不用 `text` 格式（转义坑多）。
- [R3] SQLite STRICT tables — https://www.sqlite.org/stricttables.html — 支撑 §3 证据 1 与 §4 的约束保留口径 — 采用「`NOT NULL` / `DEFAULT` 必须在目标库保留」；不照搬 STRICT 本身（PG 无此表级概念）。
- [R4] SQLite 数据类型亲和性 — https://www.sqlite.org/datatype3.html — 支撑 §3 末尾与 §7 风险 7 — 用于解释为什么按列声明映射、不按值猜类型。
- [R5] golang-migrate/migrate — https://github.com/golang-migrate/migrate — 支撑 §1 目标 1 的幂等迁移形态 — 借鉴「迁移可重复执行、状态可追踪」；不引入其 Go 运行时与版本表机制。
- [R6] PostgreSQL 事务与 `TRUNCATE` — https://www.postgresql.org/docs/current/sql-truncate.html — 支撑 §2 非目标与 §6.3 回滚清理口径 — 采用「只 DROP 本轮登记的表，禁止 `TRUNCATE` 共享库」。
- [R7] DBDiff/DBDiff — https://github.com/DBDiff/DBDiff — 支撑 §1 目标 2 的跨库比对思路 — 借鉴「schema 与数据双层比对、差异脚本化输出」；不引入其 PHP 栈。
- [R8] PostgreSQL JSON 类型 — https://www.postgresql.org/docs/current/datatype-json.html — 支撑 §4 JSON 差异与 §7 风险 2 — 采用 `jsonb` 与导入前合法性校验；本阶段不建 GIN 索引。
