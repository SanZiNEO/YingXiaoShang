# D · SQLite → PostgreSQL 迁移工具 · 实现方案

> 轮次：D · SQLite → PostgreSQL 迁移与校验工具
> 文档角色：03-implementation
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1 §10.5（PostgreSQL 口径）
> 写权：[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1（`tools/migrate-pg/**` 归 D）
> 一句话：在 `tools/migrate-pg/` 下用四个入口文件 + 一个共享映射配置模块，把 `learning.db` 副本批量搬进 `yxs-pg-d` 的 `yxs` 库，并配出可重复跑的校验与默认 dry-run 的回滚。

**边界声明（两节实现与验收都重复写明）**：A 轮服务端运行时仍然读 SQLite，本工具不切换数据源；不改 `packages/db`，不改 `apps/server`。`packages/db/src/index.ts` 只作为表结构与哈希口径的只读依据，工具内部自行做 SQLite → PostgreSQL 的方言映射，不把任何 PG 方言写回共享包 [R4]。

## 1 目录与模块

目录树与 [`01-scope.md`](01-scope.md) §5 产物清单一致；入口命令只有四个，辅助逻辑收敛到一个共享配置模块。

```text
tools/migrate-pg/
  package.json        # @yxs/migrate-pg，type=module；独立安装，不进根 workspace
  README.md           # 三条命令、环境变量表、退出码表、典型报错说明
  .gitignore          # 包内运行产物：node_modules/、*.dump、*.log
  src/schema-map.js   # 共享映射配置模块：38 张表注册表、列定义、类型映射、拓扑序、登记表名集合、
                      # 源码漂移核对（表/列/类型/可空/默认/主键/外键/唯一/索引）
  src/values.js       # 取值归一唯一实现：jsonb 原文直传、空串→默认 JSON、时间戳空串→NULL、boolean
  src/cli.js          # 参数解析与退出码工具；未知参数退出 1
  src/target.js       # 连接参数读取 + 目标库身份守卫（库 yxs / 端口 55432）
  src/pg-driver.js    # 按需加载 pg；未装依赖时给中文安装提示
  src/migrate.js      # 入口一：只读 SQLite 副本 → 生成 PG schema → 批量 COPY 导入；幂等可重复跑
  src/verify.js       # 入口二：逐表行数比对 + 每表抽样字段比对 + news_articles 哈希复算
  src/rollback.js     # 入口三：默认 --dry-run 只打印；--apply 才逆序 DROP 本轮登记表
```

| 模块 | 职责边界（谁不许干别人的活） |
|---|---|
| `src/schema-map.js` | 唯一保存「表名 → 列定义 → 源类型/目标类型/可空/默认/主键/外键/索引」的真相源；导出表清单、依赖边、主键列、JSON 列集合、时间戳列集合、布尔列集合，以及源码漂移核对。三个入口都从这里取表与列，禁止各自硬编码第二份清单 [R1] |
| `src/values.js` | 唯一保存「源库取值 → 送 COPY 的文本」与「两侧取值是否相等」的判据。migrate 与 verify 必须调用同一组函数：两侧口径一旦分叉，同一份合法数据会出现「migrate 成功、verify 以环境错误退出」的矛盾结论 |
| `src/migrate.js` | 参数与源路径校验 → 目标库身份守卫 → 打开 SQLite 副本 → 版本与缺表核对 → 连接 PG → 生成 DDL → 按拓扑序装载 → 输出逐表行数。不负责校验已迁入数据的一致性（归 `verify.js`） |
| `src/verify.js` | 只做双侧只读查询与比对：行数 100% → 抽样字段 → 正文哈希复算。不写 PG、不写 SQLite；差异只输出第一处 |
| `src/rollback.js` | 只面向 `schema-map.js` 登记的 38 张表；dry-run 打印逆序清单，`--apply` 在单事务内 DROP。不触碰登记集合之外的表，不 `DROP DATABASE`，不 `TRUNCATE` 任何共享库 [R5] |
| `src/target.js` | 连接参数读取顺序与目标库身份判据（库 `yxs` / 端口 `55432`）。写操作（缺省 upsert、`migrate --rebuild`、`rollback --apply`）在目标不匹配时默认拒绝，须显式 `--force-target` |
| `package.json` | 只声明本工具自己的依赖与脚本；不引用 `workspace:*`，不改根 `pnpm-workspace.yaml` |

**为什么映射表集中在 `schema-map.js`**：三个入口都要同一份列定义（migrate 生成 DDL、verify 按列配对、rollback 按表名逆序）。清单散落在三个脚本里，改一张表就要改三处，校验口径会漂移；集中到一处后，表结构真相只有一个出口 [R7]。

## 2 依赖与构建

### 2.1 运行时与安装方式

运行环境：本地 Node 22（仓库 `package.json` 的 `engines` 为 `^22.19.0 || >=24.0.0`，本机实测 `v22.23.2`），包管理器 pnpm `11.28.5`。

```json
{
  "name": "@yxs/migrate-pg",
  "type": "module",
  "private": true,
  "dependencies": {
    "pg": "^8"
  },
  "scripts": {
    "migrate": "node src/migrate.js",
    "verify": "node src/verify.js",
    "rollback": "node src/rollback.js"
  }
}
```

- PG 客户端只引 `pg`（Node 生态事实标准的 PostgreSQL 纯 JS 客户端），不引 ORM、不引迁移框架；类型映射与 DDL 由本工具自己生成，便于逐表审计 [R8]。
- SQLite 侧用 Node 内置 `node:sqlite`（`packages/db/src/index.ts:2` 已经是同一内置模块），不额外安装原生 SQLite 库。
- 安装命令在工具目录内独立执行：

```powershell
# 工作目录：tools/migrate-pg
pnpm install --ignore-workspace
```

`--ignore-workspace` 的依据：`pnpm-workspace.yaml:1-4` 只包含 `packages/*`、`profiles/*`、`apps/*` 三条 glob，`tools/*` 本就不在 workspace 内；加这个标志是显式声明「本工具独立装自己的 `node_modules` 与 lockfile」，不跑根 `pnpm install`，不向根 `package.json` 与根 lockfile 新增任何依赖 [R7]。

### 2.2 构建与产物形态

- 纯 JavaScript（ESM），无编译步骤：在包内执行 `node src/migrate.js` 直接跑，不经过 tsc/打包；在仓库根执行 `node tools/migrate-pg/src/migrate.js`。
- 不生成 Docker 镜像，不写 Dockerfile；PG 实例由他人负责拉起，工具只通过连接串对接已经存在的实例（容器名 `yxs-pg-d`、卷 `yxs-pg`、宿主端口 `55432` 是对接事实，不是本工具拉起的资源）。
- 依赖版本：`pg` 的精确次版本以独立 `pnpm install` 落地后的本地 lockfile 为准；不在文档里手写未经安装核实的版本号。

### 2.3 与运行时包的隔离

工具**只读** `packages/db/src/index.ts` 作为表结构依据，不 import `@learning-agent/db` 的运行时实例，不调用其方法；不读 `apps/server` 任何文件。运行时连接 SQLite 的代码（`packages/db/src/index.ts:831-834` 的 `DatabaseSync` + `PRAGMA foreign_keys = ON` / `journal_mode = WAL` / `busy_timeout = 5000`）保持原样，本工具不改一行 [R4]。

## 3 关键实现

### 3.1 表定义来源：显式映射表 + 启动期解析核对（二选一后的决策）

两个候选方案：

| 方案 | 做法 | 优点 | 风险 |
|---|---|---|---|
| A. 解析 `packages/db/src/index.ts` 的 `CREATE TABLE` | 启动时正则/轻量解析 `SCHEMA` 与 `MIGRATION_2..7` 段，抽取列、类型、约束 | 表结构永远跟代码同步，不用手工维护清单 | SQLite DDL 含 `STRICT`、`WITHOUT ROWID`、复合主键、`ALTER TABLE ADD COLUMN` 增量列、表内 `UNIQUE`、外键 `ON DELETE CASCADE`；自写解析器要覆盖全部方言细节，脆弱且难审计；增量列散在多个迁移段，解析顺序容易漏列 |
| B. 维护显式映射表（选定） | `schema-map.js` 手工登记 38 张表的列定义与映射；另写一段解析核对逻辑，从 `index.ts` 抽取 `CREATE TABLE` 名集合与列名集合，与注册表双向 diff | 映射规则可读、可评审、可逐列审计；JSON 列/时间戳列/布尔列这类特例可以显式标注；核对兜底防漂移 | 代码加表/加列后需要同步更新注册表；靠启动期核对把「忘了同步」变成退出码 2，而不是静默漏表 |

**决策：方案 B 为主，方案 A 只做漂移核对。** 依据：本轮要求 schema 映射可审计、可 verify、可 rollback（`01-scope.md` §1），显式表比自写 SQL 解析器更符合这个目标；解析器在公开同类项目里也多作为结构校验辅助，而不是唯一真相源 [R1]。

伪代码（`src/schema-map.js` 导出 + 核对函数）：

```js
// 每张表登记：表名、主键列、列数组、外键数组、唯一约束/索引
export const TABLES = [
  {
    name: 'chapters',
    pk: ['id'],
    columns: [
      { name: 'id',          src: 'TEXT',    pg: 'text',   nullable: false, default: null },
      { name: 'number',      src: 'INTEGER', pg: 'bigint', nullable: false, default: null },
      { name: 'title',       src: 'TEXT',    pg: 'text',   nullable: false, default: null },
      { name: 'source_path', src: 'TEXT',    pg: 'text',   nullable: false, default: null },
    ],
    fks: [],
    uniques: [],
    indexes: [],
  },
  // …其余 37 张表，清单与 02-contract.md §3.2 逐表对齐
]

// 漂移核对：从 index.ts 抽取表、列（类型/可空/默认/主键/外键）、表级 UNIQUE、
// CREATE [UNIQUE] INDEX，与注册表逐属性比对。只比名字会让「INTEGER 改 REAL」
// 「默认值被改」「唯一索引被删」全部漏过，因此必须落到列属性级。
export function diffAgainstSource(srcText) {
  const { tables: parsed, indexes: parsedIndexes } = parseSourceIndex(srcText)
  return {
    missingTables, extraTables,          // 表名集合
    missingColumns, extraColumns,        // 列名集合
    typeDrift, nullableDrift, defaultDrift,   // 列属性
    pkDrift, foreignKeyDrift, uniqueDrift,    // 键与约束
    indexDrift,                          // 索引名/列/唯一性
  }
}
```

核对结果任一非空（`isDriftFree()` 为假）：`migrate.js` 退出码 2，中文消息逐项列出差异，不进入装载；`node tools/migrate-pg/src/schema-map.js --check` 以退出码 1 打印同一份清单。表总数基线：`Select-String -LiteralPath packages\db\src\index.ts -Pattern "CREATE TABLE"` 实测 38 条（2026-11-19，文件 3746 行，按含空行的整文件行数计；PowerShell `Measure-Object -Line` 不计空行会给出 3514，两种口径不要混用）。

### 3.2 DDL 生成

按 `schema-map.js` 注册表逐表生成 PG DDL，顺序：表列 → 主键 → 外键 → 唯一约束/索引。

```text
对每张表 t（拓扑序内）：
  CREATE TABLE IF NOT EXISTS <t.name> (
    <col.name> <pg type> [NOT NULL] [DEFAULT <literal>],
    PRIMARY KEY (<pk cols>),
    [FOREIGN KEY … REFERENCES <ref>(id) ON DELETE CASCADE],
    [UNIQUE (cols)]
  );
  对每个非唯一索引：CREATE INDEX IF NOT EXISTS <idx> ON <t.name>(<cols>);
```

翻译规则：

- `STRICT` 表级子句丢弃（PG 无对应概念）；`NOT NULL` 与 `DEFAULT` 逐列保留 [R9]。
- `WITHOUT ROWID` 丢弃（PG 无此存储子句）；复合主键按源列顺序写成 `PRIMARY KEY (col_a, col_b)`。
- 类型映射按 [`02-contract.md`](02-contract.md) §3.1：`TEXT→text`、`INTEGER→bigint`（实测收窄条件见 §3.4）、`REAL→double precision`、JSON 列→`jsonb`、`enabled` 这类 0/1 标志列→`boolean`、`_at` 时间戳列→`timestamptz`。
- `DEFAULT '[]'` / `'{}'` 在 jsonb 列写成 `DEFAULT '[]'::jsonb` / `'{}'::jsonb`。
- 不在 PG 侧新增源库没有的约束、索引、视图、触发器；不建 JSON 内部结构的 GIN 索引 [R3]。

### 3.3 批量写入：`COPY` 与参数化 INSERT 的取舍

| 通道 | 吞吐 | 转义/类型风险 | 适用 |
|---|---|---|---|
| `COPY … FROM STDIN WITH (FORMAT csv, HEADER true)` | 高，面向批量装载设计，pgloader 等同类工具的主通道也是批量装载 [R1] | CSV 需正确处理引号、换行、逗号、空值；jsonb/timestamptz 在进 COPY 前完成转换与校验 | 本轮默认通道 |
| 参数化 `INSERT … VALUES ($1,…)` 分批 | 低，逐行协议往返多 | 类型由客户端参数绑定，转义风险小 | 仅作为单表极小行数（如空表校验）或排障对照，不作为主通道 |

**决策：主通道 `COPY` CSV，分批大小常量 `COPY_BATCH_ROWS = 5000`**（每批一个 `COPY` 流；表内行数不足一批则单批完成）。批次大小首轮在 `.scratch/run/D/` 副本上标定后写回本节；不在文档里手写未经实测的最优值。

事务边界：

- schema 建表：全部 DDL 在**一个事务**内提交；失败整体回滚，不留下半套表。
- 数据装载：**每张表一个事务**，按父表先于子表的拓扑序逐表 `COPY`；某张表转换或装载失败，中止该表并退出 2，已成功装载的表保留（源库本就只读，不存在回写源库的问题）。
- 外键约束在装载期间保持开启；顺序靠拓扑序保证，不靠临时关约束 [R2]。

### 3.4 值转换与合法性校验

进入 COPY 之前，逐行逐列完成转换，任何一行不合法就定位到表/列/主键后退出 2：

1. **jsonb 列**：列名后缀 `_json` 或合同点名的 `value_json`/`state_json`/`plan_json`/`record_json`/`payload_json`/`content_json`/`profile_json`/`metadata_json`/`input_schema_json`。每个取值先 `JSON.parse`：
   - 对象/数组/可解析标量都接受（`memory_facts.value_json` 允许任意 JSON）；
   - 解析失败：消息带表名、列名、主键与 `JSON.parse` 异常文本，不打印整行数据；
   - 空串按该列默认 JSON 归一（`'[]'` 或 `'{}'`），不把裸空串塞进 jsonb [R3]。
2. **timestamptz 列**：列名匹配 `_at`。取值按 ISO-8601 UTC 解析（正则 `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$`）；空串 `''` → SQL `NULL`；非 ISO 取值退出 2 并定位主键。源列 `NOT NULL DEFAULT ''` 时目标列允许 NULL——空串是占位，不是真实时刻。
3. **boolean 列**：仅 `skills.enabled`；`1→true`、`0→false`，其他取值退出 2。此规则不推广到其他 INTEGER 列。
4. **INTEGER 列**：默认 `bigint`。迁移前在源库对每列查 `min()`/`max()`；只有实测落在 ±2³¹-1 内且属于小秩/计数/序号列，才在映射表标注 `integer`；未实测一律 `bigint`，避免 32 位溢出 [R4]。
5. **REAL 列**：原样装载；比对时两侧相对误差 ≤ `1e-9` 视为相等。
6. **文本列**：保留空串，不转 NULL；UTF-8 解码出现替换字符 `U+FFFD` 时按编码问题处理（见 §6）。

### 3.5 抽样 20 条的确定性规则

`verify.js` 抽样不靠随机数，保证同一副本两次校验集合一致、结果可复现：

```text
每表：
  1. 源库与 PG 各自按主键列升序排序（单列主键 ORDER BY <pk>；复合主键 ORDER BY 全部主键列）
  2. 取前 --sample 行（默认 20；表内行数 ≤ 抽样数时全表比对）
  3. 双侧按主键值集合配对：源有目标无、目标有源无都记差异
  4. 配对成功的行按注册表列顺序逐列比较
```

确定性来源：主键升序 + 固定抽样数，不依赖 `Math.random`、不依赖物理存储顺序；同一快照重跑结果相同 [R7]。

### 3.6 第一处差异的定位算法

```text
差异扫描顺序（注册表表序）：
  for table in TABLES:
    行数：src count 与 pg count 不等 → 记第一处行数差，继续完成其余表行数汇总
    抽样：
      a. 主键集合差集（目标缺行 / 源缺行）→ 记第一处
      b. 配对行按列顺序遍历，第一列不等 → 记第一处字段差
    news_articles 抽样行额外：复算 sha256(content).hex，与 content_hash 比对
第一处差异立即生成单行报告（取值截断到 200 字符）：
  [verify] DIFF table=<表名> pk=<主键列>=<主键值> column=<列名> source=<源值> target=<目标值>
  [verify] HASH article=<文章 id> source=<源 content_hash> recomputed=<复算哈希>
```

- 行数汇总不中断（跑完所有表 count）；抽样比对在该表第一处差异后停止该表扫描。
- 哈希口径只对正文 `content` 取 sha256 hex，不含标题、摘要、来源，与 `packages/db/src/index.ts:2855`（写入时哈希）和 `:2889`（复算哈希）一致。
- 数值列严格相等；`double precision` 走相对误差；jsonb 两侧解析后归一化比较（对象键序不敏感、数组顺序敏感）；timestamptz 按 UTC 时刻比较，不比较显示字符串；boolean 真值严格相等。

## 4 数据读写

### 4.1 读写方向与隔离

| 方向 | 对象 | 说明 |
|---|---|---|
| 只读 | SQLite 源库副本 `.scratch/run/D/learning.db` | 以只读模式打开；不写回源库，不创建 `-wal`/`-shm` 残留到副本之外的位置 |
| 只写 | PG 库 `yxs`（实例 `yxs-pg-d`，宿主端口 `55432`） | 写入对象仅限本轮登记表；不碰 `auth.db`（A 轮服务端自有库，冻结 §3.4，不在 D 范围） |
| 不读不写 | `packages/db` 运行时连接、`apps/server`、真实数据目录（`%APPDATA%`、`~/.learning-agent`、`<repo>/.learning-agent`） | 源路径命中受保护真实目录时退出码 1（§6） |

源库版本硬校验：只读打开后读 `PRAGMA user_version`，必须为 7（`packages/db/src/index.ts:850-851` 读取版本、`:931` 收尾置 7）；低于 7 说明本地迁移链未跑齐，工具不猜测补列，退出码 2。

### 4.2 幂等的三种做法取舍

| 做法 | 机制 | 优点 | 缺点 | 本轮定位 |
|---|---|---|---|---|
| `CREATE TABLE IF NOT EXISTS` | 建表语句带守卫，表已存在则跳过 | 防「重复建表」报错 | 只护 schema，不清重复行；表已存在且结构旧版本时不修正 | schema 层守卫，DDL 生成时使用 |
| 单表 `TRUNCATE` 重灌 | 导入前清空每张本轮登记表再 COPY | 目标与源严格一致，源里删掉的行也能在目标消失 | 破坏性强；误作用到共享库风险高；中途失败留下半空表 | 不作为缺省模式；`--rebuild` 采用更保守的「DROP 本轮登记表后重建」，不使用 `TRUNCATE` [R5] |
| `ON CONFLICT DO UPDATE` | 按主键冲突时更新冲突列 | 可重复跑、不产生重复行；已存在行被刷新；不需要清表 | 源里已删除的行不会自动从目标消失；复合主键表要写全冲突键 | **缺省模式**：缺省重跑走主键 `ON CONFLICT DO UPDATE` [R6] |

- 缺省：表不存在则建；已存在则按主键 upsert，重复执行不产生重复行。
- `--rebuild`：先 DROP 本轮登记的表，再走完整建表与装载；DROP 范围仍限登记表。
- 重复跑两遍后由 `verify.js` 判定行数与抽样一致（AC-D-03）。

### 4.3 失败回滚边界

- 建表事务失败：整体回滚，PG 侧不留半套表。
- 装载某表失败：该表事务回滚；先前已装载表保留，不自动级联清空——需要干净重灌时用 `--rebuild`。
- `rollback.js --apply`：单事务内按依赖逆序 `DROP TABLE`；任一表失败整体回滚事务，退出码 2，不留下半删状态 [R5]。
- 源库全程只读，不存在「回滚 SQLite」的需求。

## 5 配置

配置从环境变量与命令行参数读取，启动期一次解析冻结；运行期不再读 `process.env`。环境变量名与冻结 §10.2 一致；连接参数外置到环境而不是写进代码，与可重复执行迁移工具的配置惯例一致 [R7]。

### 5.1 环境变量

| 变量 | 默认值 | 作用 | 谁设 |
|---|---|---|---|
| `PGHOST` | `127.0.0.1` | PG 主机 | 演练者 |
| `PGPORT` | `55432` | D 轮专用端口；G 轮为 `55433`，不得串用 | 演练者 |
| `PGDATABASE` | `yxs` | 库名 | 演练者 |
| `PGUSER` | `yxs` | 用户名 | 演练者 |
| `PGPASSWORD` | （无默认） | 密码；不写进命令行参数、代码与文档 | 演练者 |

连接参数读取顺序：命令行 `--pg-url` > 环境变量 > 上表默认值。日志与错误消息里出现的连接串必须把密码替换为 `***`。

### 5.2 命令行参数表

| 参数 | 适用入口 | 必填 | 边界/取值 | 默认 | 说明 |
|---|---|---|---|---|---|
| `--source <path>` | migrate / verify | 是 | 存在的 SQLite 文件；路径须在 `.scratch/run/D/` 下（或显式放行标志） | — | 源库路径；`--sqlite` 作为同一参数的别名识别 |
| `--sqlite <path>` | migrate / verify | 否 | 同 `--source` | — | 别名，避免两套参数解析分叉 |
| `--pg-url <url>` | 三个入口 | 否 | 合法 PG 连接串 | 走环境变量 | 覆盖环境变量 |
| `--dry-run` | migrate / rollback | 否 | 开关 | migrate 关；rollback **开** | migrate：只打印 DDL 计划与预计行数，不建表不装载；rollback：只打印待删清单 |
| `--sample <n>` | verify | 否 | 整数 1..1000 | `20` | 每表抽样行数；越界退出码 1 |
| `--rebuild` | migrate | 否 | 开关 | 关 | 导入前 DROP 本轮登记表后重建 |
| `--apply` | rollback | 否 | 开关 | 关 | 显式确认才执行 DROP；与 `--dry-run` 同给退出码 1 |

`README.md` 给出三条可直接粘贴的命令（见 `04-acceptance.md` AC-D-12）。

## 6 失败处理

失败路径统一原则：用户可见消息是中文一句话，带表名/列名/主键等定位信息；英文堆栈与 SQL 原文只进工具自身日志行，不抛给调用方 [R6]。退出码口径与 [`02-contract.md`](02-contract.md) §2.5 一致：0 成功/一致/dry-run 完成；1 用法或参数错误；2 环境、连接、SQL 或数据合法性错误；3 仅 verify 校验不一致。

| 失败场景 | 退出码 | 中文消息（要点） | 是否重试 |
|---|---|---|---|
| 连不上 PG（主机/端口/账号/密码错、实例未起） | 2 | `无法连接 PostgreSQL：<原因>。请检查 PGHOST、PGPORT、PGUSER、PGPASSWORD。` | 否；排障后手动重跑 |
| 源库缺必填参数 / 文件不存在 | 1 | `缺少必填参数 --source：SQLite 源库路径。` / `找不到源数据库文件：<path>。` | 否 |
| `--sample` 越界 | 1 | `--sample 必须是 1 到 1000 的整数。` | 否 |
| 源路径命中受保护真实目录 | 1 | `源路径位于受保护的真实数据目录，请改用 .scratch/run/D/ 下的副本：<path>。` | 否 |
| `--apply` 与 `--dry-run` 同给（rollback） | 1 | `--apply 与 --dry-run 不能同时使用。` | 否 |
| 源库 schema 版本非 7 | 2 | `源库 schema 版本为 <v>，预期 7；请先在桌面端或 seed 流程跑齐本地迁移。` | 否 |
| 源库缺表 / 目标表名集合不一致 | 2 | `源数据库缺少表 <table>。`（多余表名一并列出） | 否 |
| 表已存在且非 rebuild 路径 | 不报错 | 走 `ON CONFLICT DO UPDATE` 缺省幂等路径；结构需要重建时显式 `--rebuild` | — |
| jsonb 列非法值 | 2 | `表 <table> 的列 <column> 不是合法 JSON（主键 <pk>）：<解析原因>。` | 否；修数据后重跑 |
| 时间戳列非 ISO 取值 | 2 | `时间戳列 <table>.<column> 存在非 ISO 取值（主键 <pk>）：<value>。` | 否 |
| `enabled` 非 0/1 | 2 | `表 skills 的列 enabled 只接受 0 或 1（主键 <pk>）：<value>。` | 否 |
| 类型不兼容值（如 INTEGER 列混入无法转换的文本） | 2 | `装载表 <table> 失败：<SQL 原因>。`，消息带列名与主键 | 否 |
| 装载 SQL 失败（外键顺序、约束冲突等） | 2 | `装载表 <table> 失败：<SQL 原因>。` | 否；检查拓扑序与参照完整性后重跑 |
| 编码问题（UTF-8 解码替换字符、非法字节序列） | 2 | `表 <table> 的列 <column> 存在无法按 UTF-8 解码的内容（主键 <pk>）。` | 否；先在源库侧核对编码 |
| 回滚事务失败 | 2 | `回滚事务失败，未删除任何表：<SQL 原因>。` | 否；事务已整体回滚 |
| 行数不等 / 抽样字段不等 / 哈希不符 | 3（仅 verify） | 行数、抽样、哈希三类消息见 [`02-contract.md`](02-contract.md) §4 | 否 |

连接失败不伪造校验结果：PG 不可达时 migrate/verify/rollback 都如实退出 2，不输出「通过」结论。

## 7 性能与资源

性能口径：本轮是一次性快照迁移，不设在线服务的 QPS 指标；关注点是装载吞吐、批次内存与可复现的测量方法。批量通道沿用 `COPY` 的流式装载语义，行数据按批次进通道，不要求全表驻留内存 [R2]。

| 指标 | 目标 / 口径 | 怎么量 |
|---|---|---|
| 10 万行装载耗时 | 首轮在 `.scratch/run/D/` 副本上实测标定，按「总行数 / 总耗时」记录行每秒；不预设未经实测的秒数区间 | PowerShell `Measure-Command` 包整条 `migrate.js`；阶段行记录每张表的开始/结束时间与行数；结果落 `.scratch/run/D/evidence/perf.txt` |
| 单批内存 | 行数据按 `COPY_BATCH_ROWS = 5000` 分批缓冲，不全表读进内存；jsonb 解析在批次内逐行进行 | 任务管理器或 `process.memoryUsage().rss` 在 migrate 结束时打印；对比批大小调整前后的 RSS |
| 源库读取 | 只读查询，不建索引、不写源库 | 跑完检查副本目录无新增 `-wal`/`-shm` 残留到源位置 |
| PG 侧资源 | 不建 GIN 索引、不建额外业务索引；约束与索引按源库 1:1 迁移 | `verify.js` 表名/索引集合核对；`\d` 抽查列入 AC-D-08 |

测量注意：本机 PG 跑在容器映射端口上，磁盘缓存会影响第二次耗时；报告里同时记录首跑与第二遍跑的耗时，区分冷缓存与热缓存。10 万行量级的具体耗时区间以首轮实测写回本节为准，不在文档里编造数字。

## 8 实施顺序（每步都能验证）

按「先骨架可跑、再 schema、再装载、再校验、最后回滚与文档」排，每步有独立验证点；每步完成后 `git status --porcelain packages apps` 必须为空 [R7]。

1. **工具骨架与独立安装**：建 `tools/migrate-pg/`，写 `package.json`；目录内 `pnpm install --ignore-workspace`；确认根 lockfile 与根 `package.json` 无改动。验证：`pnpm --dir tools/migrate-pg exec node -e "console.log(require('pg').name)"` 能解析到本地 `node_modules`；根 `git status` 干净。
2. **注册表与漂移核对**：在 `schema-map.js` 登记 38 张表的列、主键、外键、索引；接 §3.1 的解析核对函数。验证：核对函数对当前 `index.ts` 输出 `missing/extra/columnDrift` 全空；人为改注册表一张表名能让核对非空。
3. **参数解析与源库校验**：实现 `--source/--sqlite/--pg-url/--dry-run/--sample/--rebuild/--apply` 解析、受保护目录拦截、`user_version=7` 校验。验证：缺 `--source` 退出 1；版本不符的副本退出 2；消息逐字匹配 §6 表。
4. **DDL 生成与 dry-run**：连 PG，按拓扑序生成建表 DDL；`--dry-run` 只打印计划与预计行数，不写库。验证：dry-run 后 PG 内无新表；正常跑可在空库建出 38 张表，`information_schema` 抽查 `NOT NULL` 与 `jsonb` 列。
5. **类型转换与 COPY 装载**：实现 jsonb/timestamptz/boolean/数值转换与校验；按拓扑序分批 COPY。验证：种子副本一次装载成功；逐表行数阶段行输出；非法 JSON 注入行被退出 2 拦截并定位主键。
6. **verify 比对**：行数全量 → 抽样确定性配对 → 字段比较 → `news_articles` 哈希复算。验证：未改动副本退出 0；篡改一条正文退出 3 并打印第一处 DIFF；只改 `content_hash` 打印 HASH 行。
7. **rollback**：dry-run 打印 38 表逆序清单且库不变；`--apply` 单事务逆序 DROP。验证：不带参数跑表仍在；`--apply` 后登记表清空，登记表之外的表不受影响。
8. **README 与两遍幂等证据**：写 README 三条命令、环境变量表、退出码表；同一源库连跑两遍 migrate + 一遍 verify，证据落 `.scratch/run/D/evidence/`；跑 `check-docs.py --round D` 自检。验证：第二遍后行数不变、无重复行；README 命令可直接粘贴执行。

## 参考

- [R1] pgloader — https://github.com/dimitri/pgloader — 支撑 §1 注册表集中与 §3.3 批量装载通道 — 借鉴「类型映射表 + 批量 COPY + 行数统计」；不用它跑迁移（本轮要求可审计、可 verify、可 rollback）。
- [R2] PostgreSQL `COPY` — https://www.postgresql.org/docs/current/sql-copy.html — 支撑 §3.3 批量装载格式 — 采用 `COPY … FROM STDIN WITH (FORMAT csv, HEADER true)`；不用 `text` 格式（转义坑多）。
- [R3] PostgreSQL JSON 类型 — https://www.postgresql.org/docs/current/datatype-json.html — 支撑 §3.2 jsonb 列与 §3.4 合法性校验 — 采用 `jsonb`；本阶段不建 GIN 索引。
- [R4] SQLite 数据类型亲和性 — https://www.sqlite.org/datatype3.html — 支撑 §2.3 运行时隔离与 §3.4 按列声明映射 — 按列声明走类型，不按抽样值猜类型。
- [R5] PostgreSQL 事务与 `TRUNCATE` — https://www.postgresql.org/docs/current/sql-truncate.html — 支撑 §1/§4.3 回滚清理口径 — 只 DROP 本轮登记表，禁止 `TRUNCATE` 共享库。
- [R6] PostgreSQL `INSERT … ON CONFLICT` — https://www.postgresql.org/docs/current/sql-insert.html — 支撑 §4.2 缺省幂等写入 — 采用主键冲突更新；SQLite 侧仍用现有实现。
- [R7] golang-migrate/migrate — https://github.com/golang-migrate/migrate — 支撑 §1 集中配置、§3.5 可复跑形态与 §8 实施顺序 — 借鉴「迁移可重复执行、状态可追踪」；不引入其 Go 运行时与版本表机制。
- [R8] sequelize — https://github.com/sequelize/sequelize — 支撑 §2.1 Node 侧 PG/jsonb 生态旁证 — 仅对照类型支持面；不引入 ORM。
- [R9] SQLite STRICT tables — https://www.sqlite.org/stricttables.html — 支撑 §3.2 约束保留规则 — 采用「`NOT NULL` / `DEFAULT` 逐列保留」；不照搬 STRICT 表级语法。
- [R10] go-pg/pg — https://github.com/go-pg/pg — 支撑 §3.3 客户端连接与批量语义对照 — 对照 PG 客户端批量通道形态；不引入其 Go 栈。
