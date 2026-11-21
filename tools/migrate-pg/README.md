# @yxs/migrate-pg — SQLite → PostgreSQL 迁移 / 校验 / 回滚工具

本目录是 D 轮交付的独立命令行工具：把 `.scratch/run/D/learning.db` 副本按冻结契约映射进本机演练 PostgreSQL 库，提供可重复跑的迁移、可审计的一致性校验、默认只打印的回滚。

- 源库以只读方式打开，不写回源库，不在副本目录留下 `-wal` / `-shm` 残留。
- 运行时业务数据源仍然是 SQLite；本工具不切换运行时方言，不被服务端运行时引用。
- 表结构、类型映射、约束与哈希口径以 `plans/server-client-split/D-pg-migration/02-contract.md` §3.2 为准。

## 前置环境

- Node 22（本机实测 `v22.23.2`）、pnpm 11；Windows 下用 PowerShell 7 执行下列命令。
- 一个已存在的 PostgreSQL 演练实例（连接参数见下文「连接配置」）；本工具不负责拉起实例。

## 安装

在仓库根目录执行（独立目录安装，不进根 workspace）：

```powershell
pnpm --dir tools\migrate-pg install --ignore-workspace
```

- 不跑仓库根 `pnpm install`，不向根 `package.json` 与根 `pnpm-lock.yaml` 新增依赖。
- 唯一第三方依赖是 PG 客户端 `pg`；其精确版本以本目录 `pnpm-lock.yaml` 为准。

## 三条常用命令

> 工作目录一律为仓库根，三条命令可直接粘贴执行。路径全部相对仓库根，不含机器相关的绝对路径。

```powershell
node tools/migrate-pg/src/migrate.js --source .scratch/run/D/learning.db
node tools/migrate-pg/src/verify.js --source .scratch/run/D/learning.db
node tools/migrate-pg/src/rollback.js --dry-run
```

也可以用包内 npm script（在 `tools/migrate-pg/` 下执行）：

```powershell
pnpm --dir tools\migrate-pg run migrate -- --source ..\..\.scratch\run\D\learning.db
pnpm --dir tools\migrate-pg run check-schema
```

| 入口 | 作用 | 成功收尾 |
|---|---|---|
| `src/migrate.js` | 只读 SQLite 副本 → 生成 PG schema → 批量导入；缺省按主键冲突更新，可重复跑 | `[migrate] done: 38 tables, <N> rows` |
| `src/verify.js` | 38 表行数 100% 比对 + 每表抽样字段比对 + `news_articles` 正文哈希复算 | `[verify] ok: 38 tables, rows match, sample and hash check passed` |
| `src/rollback.js` | 默认 dry-run 只打印待删清单；显式 `--apply` 才在单事务内逆序 DROP 本轮登记表 | `[rollback] dry-run（未删除任何数据）` |
| `src/schema-map.js --check` | 注册表与 `packages/db/src/index.ts` 逐属性漂移核对，不连库 | `[schema] ok: 38 tables, 324 columns, 27 indexes` |

## 连接配置

连接参数读取顺序：命令行 `--pg-url` > 环境变量 > 下表默认值。

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PGHOST` | `127.0.0.1` | PG 主机 |
| `PGPORT` | `55432` | D 轮演练端口 |
| `PGDATABASE` | `yxs` | 库名 |
| `PGUSER` | `yxs` | 用户名 |
| `PGPASSWORD` | （无默认，必须由环境提供） | 密码不写进命令行参数、代码与文档；日志中的连接串密码替换为 `***` |

`--pg-url` 形如 `postgres://yxs:<password>@127.0.0.1:55432/yxs`，给出后覆盖上述全部环境变量。

### 目标库身份守卫

写操作（缺省 upsert、`migrate --rebuild`、`rollback --apply`）会覆盖或删除目标库里的同名表。为防误连真实业务库，工具在执行前核对目标身份：库名必须是 `yxs`、宿主端口必须是 `55432`（契约 §10.2 冻结值）。不匹配时默认拒绝，退出码 1，不建立连接、不执行任何 SQL；确认目标无误后加 `--force-target` 显式放行。`--pg-url` 省略端口/库名时按 libpq 语义补（端口 `5432`、库名等于用户名），不会被误判成演练目标。

只读操作（`migrate --dry-run`、verify、rollback dry-run）只打印一行 `[guard]` 警告，不阻断。

判据可用环境变量钉到自己的实例（例如别的机器上换端口），无需改代码：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `YXS_PG_EXPECT_DATABASE` | `yxs` | 演练目标库名 |
| `YXS_PG_EXPECT_PORT` | `55432` | 演练目标宿主端口 |

连库之后还会用 `current_database()` 复核一次真实库名（配置可能被 `PGSERVICE` / `PGOPTIONS` 改写）；端口只在客户端侧比对，因为 docker 端口映射会让服务端报出容器内端口。

## 命令行参数

| 参数 | 适用入口 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `--source <path>` | migrate / verify | 是 | — | 存在的 SQLite 文件路径；源路径须位于 `.scratch/run/D/` 下 |
| `--sqlite <path>` | migrate / verify | 否 | — | `--source` 的别名，两套参数等价 |
| `--pg-url <url>` | 三个入口 | 否 | 走环境变量 | 合法 PG 连接串，覆盖环境变量 |
| `--dry-run` | migrate / rollback | 否 | migrate 关；rollback **开** | migrate：只打印 DDL 计划与预计行数，不建表、不装载；rollback：只打印待删清单，不执行 DROP |
| `--rebuild` | migrate | 否 | 关 | 导入前先 DROP 本轮登记表后重建；缺省路径按主键 `ON CONFLICT DO UPDATE`，不清空全表。属于写操作，受目标库守卫约束 |
| `--sample <n>` | verify | 否 | `20` | 每表抽样行数，整数 1..1000；表内行数 ≤ n 时全表比对；越界退出 1 |
| `--apply` | rollback | 否 | 关 | 显式确认才执行 DROP；与 `--dry-run` 同时给出退出 1。受目标库守卫约束 |
| `--allow-source-outside-scratch` | migrate / verify | 否 | 关 | 显式放行源路径不在 `.scratch/run/D/` 下的情形；缺省命中受保护真实目录时退出 1 |
| `--force-target` | 三个入口 | 否 | 关 | 目标库不是演练实例时仍执行写操作；不带此参数一律拒绝 |
| `-h, --help` | 三个入口 | 否 | — | 打印该入口的用法 |

未知参数一律按用法错误处理：退出码 1，中文消息指出具体参数名。拼错的开关（如 `--dryrun`）不会被静默忽略后继续连库。

## 退出码

| 退出码 | 含义 | 典型场景 |
|---|---|---|
| `0` | 成功 / 一致 / dry-run 完成 | migrate 装载完成；verify 全绿；rollback dry-run 打印完成 |
| `1` | 用法或参数错误 | 缺 `--source`；未知参数；参数越界；源路径在受保护目录；`--apply` 与 `--dry-run` 同给；写操作命中非演练目标且未给 `--force-target` |
| `2` | 环境、连接、SQL 或数据合法性错误 | 连不上 PG；源库版本非 7；缺表；非法 JSON；非 ISO 时间戳；注册表与源码漂移；装载 SQL 失败；回滚事务失败 |
| `3` | 校验不一致（仅 `verify.js`） | 行数不等；抽样字段不等；`content_hash` 复算不符 |

退出码 3 只属于 verify；migrate 与 rollback 不使用 3。

## 典型报错与排查

| 症状 / 消息 | 退出码 | 最可能原因与排查 |
|---|---|---|
| `无法连接 PostgreSQL：<原因>。请检查 PGHOST、PGPORT、PGUSER、PGPASSWORD。` | 2 | 实例未起、端口或账号密码错；先确认实例可达，再核对四个连接环境变量是否与实际实例一致 |
| `拒绝在非演练目标上执行写操作：库名 <db>（预期 yxs）；端口 <port>（预期 55432）。…` | 1 | `PGPORT`/`PGDATABASE`/`--pg-url` 指到了非演练库。先确认目标身份；确属有意，再加 `--force-target` |
| `未知参数 <token>（<入口>）。…` | 1 | 参数拼错（如 `--dryrun`）。运行 `node tools/migrate-pg/src/<入口> --help` 看支持列表 |
| `源库 schema 版本为 <v>，预期 7；请先在桌面端或 seed 流程跑齐本地迁移。` | 2 | 副本 `PRAGMA user_version` 不是 7，本地迁移链未跑齐；换一份版本为 7 的副本，不要在工具内补列 |
| `注册表与源码结构漂移（…）。` / `[schema]` 的逐项差异行 | 2 / 1 | `packages/db/src/index.ts` 的表、列、类型、可空、默认、主键、外键、唯一约束或索引与 `src/schema-map.js` 注册表不一致；按提示逐项同步注册表 |
| `表 <table> 的列 <column> 不是合法 JSON（主键 <pk>）：<解析原因>。` | 2 | jsonb 列存在脏值；按消息里的表名、列名、主键回源库抽查该值，工具不做静默兜底或字符串包裹 |
| `时间戳列 <table>.<column> 存在非 ISO 取值（主键 <pk>）：<value>。` | 2 | 时间戳列存了无法按 ISO-8601 解析的占位串；按主键回源库核对取值口径 |
| `[verify] rows <table> src=<n> pg=<m>` / `行数不一致：表 <table> 源 <n> 行，目标 <m> 行。` | 3 | 第二遍 migrate 未走幂等路径、中途清过表，或两侧表名集合不一致；对照两遍 migrate 日志的逐表行数 |
| `[verify] DIFF table=<table> pk=<pk> column=<column> source=<…> target=<…>` | 3 | 正文或字段在迁移中被改写（编码截断、转义变化）；取值里的换行/制表符已转义为 `\n`/`\t`，保证该行始终单行可解析。按主键双侧比对该列原文长度与字符 |
| `[verify] HASH article=<id> source=<源哈希> target=<PG 存储哈希> recomputed=<复算哈希>` | 3 | 三个值可定位篡改位置：`source ≠ target` 说明 PG 侧哈希被改；`source = target ≠ recomputed` 说明正文与哈希不成对。哈希只对正文 `content` 取 sha256 hex |
| `[rollback] dry-run（未删除任何数据）` / `未执行删除：rollback 默认 dry-run；确认后加 --apply。` | 0 | 这是 dry-run 提示，不是错误；确认清单无误后才加 `--apply` 执行删除 |

## jsonb 与数值精度

jsonb 列**不经过 JS 序列化往返**：`JSON.parse` 只用于校验合法性，送 `COPY` 的始终是源库原始文本（空串按该列默认 JSON 归一为 `[]` / `{}`）。原因是 `JSON.parse → JSON.stringify` 会把 19 位雪花 id 改写成 `1.2345678901234568e+29`、把 `1e400` 变成 `null`、把 `1.0` 压成 `1`，且不可逆。

verify 侧同样不以 JS 浮点比较：PG 的 jsonb 列以 `::text` 取回，用保留数字字面量的解析器按十进制精确比对（`1` / `1.0` / `1e0` 视为同值，`1.0` 与 `1.0000000000000001` 判为不同）。键序无关，数组顺序敏感。

抽样排序两侧显式钉到字节序（SQLite `COLLATE BINARY`、PG `COLLATE "C"`），避免库 collation 差异导致「前 n 行」不是同一批行。

## 运行期资源

| 项 | D 轮取值 |
|---|---|
| PG 宿主端口 | `55432` |
| 容器名 | `yxs-pg-d` |
| 数据卷 | `yxs-pg` |
| 库名 / 用户 | `yxs` / `yxs`（密码来自环境变量） |

本工具只通过连接串对接一个**已经存在**的 PG 实例；不负责拉起容器、不执行编排命令、不创建或删除数据卷。容器与卷的归属由编排轮次负责。

## 边界与范围

- **不改运行时方言**：不修改 `packages/db`，运行时仍然读取 SQLite；PG 库只承担本轮迁移产物、比对与回滚演练角色。
- **只迁移 `learning.db`**：`auth.db` 是服务端自有库，不在本工具范围内。
- **回滚范围**：只 DROP 工具内部登记的 38 张表；禁止 `DROP DATABASE`，禁止 `TRUNCATE` 任何共享库；`--apply` 在单事务内逆序删除，任一表失败整体回滚，不留半删状态。
- **不在 PG 侧增补**：不新增源库没有的视图、触发器、业务索引或 JSON GIN 索引。

## 目录结构

```text
tools/migrate-pg/
  package.json      # @yxs/migrate-pg，type=module，独立安装；scripts 指向 src/
  README.md         # 本文件
  .gitignore        # 包内运行产物：node_modules/、*.dump、*.log
  pnpm-lock.yaml    # 由独立安装生成
  node_modules/     # 由独立安装生成（已 gitignore）
  src/
    migrate.js      # 入口一：迁移导入，幂等可重复跑
    verify.js       # 入口二：行数 + 抽样字段 + 正文哈希校验
    rollback.js     # 入口三：默认 dry-run，--apply 才删除
    schema-map.js   # 38 表注册表 + 源码漂移核对（表/列/类型/可空/默认/键/索引）
    values.js       # 取值归一唯一实现：jsonb 原文直传、空串归一、时间戳、boolean、精确 JSON 比较
    cli.js          # 参数解析与退出码工具
    target.js       # 连接参数与目标库身份守卫
    pg-driver.js    # 按需加载 pg；未装依赖时给中文提示而不是英文堆栈
```

源码一律在 `src/`；包根只放配置与文档。`lib/` 在本仓库专指编译产物，本包无编译步骤，因此没有 `lib/`。
