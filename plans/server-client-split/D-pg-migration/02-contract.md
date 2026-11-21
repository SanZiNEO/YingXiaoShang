# D · SQLite → PostgreSQL 迁移工具 · 契约

> 轮次：D · SQLite → PostgreSQL 迁移与校验工具
> 文档角色：02-contract
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1 §10.5（本文件只细化，不改端口、不改库名、不改表名）
> 一句话：实现者照这份文档写三个入口脚本，验收者照这份文档判「迁移对不对、校验严不严、回滚安不安全」。

## 1 契约总览

| 层 | 冻结值（§10.5 / §10.2） | 本轮细化 |
|---|---|---|
| 目标镜像 / 实例 | `postgres:16-alpine`；库 `yxs`；用户 `yxs`；宿主端口 `55432`；容器 `yxs-pg-d`；卷 `yxs-pg` | 连接参数与环境变量读取顺序（§2.1） |
| 类型基线 | `TEXT→text`、`INTEGER→bigint`、`REAL→double precision`、JSON 列→`jsonb` | 逐列判定规则、空串/时区/混型处理（§3.1） |
| 迁移范围 | 只迁移 `learning.db`；`auth.db` 不在范围 | 38 张表清单与列约束（§3.2） |
| 工具边界 | 不改 `packages/db` 运行时方言；只产出迁移/校验/回滚能力 | 三个 CLI 的参数、stdout、退出码（§2、§4） |
| 校验口径 | `verify` 不一致非零退出，打印第一处差异 | 「一致」的精确定义、抽样规则、哈希比对（§2.3、§3.3） |

**契约稳定性**：本文件的表名、列名、类型映射、退出码、中文消息视为 v1 冻结。新增表/列必须先更新 §3.2 清单与工具表名集合；不得在 PG 侧新增业务索引、视图或触发器。批量装载采用 `COPY` 通道，逐表报告行数 [R1]。

## 2 接口契约（CLI / stdout / 退出码）

### 2.1 连接与环境变量

连接参数读取顺序：命令行 `--pg-url` > 环境变量 > 下表默认值。环境变量名与冻结 §10.2 一致。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PGHOST` | `127.0.0.1` | 本机演练实例 |
| `PGPORT` | `55432` | D 轮专用；G 轮为 `55433`，不得串用 |
| `PGDATABASE` | `yxs` | 库名 |
| `PGUSER` | `yxs` | 用户名 |
| `PGPASSWORD` | （无默认，必填于环境） | 密码不写进命令行参数与文档 |

`--pg-url` 形如 `postgres://yxs:<password>@127.0.0.1:55432/yxs`；出现在日志里的连接串必须把密码替换为 `***`。源库路径只接受 `.scratch/run/D/` 下的副本；指向真实数据目录时退出码 1（§4）。

**目标库身份守卫**：写操作（缺省 upsert、`migrate --rebuild`、`rollback --apply`）在执行前核对目标身份——库名必须是 `yxs`、宿主端口必须是 `55432`（即上表默认值）。不匹配时退出码 1，不建立连接、不执行任何 SQL；`--force-target` 显式放行。只读操作（`migrate --dry-run`、verify、rollback dry-run）只打印 `[guard]` 警告行，不阻断。判据可用 `YXS_PG_EXPECT_DATABASE` / `YXS_PG_EXPECT_PORT` 覆盖，以便在别的机器上钉住自己的专用实例而不改代码。连库后再用 `current_database()` 复核一次真实库名；端口只在客户端侧比对（docker 端口映射会让服务端报出容器内端口）。

**未知参数**：三个入口对无法识别的参数一律退出 1 并给出中文消息，不静默忽略（§2.5）。

### 2.2 `migrate.js`（迁移，幂等可重复跑）

命令：

```powershell
node tools/migrate-pg/src/migrate.js --source .scratch/run/D/learning.db
node tools/migrate-pg/src/migrate.js --source .scratch/run/D/learning.db --dry-run
node tools/migrate-pg/src/migrate.js --source .scratch/run/D/learning.db --rebuild
```

| 参数 | 必填 | 类型 / 边界 | 默认 | 说明 |
|---|---|---|---|---|
| `--source <path>` | 是 | 存在的 SQLite 文件路径 | — | 只读打开；不写回源库 |
| `--pg-url <url>` | 否 | 合法 PG 连接串 | 走 §2.1 环境变量 | 覆盖环境变量 |
| `--dry-run` | 否 | 开关 | 关 | 只打印 DDL 计划与预计行数，不建表、不装载 |
| `--rebuild` | 否 | 开关 | 关 | 导入前 DROP 本轮登记的表后重建；缺省按主键冲突更新，不清空全表。写操作，受 §2.1 目标库守卫约束 |
| `--force-target` | 否 | 开关 | 关 | 目标库不是演练实例时仍执行写操作；不带此参数一律拒绝 |
| `-h, --help` | 否 | 开关 | — | 打印用法 |

stdout 阶段行（顺序即契约）：

```text
[migrate] source: .scratch/run/D/learning.db (schema version 7, 38 tables)
[migrate] target: postgres://yxs@127.0.0.1:55432/yxs
[migrate] schema: ok
[migrate] copy chapters 13
[migrate] copy sections 42
…
[migrate] done: 38 tables, 12345 rows
```

幂等口径：重复执行不产生重复行。缺省模式下目标表已存在时，按主键 `ON CONFLICT DO UPDATE` 写冲突列 [R5]；`--rebuild` 模式先删后建。`--dry-run` 不发起任何写事务。

### 2.3 `verify.js`（行数 100% + 抽样 20 行 + 哈希复算）

命令：

```powershell
node tools/migrate-pg/src/verify.js --source .scratch/run/D/learning.db
node tools/migrate-pg/src/verify.js --source .scratch/run/D/learning.db --sample 20
```

| 参数 | 必填 | 类型 / 边界 | 默认 | 说明 |
|---|---|---|---|---|
| `--source <path>` | 是 | 存在的 SQLite 文件路径 | — | 比对一侧 |
| `--pg-url <url>` | 否 | 合法 PG 连接串 | 走 §2.1 环境变量 | 比对另一侧 |
| `--sample <n>` | 否 | 整数 1..1000 | `20` | 每表抽样行数；表内行数 ≤ n 时全表比对 |
| `-h, --help` | 否 | 开关 | — | 打印用法 |

stdout：

```text
[verify] target: postgres://yxs@127.0.0.1:55432/yxs
[verify] rows chapters src=13 pg=13
[verify] sample chapters 13 rows
[verify] rows news_articles src=208 pg=208
[verify] sample news_articles 20 rows
[verify] ok: 38 tables, rows match, sample and hash check passed
```

不一致时在第一处差异行后继续完成行数汇总，抽样比对在该表第一处差异后停止；退出码 3（§4）。

### 2.4 `rollback.js`（默认 dry-run，只打印不删）

命令：

```powershell
node tools/migrate-pg/src/rollback.js              # 默认 dry-run
node tools/migrate-pg/src/rollback.js --dry-run    # 显式 dry-run
node tools/migrate-pg/src/rollback.js --apply      # 显式确认后才删除
```

| 参数 | 必填 | 类型 | 默认 | 说明 |
|---|---|---|---|---|
| `--pg-url <url>` | 否 | 合法 PG 连接串 | 走 §2.1 环境变量 | — |
| `--dry-run` | 否 | 开关 | **开** | 只打印将删除的表与逆序，不执行 DROP |
| `--apply` | 否 | 开关 | 关 | 必须显式给出才执行删除；与 `--dry-run` 同时出现时报退出码 1。写操作，受 §2.1 目标库守卫约束 |
| `--force-target` | 否 | 开关 | 关 | 目标库不是演练实例时仍执行 `--apply`；不带此参数一律拒绝 |
| `-h, --help` | 否 | 开关 | — | 打印用法 |

dry-run 输出格式：

```text
[rollback] target: postgres://yxs@127.0.0.1:55432/yxs
[rollback] dry-run（未删除任何数据）
[rollback] 将按依赖逆序删除以下 38 张本轮登记的表：
  1. turns
  2. chat_messages
  …
  38. chapters
[rollback] 确认执行请加 --apply。
```

`--apply` 在单个事务内按依赖逆序 `DROP TABLE`；任一表失败则回滚整个事务，退出码 2。删除范围仅限工具内部登记的 38 张表名集合；**禁止** `DROP DATABASE`、禁止 `TRUNCATE` 任何共享库 [R6]。

### 2.5 退出码总表

| 退出码 | 含义 | 典型场景 |
|---|---|---|
| `0` | 成功 / 一致 / dry-run 完成 | migrate 装载完成；verify 全绿；rollback dry-run 打印完成 |
| `1` | 用法或参数错误 | 缺 `--source`；未知参数；参数越界；源路径在受保护目录；`--apply` 与 `--dry-run` 同给；写操作命中非演练目标且未给 `--force-target` |
| `2` | 环境、连接、SQL 或数据合法性错误 | 连不上 PG；源库版本非 7；缺表；非法 JSON；非 ISO 时间戳；注册表与源码结构漂移；装载 SQL 失败；回滚事务失败 |
| `3` | 校验不一致（仅 `verify.js`） | 行数不等；抽样字段不等；`content_hash` 复算不符 |

退出码 3 只属于 verify；migrate 与 rollback 不使用 3。

## 3 数据结构（逐表清单与类型映射）

### 3.1 类型映射总表

| SQLite 源（列声明） | PostgreSQL 目标 | 转换与保留规则 |
|---|---|---|
| `TEXT`（普通文本） | `text` | `NOT NULL` 保留；`DEFAULT '<串>'` 保留为 text 字面量；空串 `''` 保持空串，不转 NULL |
| `TEXT`（列名后缀 `_json`，或 `value_json` / `state_json` / `plan_json` / `record_json` / `payload_json` / `content_json` / `profile_json` / `metadata_json` / `input_schema_json`） | `jsonb` | 装载前逐值 `JSON.parse` **仅用于校验**；送 `COPY` 的始终是源库原始文本，**不做** `JSON.parse` → `JSON.stringify` 往返（该往返会把 19 位雪花 id 改写成科学计数法、把 `1e400` 变成 `null`、把 `1.0` 压成 `1`，且不可逆；数值精度由 PG 的 jsonb 解析器保留）。解析失败退出码 2（§4）。默认 `'[]'` / `'{}'` 在 PG 写成 `DEFAULT '[]'::jsonb` / `'{}'::jsonb`；空串 `''` 按该列默认 JSON 归一为 `[]` / `{}` 的文本 [R2] |
| `INTEGER` | 默认 `bigint` | 判定收窄为 `integer` 的条件：迁移前源库实测 `min()`/`max()` 均在 ±2³¹-1 内，且列为小秩、计数或序号列；未实测的列一律 `bigint` [R3] |
| `INTEGER` 0/1 标志列（`skills.enabled`） | `boolean` | 装载时 `1→true`、`0→false`；其他值退出码 2。本规则是唯一的布尔例外，不推广到其他 INTEGER 列 |
| `REAL` | `double precision` | 原样装载；抽样比对时两侧差值 ≤ `1e-9`（相对误差）视为相等 |
| `TEXT` 时间戳列（列名匹配 `_at`，值为 `toISOString()` UTC `Z` 串） | `timestamptz` | 按 ISO-8601 UTC 解析；空串 `''` → SQL `NULL`；非 ISO 取值退出码 2。源列 `NOT NULL DEFAULT ''` 时目标列允许 NULL（空串是占位，不是真实时刻） |
| 单列 `PRIMARY KEY`（`id TEXT`） | `text PRIMARY KEY` | 列名不变；主键约束在 PG 侧重建 |
| 复合 `PRIMARY KEY` | `PRIMARY KEY (col_a, col_b)` | 列顺序与源 DDL 一致；`WITHOUT ROWID` 子句丢弃（PG 无对应概念） |
| `REFERENCES <table>(id) ON DELETE CASCADE` | `FOREIGN KEY … REFERENCES <table>(id) ON DELETE CASCADE` | 外键动作保留；装载按父表先于子表的拓扑序执行 |
| 唯一索引 / 表内 `UNIQUE(...)` | 唯一约束或唯一索引 | 源库 3 个唯一索引 + `turns` 表内 `UNIQUE(session_id, turn_id)` 全部保留（§3.2 标注） |

STRICT 对应的 `NOT NULL` 与 `DEFAULT` 必须逐列保留 [R4]；PG 侧不新增源库没有的约束。SQLite 类型亲和性可能让 `TEXT` 列混入数值，映射按列声明走，不按抽样值改类型 [R3]。

### 3.2 逐表清单（38 张，按代码出现顺序）

> 行号指向 `packages/db/src/index.ts`；「默认」列为空表示无默认值。可空：√ 表示允许 NULL。

**1. `chapters`**（`packages/db/src/index.ts:92-94`）— 主键 `id`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `number` | `INTEGER` → `bigint` | 否 | — |
| `title` | `TEXT` → `text` | 否 | — |
| `source_path` | `TEXT` → `text` | 否 | — |

**2. `sections`**（`packages/db/src/index.ts:96-99`）— 主键 `id`；外键 `chapter_id → chapters(id) ON DELETE CASCADE`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `chapter_id` | `TEXT` → `text` | 否 | 外键 |
| `number` | `INTEGER` → `bigint` | 否 | — |
| `title` | `TEXT` → `text` | 否 | — |

**3. `knowledge_points`**（`packages/db/src/index.ts:101-110`）— 主键 `id`；外键 `chapter_id → chapters`、`section_id → sections`，均 CASCADE

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `chapter_id` | `TEXT` → `text` | 否 | 外键 |
| `section_id` | `TEXT` → `text` | 否 | 外键 |
| `name` | `TEXT` → `text` | 否 | — |
| `name_en` | `TEXT` → `text` | 否 | `''` |
| `definition` | `TEXT` → `text` | 否 | — |
| `keywords_json` | `TEXT` → `jsonb` | 否 | `'[]'::jsonb` |
| `examples_json` | `TEXT` → `jsonb` | 否 | `'[]'::jsonb` |
| `non_examples_json` | `TEXT` → `jsonb` | 否 | `'[]'::jsonb` |
| `aliases_json` | `TEXT` → `jsonb` | 否 | `'[]'::jsonb` |
| `difficulty` | `INTEGER` → `bigint` | 否 | `2` |
| `competencies_json` | `TEXT` → `jsonb` | 否 | `'[]'::jsonb` |
| `decisions_json` | `TEXT` → `jsonb` | 否 | `'[]'::jsonb` |
| `source` | `TEXT` → `text` | 否 | — |
| `status` | `TEXT` → `text` | 否 | `'draft'` |
| `parent_id` | `TEXT` → `text` | √ | — |

**4. `content_blocks`**（`packages/db/src/index.ts:112-116`）— 主键 `id`；外键 `chapter_id → chapters` CASCADE

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `chapter_id` | `TEXT` → `text` | 否 | 外键 |
| `section_id` | `TEXT` → `text` | 否 | — |
| `block_type` | `TEXT` → `text` | 否 | — |
| `text` | `TEXT` → `text` | 否 | — |
| `page` | `INTEGER` → `bigint` | √ | — |
| `source` | `TEXT` → `text` | 否 | — |
| `rights` | `TEXT` → `text` | 否 | — |

**5. `content_tags`**（`packages/db/src/index.ts:118-123`，增量列 `:404-407`）— 主键 `id`；外键 `block_id → content_blocks` CASCADE；索引 `content_tags_by_key(tag_type, tag_key)`、`content_tags_by_review(review_status, evidence_level)`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `block_id` | `TEXT` → `text` | 否 | 外键 |
| `tag_type` | `TEXT` → `text` | 否 | — |
| `tag_key` | `TEXT` → `text` | 否 | — |
| `tag_role` | `TEXT` → `text` | 否 | — |
| `confidence` | `REAL` → `double precision` | 否 | — |
| `method` | `TEXT` → `text` | 否 | — |
| `evidence_span` | `TEXT` → `text` | 否 | — |
| `evidence_start` | `INTEGER` → `bigint` | √ | — |
| `evidence_end` | `INTEGER` → `bigint` | √ | — |
| `review_status` | `TEXT` → `text` | 否 | `'draft'` |
| `evidence_level` | `TEXT` → `text` | 否 | `'auto'` |
| `version` | `TEXT` → `text` | 否 | `'v0.1'` |
| `reviewer_id` | `TEXT` → `text` | 否 | `''` |
| `reviewed_at` | `TEXT` → `timestamptz` | √ | 空串 → NULL |

**6. `ideology_points`**（`packages/db/src/index.ts:126-130`）— 主键 `id`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `name` | `TEXT` → `text` | 否 | — |
| `definition` | `TEXT` → `text` | 否 | — |
| `examples_json` | `TEXT` → `jsonb` | 否 | `'[]'::jsonb` |
| `non_examples_json` | `TEXT` → `jsonb` | 否 | `'[]'::jsonb` |
| `related_kp_ids_json` | `TEXT` → `jsonb` | 否 | `'[]'::jsonb` |
| `source` | `TEXT` → `text` | 否 | — |

**7. `ideology_tags`**（`packages/db/src/index.ts:132-137`，增量列 `:423-426`）— 主键 `id`；外键 `ideology_id → ideology_points` CASCADE；索引 `ideology_tags_by_target(target_type, target_id)`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `target_type` | `TEXT` → `text` | 否 | — |
| `target_id` | `TEXT` → `text` | 否 | — |
| `ideology_id` | `TEXT` → `text` | 否 | 外键 |
| `confidence` | `REAL` → `double precision` | 否 | — |
| `evidence_span` | `TEXT` → `text` | 否 | — |
| `rationale` | `TEXT` → `text` | 否 | `''` |
| `review_status` | `TEXT` → `text` | 否 | `'draft'` |
| `evidence_level` | `TEXT` → `text` | 否 | `'auto'` |
| `version` | `TEXT` → `text` | 否 | `'v0.1'` |
| `reviewer_id` | `TEXT` → `text` | 否 | `''` |
| `reviewed_at` | `TEXT` → `timestamptz` | √ | 空串 → NULL |

**8. `news_articles`**（`packages/db/src/index.ts:140-145`，增量列 `:446-447`）— 主键 `id`；**唯一索引** `news_articles_by_url(url)`；索引 `news_articles_by_published(published_at)`、`news_articles_by_tag_hash(tag_content_hash)`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `source` | `TEXT` → `text` | 否 | — |
| `source_id` | `TEXT` → `text` | 否 | — |
| `title` | `TEXT` → `text` | 否 | — |
| `url` | `TEXT` → `text` | 否 | 唯一 |
| `author` | `TEXT` → `text` | 否 | `''` |
| `published_at` | `TEXT` → `timestamptz` | 否 | — |
| `summary` | `TEXT` → `text` | 否 | `''` |
| `content` | `TEXT` → `text` | 否 | — |
| `content_status` | `TEXT` → `text` | 否 | — |
| `rights` | `TEXT` → `text` | 否 | — |
| `fetched_at` | `TEXT` → `timestamptz` | 否 | — |
| `content_hash` | `TEXT` → `text`（sha256 hex） | 否 | `''` |
| `tag_content_hash` | `TEXT` → `text`（sha256 hex） | 否 | `''` |

**9. `news_tags`**（`packages/db/src/index.ts:149-154`，增量列 `:417-421`）— 主键 `id`；外键 `article_id → news_articles` CASCADE；索引 `news_tags_by_key(tag_type, tag_key)`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `article_id` | `TEXT` → `text` | 否 | 外键 |
| `tag_type` | `TEXT` → `text` | 否 | — |
| `tag_key` | `TEXT` → `text` | 否 | — |
| `tag_role` | `TEXT` → `text` | 否 | — |
| `confidence` | `REAL` → `double precision` | 否 | — |
| `method` | `TEXT` → `text` | 否 | — |
| `evidence_span` | `TEXT` → `text` | 否 | — |
| `evidence_start` | `INTEGER` → `bigint` | √ | — |
| `evidence_end` | `INTEGER` → `bigint` | √ | — |
| `review_status` | `TEXT` → `text` | 否 | `'draft'` |
| `evidence_level` | `TEXT` → `text` | 否 | `'auto'` |
| `version` | `TEXT` → `text` | 否 | `'v0.1'` |
| `reviewer_id` | `TEXT` → `text` | 否 | `''` |
| `reviewed_at` | `TEXT` → `timestamptz` | √ | 空串 → NULL |

**10. `case_matches`**（`packages/db/src/index.ts:157-163`，增量列 `:410-414`）— 主键 `id`；外键 `article_id → news_articles`、`kp_id → knowledge_points`，均 CASCADE；索引 `case_matches_by_article(article_id)`、`case_matches_by_kp(kp_id)`、`case_matches_by_review(review_status, evidence_level)`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `article_id` | `TEXT` → `text` | 否 | 外键 |
| `kp_id` | `TEXT` → `text` | 否 | 外键 |
| `score` | `REAL` → `double precision` | 否 | — |
| `confidence` | `REAL` → `double precision` | 否 | — |
| `tag_role` | `TEXT` → `text` | 否 | — |
| `evidence_span` | `TEXT` → `text` | 否 | — |
| `evidence_start` | `INTEGER` → `bigint` | √ | — |
| `evidence_end` | `INTEGER` → `bigint` | √ | — |
| `rationale` | `TEXT` → `text` | 否 | — |
| `method` | `TEXT` → `text` | 否 | — |
| `created_at` | `TEXT` → `timestamptz` | 否 | — |
| `review_status` | `TEXT` → `text` | 否 | `'draft'` |
| `evidence_level` | `TEXT` → `text` | 否 | `'auto'` |
| `version` | `TEXT` → `text` | 否 | `'v0.1'` |
| `reviewer_id` | `TEXT` → `text` | 否 | `''` |
| `reviewed_at` | `TEXT` → `timestamptz` | √ | 空串 → NULL |

**11. `questions`**（`packages/db/src/index.ts:167-172`）— 主键 `id`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `source_type` | `TEXT` → `text` | 否 | — |
| `source_id` | `TEXT` → `text` | 否 | `''` |
| `type` | `TEXT` → `text` | 否 | — |
| `stem` | `TEXT` → `text` | 否 | — |
| `options_json` | `TEXT` → `jsonb` | 否 | `'[]'::jsonb` |
| `answer` | `TEXT` → `text` | 否 | — |
| `explanation` | `TEXT` → `text` | 否 | — |
| `difficulty` | `INTEGER` → `bigint` | 否 | — |
| `status` | `TEXT` → `text` | 否 | `'draft'` |
| `created_at` | `TEXT` → `timestamptz` | 否 | — |

**12. `question_kps`**（`packages/db/src/index.ts:174-178`）— 复合主键 `(question_id, kp_id)`；外键两列分别 CASCADE 到 `questions`、`knowledge_points`；索引 `question_kps_by_kp(kp_id)`；源 `WITHOUT ROWID` 丢弃

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `question_id` | `TEXT` → `text` | 否 | 复合主键 / 外键 |
| `kp_id` | `TEXT` → `text` | 否 | 复合主键 / 外键 |

**13. `question_ideology`**（`packages/db/src/index.ts:181-185`）— 复合主键 `(question_id, ideology_id)`；外键两列分别 CASCADE 到 `questions`、`ideology_points`；源 `WITHOUT ROWID` 丢弃

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `question_id` | `TEXT` → `text` | 否 | 复合主键 / 外键 |
| `ideology_id` | `TEXT` → `text` | 否 | 复合主键 / 外键 |

**14. `question_attempts`**（`packages/db/src/index.ts:187-191`）— 主键 `id`；外键 `question_id → questions` CASCADE

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `question_id` | `TEXT` → `text` | 否 | 外键 |
| `student_id` | `TEXT` → `text` | 否 | — |
| `answer` | `TEXT` → `text` | 否 | — |
| `feedback_json` | `TEXT` → `jsonb` | 否 | `'{}'::jsonb` |
| `score` | `REAL` → `double precision` | 否 | — |
| `created_at` | `TEXT` → `timestamptz` | 否 | — |

**15. `research_projects`**（`packages/db/src/index.ts:193-196`）— 主键 `id`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `student_id` | `TEXT` → `text` | 否 | — |
| `brief` | `TEXT` → `text` | 否 | — |
| `status` | `TEXT` → `text` | 否 | `'draft'` |
| `created_at` | `TEXT` → `timestamptz` | 否 | — |
| `updated_at` | `TEXT` → `timestamptz` | 否 | — |

**16. `research_artifacts`**（`packages/db/src/index.ts:198-201`）— 主键 `id`；外键 `project_id → research_projects` CASCADE

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `project_id` | `TEXT` → `text` | 否 | 外键 |
| `step` | `TEXT` → `text` | 否 | — |
| `content_json` | `TEXT` → `jsonb` | 否 | — |
| `created_at` | `TEXT` → `timestamptz` | 否 | — |

**17. `bp_projects`**（`packages/db/src/index.ts:203-206`）— 主键 `id`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `student_id` | `TEXT` → `text` | 否 | — |
| `idea` | `TEXT` → `text` | 否 | — |
| `status` | `TEXT` → `text` | 否 | `'draft'` |
| `created_at` | `TEXT` → `timestamptz` | 否 | — |
| `updated_at` | `TEXT` → `timestamptz` | 否 | — |

**18. `bp_sections`**（`packages/db/src/index.ts:208-212`）— 主键 `id`；外键 `project_id → bp_projects` CASCADE

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `project_id` | `TEXT` → `text` | 否 | 外键 |
| `section` | `TEXT` → `text` | 否 | — |
| `content` | `TEXT` → `text` | 否 | — |
| `evidence_json` | `TEXT` → `jsonb` | 否 | `'[]'::jsonb` |
| `updated_at` | `TEXT` → `timestamptz` | 否 | — |

**19. `student_profiles`**（`packages/db/src/index.ts:214-216`，增量列 `:236-237`）— 主键 `id`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `name` | `TEXT` → `text` | 否 | — |
| `cohort` | `TEXT` → `text` | 否 | `''` |
| `created_at` | `TEXT` → `timestamptz` | 否 | — |
| `profile_json` | `TEXT` → `jsonb` | 否 | `'{}'::jsonb` |
| `updated_at` | `TEXT` → `timestamptz` | √ | 空串 → NULL |

**20. `growth_records`**（`packages/db/src/index.ts:218-222`）— 主键 `id`；外键 `student_id → student_profiles` CASCADE

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `student_id` | `TEXT` → `text` | 否 | 外键 |
| `competency` | `TEXT` → `text` | 否 | — |
| `level` | `TEXT` → `text` | 否 | — |
| `evidence_json` | `TEXT` → `jsonb` | 否 | `'[]'::jsonb` |
| `created_at` | `TEXT` → `timestamptz` | 否 | — |

**21. `ingest_runs`**（`packages/db/src/index.ts:224-227`）— 主键 `id`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `source` | `TEXT` → `text` | 否 | — |
| `started_at` | `TEXT` → `timestamptz` | 否 | — |
| `finished_at` | `TEXT` → `timestamptz` | √ | — |
| `status` | `TEXT` → `text` | 否 | — |
| `stats_json` | `TEXT` → `jsonb` | 否 | `'{}'::jsonb` |

**22. `plugin_state`**（`packages/db/src/index.ts:229-232`）— 复合主键 `(plugin_id, key)`；源 `WITHOUT ROWID` 丢弃

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `plugin_id` | `TEXT` → `text` | 否 | 复合主键 |
| `key` | `TEXT` → `text` | 否 | 复合主键 |
| `value_json` | `TEXT` → `jsonb` | 否 | — |
| `updated_at` | `TEXT` → `timestamptz` | 否 | — |

**23. `competencies`**（`packages/db/src/index.ts:239-243`）— 主键 `id`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `name` | `TEXT` → `text` | 否 | — |
| `definition` | `TEXT` → `text` | 否 | — |
| `levels_json` | `TEXT` → `jsonb` | 否 | — |
| `observable_json` | `TEXT` → `jsonb` | 否 | `'[]'::jsonb` |
| `version` | `TEXT` → `text` | 否 | `'v0.1'` |
| `created_at` | `TEXT` → `timestamptz` | 否 | — |

**24. `evidence`**（`packages/db/src/index.ts:245-254`）— 主键 `id`；外键 `student_id → student_profiles`、`competency_id → competencies`，均 CASCADE；索引 `evidence_by_student(student_id, occurred_at)`、`evidence_by_competency(student_id, competency_id)`、`evidence_by_chapter(student_id, chapter_id)`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `student_id` | `TEXT` → `text` | 否 | 外键 |
| `competency_id` | `TEXT` → `text` | 否 | 外键 |
| `level` | `TEXT` → `text` | 否 | — |
| `strength` | `TEXT` → `text` | 否 | — |
| `evidence_type` | `TEXT` → `text` | 否 | — |
| `source_type` | `TEXT` → `text` | 否 | — |
| `source_id` | `TEXT` → `text` | 否 | `''` |
| `chapter_id` | `TEXT` → `text` | 否 | `''` |
| `session_id` | `TEXT` → `text` | 否 | `''` |
| `excerpt` | `TEXT` → `text` | 否 | — |
| `rationale` | `TEXT` → `text` | 否 | `''` |
| `confidence` | `REAL` → `double precision` | 否 | — |
| `method` | `TEXT` → `text` | 否 | `'llm'` |
| `review_status` | `TEXT` → `text` | 否 | `'draft'` |
| `review_note` | `TEXT` → `text` | 否 | `''` |
| `occurred_at` | `TEXT` → `timestamptz` | 否 | — |
| `created_at` | `TEXT` → `timestamptz` | 否 | — |
| `metadata_json` | `TEXT` → `jsonb` | 否 | `'{}'::jsonb` |

**25. `growth_snapshots`**（`packages/db/src/index.ts:259-265`）— 主键 `id`；外键 `student_id → student_profiles`、`competency_id → competencies`，均 CASCADE；索引 `snapshots_by_student(student_id, chapter_id)`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `student_id` | `TEXT` → `text` | 否 | 外键 |
| `chapter_id` | `TEXT` → `text` | 否 | — |
| `checkpoint` | `TEXT` → `text` | 否 | — |
| `competency_id` | `TEXT` → `text` | 否 | 外键 |
| `level` | `TEXT` → `text` | 否 | — |
| `confidence` | `REAL` → `double precision` | 否 | — |
| `evidence_count` | `INTEGER` → `bigint` | 否 | — |
| `summary` | `TEXT` → `text` | 否 | `''` |
| `created_at` | `TEXT` → `timestamptz` | 否 | — |

**26. `learning_plan`**（`packages/db/src/index.ts:268-273`）— 主键 `id`；外键 `student_id → student_profiles` CASCADE；索引 `plan_by_student(student_id, chapter_id)`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `student_id` | `TEXT` → `text` | 否 | 外键 |
| `chapter_id` | `TEXT` → `text` | 否 | — |
| `phase` | `TEXT` → `text` | 否 | — |
| `title` | `TEXT` → `text` | 否 | — |
| `tasks_json` | `TEXT` → `jsonb` | 否 | `'[]'::jsonb` |
| `status` | `TEXT` → `text` | 否 | `'pending'` |
| `due_at` | `TEXT` → `timestamptz` | √ | 空串 → NULL |
| `updated_at` | `TEXT` → `timestamptz` | 否 | — |

**27. `chat_sessions`**（`packages/db/src/index.ts:276-280`）— 主键 `id`；外键 `student_id → student_profiles` CASCADE；索引 `chat_sessions_by_student(student_id, updated_at)`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `student_id` | `TEXT` → `text` | 否 | 外键 |
| `chapter_id` | `TEXT` → `text` | 否 | `''` |
| `title` | `TEXT` → `text` | 否 | `''` |
| `created_at` | `TEXT` → `timestamptz` | 否 | — |
| `updated_at` | `TEXT` → `timestamptz` | 否 | — |

**28. `chat_messages`**（`packages/db/src/index.ts:283-287`，增量列 `:325-328`）— 主键 `id`；外键 `session_id → chat_sessions` CASCADE；**唯一索引** `chat_messages_seq(session_id, seq)`；索引 `chat_messages_by_session(session_id, created_at)`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `session_id` | `TEXT` → `text` | 否 | 外键 |
| `role` | `TEXT` → `text` | 否 | — |
| `content` | `TEXT` → `text` | 否 | — |
| `evidence_count` | `INTEGER` → `bigint` | 否 | `0` |
| `created_at` | `TEXT` → `timestamptz` | 否 | — |
| `seq` | `INTEGER` → `bigint` | 否 | `0` |
| `turn_id` | `TEXT` → `text` | 否 | `''` |
| `kind` | `TEXT` → `text` | 否 | `'message'` |
| `payload_json` | `TEXT` → `jsonb` | 否 | `'{}'::jsonb` |

**29. `memory_facts`**（`packages/db/src/index.ts:292-297`）— 主键 `id`；外键 `student_id → student_profiles` CASCADE；索引 `memory_facts_by_student(student_id, kind)`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `student_id` | `TEXT` → `text` | 否 | 外键 |
| `kind` | `TEXT` → `text` | 否 | — |
| `key` | `TEXT` → `text` | 否 | — |
| `value_json` | `TEXT` → `jsonb` | 否 | 任意 JSON（对象/数组/标量） |
| `confidence` | `REAL` → `double precision` | 否 | `0.7` |
| `source` | `TEXT` → `text` | 否 | `'chat'` |
| `updated_at` | `TEXT` → `timestamptz` | 否 | — |

**30. `memory_episodes`**（`packages/db/src/index.ts:300-305`）— 主键 `id`；外键 `student_id → student_profiles` CASCADE；索引 `memory_episodes_by_student(student_id, created_at)`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `student_id` | `TEXT` → `text` | 否 | 外键 |
| `session_id` | `TEXT` → `text` | 否 | `''` |
| `summary` | `TEXT` → `text` | 否 | — |
| `decisions_json` | `TEXT` → `jsonb` | 否 | `'[]'::jsonb` |
| `open_questions_json` | `TEXT` → `jsonb` | 否 | `'[]'::jsonb` |
| `created_at` | `TEXT` → `timestamptz` | 否 | — |

**31. `artifacts`**（`packages/db/src/index.ts:308-313`，增量列 `:379-383`）— 主键 `id`；外键 `student_id → student_profiles` CASCADE；索引 `artifacts_by_student(student_id, created_at)`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `student_id` | `TEXT` → `text` | 否 | 外键 |
| `session_id` | `TEXT` → `text` | 否 | `''` |
| `skill_id` | `TEXT` → `text` | 否 | — |
| `template_id` | `TEXT` → `text` | 否 | `''` |
| `type` | `TEXT` → `text` | 否 | — |
| `title` | `TEXT` → `text` | 否 | — |
| `format` | `TEXT` → `text` | 否 | — |
| `path` | `TEXT` → `text` | 否 | — |
| `content` | `TEXT` → `text` | 否 | — |
| `evidence_ids_json` | `TEXT` → `jsonb` | 否 | `'[]'::jsonb` |
| `created_at` | `TEXT` → `timestamptz` | 否 | — |
| `content_json` | `TEXT` → `jsonb` | 否 | `'{}'::jsonb` |
| `schema_version` | `TEXT` → `text` | 否 | `'Markdown@1'` |
| `version` | `INTEGER` → `bigint` | 否 | `1` |
| `status` | `TEXT` → `text` | 否 | `'ready'` |
| `source_refs_json` | `TEXT` → `jsonb` | 否 | `'[]'::jsonb` |

**32. `skills`**（`packages/db/src/index.ts:316-321`）— 主键 `id`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `expert_id` | `TEXT` → `text` | 否 | — |
| `name` | `TEXT` → `text` | 否 | — |
| `description` | `TEXT` → `text` | 否 | `''` |
| `input_schema_json` | `TEXT` → `jsonb` | 否 | `'{}'::jsonb` |
| `template_id` | `TEXT` → `text` | 否 | `''` |
| `enabled` | `INTEGER` → `boolean` | 否 | `1→true` |
| `updated_at` | `TEXT` → `timestamptz` | 否 | — |

**33. `turns`**（`packages/db/src/index.ts:340-352`）— 主键 `id`；**表内唯一约束** `UNIQUE(session_id, turn_id)`；索引 `turns_by_session(session_id, started_at)`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `id` | `TEXT` → `text` | 否 | 主键 |
| `session_id` | `TEXT` → `text` | 否 | 唯一约束列 |
| `turn_id` | `TEXT` → `text` | 否 | 唯一约束列 |
| `status` | `TEXT` → `text` | 否 | — |
| `plan_json` | `TEXT` → `jsonb` | 否 | `'{}'::jsonb` |
| `record_json` | `TEXT` → `jsonb` | 否 | `'{}'::jsonb` |
| `seq_start` | `INTEGER` → `bigint` | 否 | `0` |
| `seq_end` | `INTEGER` → `bigint` | 否 | `0` |
| `started_at` | `TEXT` → `timestamptz` | 否 | — |
| `finished_at` | `TEXT` → `timestamptz` | √ | 空串 → NULL |

**34. `learning_states`**（`packages/db/src/index.ts:355-362`）— 复合主键 `(student_id, chapter_id)`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `student_id` | `TEXT` → `text` | 否 | 复合主键 |
| `chapter_id` | `TEXT` → `text` | 否 | 复合主键 |
| `phase` | `TEXT` → `text` | 否 | — |
| `state_json` | `TEXT` → `jsonb` | 否 | — |
| `updated_at` | `TEXT` → `timestamptz` | 否 | — |

**35. `summary_ledger`**（`packages/db/src/index.ts:364-376`）— 复合主键 `(source_type, source_id)`；索引 `ledger_by_status(status, updated_at)`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `source_type` | `TEXT` → `text` | 否 | 复合主键 |
| `source_id` | `TEXT` → `text` | 否 | 复合主键 |
| `source_seq` | `INTEGER` → `bigint` | 否 | — |
| `summarized_seq` | `INTEGER` → `bigint` | 否 | `0` |
| `source_hash` | `TEXT` → `text` | 否 | `''` |
| `status` | `TEXT` → `text` | 否 | — |
| `summary_id` | `TEXT` → `text` | 否 | `''` |
| `attempts` | `INTEGER` → `bigint` | 否 | `0` |
| `last_error` | `TEXT` → `text` | 否 | `''` |
| `updated_at` | `TEXT` → `timestamptz` | 否 | — |

**36. `question_bank`**（`packages/db/src/index.ts:387-399`）— 主键 `question_id`；**唯一索引** `question_bank_stem(stem_hash)`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `question_id` | `TEXT` → `text` | 否 | 主键 |
| `stem_hash` | `TEXT` → `text` | 否 | 唯一 |
| `stem` | `TEXT` → `text` | 否 | — |
| `chapter_id` | `TEXT` → `text` | 否 | `''` |
| `kp_ids_json` | `TEXT` → `jsonb` | 否 | `'[]'::jsonb` |
| `type` | `TEXT` → `text` | 否 | — |
| `difficulty` | `INTEGER` → `bigint` | 否 | — |
| `source` | `TEXT` → `text` | 否 | `''` |
| `usage_count` | `INTEGER` → `bigint` | 否 | `0` |
| `created_at` | `TEXT` → `timestamptz` | 否 | — |
| `last_used_at` | `TEXT` → `timestamptz` | 否 | — |

**37. `kp_canonical_map`**（`packages/db/src/index.ts:428-433`）— 主键 `old_id`；索引 `kp_canonical_map_by_canonical(canonical_id)`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `old_id` | `TEXT` → `text` | 否 | 主键 |
| `canonical_id` | `TEXT` → `text` | 否 | — |
| `name` | `TEXT` → `text` | 否 | `''` |
| `created_at` | `TEXT` → `timestamptz` | 否 | — |

**38. `block_canonical_map`**（`packages/db/src/index.ts:436-441`）— 主键 `old_id`；索引 `block_canonical_map_by_canonical(canonical_id)`

| 列 | 源类型 → 目标类型 | 可空 | 默认 |
|---|---|---|---|
| `old_id` | `TEXT` → `text` | 否 | 主键 |
| `canonical_id` | `TEXT` → `text` | 否 | — |
| `reason` | `TEXT` → `text` | 否 | `''` |
| `created_at` | `TEXT` → `timestamptz` | 否 | — |

### 3.3 `verify` 的「一致」精确定义

一条记录被判为一致，必须同时满足以下三条；任一不满足即记为差异：

1. **行数 100% 相等**：§3.2 的 38 张表逐表 `SELECT count(*)`，源库与 PG 库行数完全相等。表名集合也必须一致：源库缺表或目标库多表均为退出码 2（结构问题），不计入 3。
2. **抽样字段比对**：每表按主键升序取前 `--sample`（默认 20）行；表内行数 ≤ 抽样数时全表比对。排序两侧显式钉到字节序（SQLite `COLLATE BINARY`、PG `COLLATE "C"`），保证两侧取到同一批行。双侧按同一主键集合配对，逐列比较：
   - `text` / 主键 / 哈希列：严格字符串相等；
   - `bigint` / `integer`：数值严格相等；
   - `double precision`：两侧相对误差 ≤ `1e-9`；
   - `jsonb`：PG 侧以 `col::text` 取回，与源库文本按「保留数字字面量的十进制精确比较」判等——对象键序不敏感、数组顺序敏感；`1` / `1.0` / `1e0` 视为同值，19 位整数与它的双精度近似值判为不同。空串按该列默认 JSON 归一后再比（与 migrate 共用同一归一函数）；
   - `timestamptz`：按 UTC 时刻相等，不比较显示字符串；源库空串与 PG `NULL` 等价；
   - `boolean`：真值严格相等。
3. **`news_articles` 哈希复算**：抽样行额外做两项校验——源库 `content_hash` 与 PG 库 `content_hash` 相等；用 PG 库 `content` 复算 `sha256(content).digest('hex')`，与该行 `content_hash` 相等。哈希口径来自 `packages/db/src/index.ts:2855` 与 `:2889`，只对正文 `content` 取哈希，不含标题、摘要或来源 [R7]。

第一处差异输出格式（单行，取值截断到 200 字符，超出加 `…`；取值内的 `\`、`\r`、`\n`、`\t` 分别转义为 `\\`、`\r`、`\n`、`\t`，保证证据行恒为单行）：

```text
[verify] DIFF table=<表名> pk=<主键列>=<主键值> column=<列名> source=<源值> target=<目标值>
[verify] HASH article=<文章 id> source=<源 content_hash> target=<PG 存储 content_hash> recomputed=<复算哈希>
```

`HASH` 行同时给出 `source` 与 `target`：两者相等而复算不符，说明正文被改；两者不等，说明 PG 侧哈希被改。只报 `source` 与 `recomputed` 时，这两个值相同却判不一致的情形无法定位篡改位置。

## 4 错误与消息

错误码与退出码对应 §2.5；中文消息逐字如下，`<…>` 为运行时替换位。消息只进 stdout/stderr 文本，不附带英文堆栈；内部 SQL 错误细节只写进工具自身日志行，不抛给调用方。

| 退出码 | 触发条件 | 中文消息（逐字） |
|---|---|---|
| 1 | 缺 `--source` | `缺少必填参数 --source：SQLite 源库路径。` |
| 1 | 源文件不存在 | `找不到源数据库文件：<path>。` |
| 1 | `--sample` 非 1..1000 整数 | `--sample 必须是 1 到 1000 的整数。` |
| 1 | 源路径命中受保护真实目录 | `源路径位于受保护的真实数据目录，请改用 .scratch/run/D/ 下的副本：<path>。` |
| 1 | `--apply` 与 `--dry-run` 同给 | `--apply 与 --dry-run 不能同时使用。` |
| 1 | 未知参数 | `未知参数 <token>（<入口>）。运行 node tools/migrate-pg/src/<入口> --help 查看支持的参数。` |
| 1 | 写操作命中非演练目标 | `拒绝在非演练目标上执行写操作：<差异项>。确认目标无误后加 --force-target 显式放行。` |
| 2 | PG 连接失败 | `无法连接 PostgreSQL：<原因>。请检查 PGHOST、PGPORT、PGUSER、PGPASSWORD。` |
| 2 | 源库 schema 版本非 7 | `源库 schema 版本为 <v>，预期 7；请先在桌面端或 seed 流程跑齐本地迁移。` |
| 2 | 源库缺表 | `源数据库缺少表 <table>。` |
| 2 | 注册表与源码结构漂移 | `注册表与源码结构漂移（<逐项差异>）。` |
| 2 | jsonb 列非法值 | `表 <table> 的列 <column> 不是合法 JSON（主键 <pk>）：<解析原因>。` |
| 2 | 时间戳列非 ISO 取值 | `时间戳列 <table>.<column> 存在非 ISO 取值（主键 <pk>）：<value>。` |
| 2 | `enabled` 非 0/1 | `表 skills 的列 enabled 只接受 0 或 1（主键 <pk>）：<value>。` |
| 2 | 装载 SQL 失败 | `装载表 <table> 失败：<SQL 原因>。` |
| 2 | 回滚事务失败 | `回滚事务失败，未删除任何表：<SQL 原因>。` |
| 3 | 行数不等 | `行数不一致：表 <table> 源 <n> 行，目标 <m> 行。` |
| 3 | 抽样字段不等 | `[verify] DIFF table=<表名> pk=<主键> column=<列名> source=<源值> target=<目标值>` |
| 3 | 哈希不符 | `[verify] HASH article=<id> source=<源哈希> target=<PG 哈希> recomputed=<复算哈希>` |
| 0（提示） | rollback 未确认 | `未执行删除：rollback 默认 dry-run；确认后加 --apply。` |

消息中的表名、列名、主键列名取自 §3.2 清单，不使用内部索引名；JSON 解析原因只给 `JSON.parse` 的异常文本，不打印整行数据 [R8]。

## 5 事件与序列

### 5.1 `migrate.js` 时序

装载通道与逐表行数汇报沿用 `COPY` 的批量语义，失败行定位到具体表 [R1]。

```text
t0  解析参数 → 校验源路径不在受保护目录 → 缺参/越界退出 1
t1  只读打开 SQLite → 读 user_version；非 7 退出 2
t2  枚举 §3.2 的 38 张表；源库缺表退出 2
t3  连接 PG；--dry-run 在此打印计划后退出 0，不写库
t4  建 schema：表 → 主键 → 外键 → 唯一约束/索引（单事务）
t5  按父表先于子表的拓扑序逐表 COPY；装载前完成 JSON 校验、时间戳转换、boolean 转换
t6  逐表输出 copy 行数；任一行转换失败中止该表，退出 2，已装载表不回滚源库（源库本就只读）
t7  输出 done 汇总，退出 0
```

### 5.2 `verify.js` 时序

```text
t0  解析参数 → 连接双侧；连接失败退出 2
t1  逐表 count(*) 比对；收集第一处行数差
t2  逐表抽样：主键升序取前 n 行，双侧按主键配对
t3  逐字段比对；jsonb 归一化、timestamptz 按时刻比较
t4  news_articles 抽样行复算 sha256(content) 并比对 content_hash
t5  全绿 → [verify] ok，退出 0；任一差异 → 打印第一处差异行，退出 3
```

### 5.3 `rollback.js` 时序

回滚在单事务内完成，失败整体回滚，不留下半删状态；清理范围仅限本轮登记表 [R6]。

```text
t0  解析参数；--apply 与 --dry-run 同给退出 1
t1  连接 PG；枚举工具登记的 38 张表（以 PG 实际存在为准）
t2  dry-run：按依赖逆序打印待删表清单 → 退出 0
t3  --apply：单事务内逆序 DROP TABLE；任一失败回滚事务 → 退出 2
t4  输出 dropped 清单，退出 0
```

## 6 兼容与版本

- **源库版本硬校验**：只接受 `user_version = 7`（`packages/db/src/index.ts:931`）；低于 7 说明本地迁移链未跑齐，工具不猜测补列。
- **幂等**：`migrate.js` 重复执行不产生重复行；缺省模式按主键 `ON CONFLICT DO UPDATE` 写冲突列 [R5]；`--rebuild` 先 DROP 再建。两次 `migrate` 之间不要求人工清库。
- **字段增删规则**：§3.2 清单以代码 schema 为唯一来源。后续 SQLite 侧加表/加列时，必须先更新本文件清单与工具表名集合，再改实现；不得在 PG 侧留未登记的孤儿表。
- **不迁移的对象**：源库无视图、无触发器、无虚表（已核对 `packages/db/src/index.ts` 全文）；PG 侧同样不建视图、触发器。`WITHOUT ROWID` 是 SQLite 存储子句，翻译时丢弃，不保留等价物。
- **运行时兼容**：本工具产物不被 A 轮运行时读取；运行时数据源仍是 SQLite。未来若切换运行时到 PG，属于另立契约的阶段，不在本文件 v1 范围。
- **与 G 轮的边界**：D 不做 `pg_dump` / `pg_restore`；G 轮备份演练连接的 PG 实例配置为 `55433` / `yxs-pg-g`，与本文件 §2.1 的 `55432` / `yxs-pg-d` 互不引用。

## 7 契约测试映射（给本轮自测与 E 轮对照）

| 契约点 | 自测编号 | 断言 |
|---|---|---|
| 迁移幂等 | `CT-D-01` | 同一源库连跑两次 `migrate.js`，`verify.js` 行数与抽样全绿，无重复行 |
| 一致副本校验通过 | `CT-D-02` | 未改动的副本上 `verify.js` 退出码 0，输出 `[verify] ok` |
| 改坏正文检出 | `CT-D-03` | 篡改 PG 侧一条 `content`，`verify.js` 退出 3，DIFF 行含表名、主键、列名 |
| 哈希复算检出 | `CT-D-04` | 只改 `content_hash` 不动正文，退出 3，输出 `[verify] HASH` 行 |
| 非法 JSON 拦截 | `CT-D-05` | 注入非 JSON 串到 `*_json` 列，`migrate.js` 退出 2，消息含表名、列名、主键 |
| 时间戳空串归一 | `CT-D-06` | 源库 `finished_at` / `reviewed_at` 为空串的行，PG 侧为 NULL，`verify.js` 一致 |
| rollback 默认不删 | `CT-D-07` | 不带 `--apply` 跑 `rollback.js`，38 张表仍在；dry-run 清单列全 38 张 |
| 参数错误 | `CT-D-08` | 缺 `--source` 退出 1；`--sample 0` 退出 1，消息逐字匹配 §4 |
| 版本不符 | `CT-D-09` | 构造 `user_version < 7` 的副本，`migrate.js` 退出 2 并提示预期 7 |
| 资源隔离 | `CT-D-10` | 工具配置只出现 `55432` / `yxs-pg-d` / `yxs-pg`；不引用 `55433` / `yxs-pg-g` |
| 外键顺序 | `CT-D-11` | 含子表数据的副本一次装载成功；去掉父表行时外键约束报错被定位到具体表 |

比对类工具的「先行数全量、再抽样内容、差异只报第一处」组织方式参照跨库比对工具的分层思路 [R9]；抽样确定性靠主键升序而非随机数，保证同一副本两次校验结果可复现 [R7]。

## 参考

- [R1] PostgreSQL `COPY` — https://www.postgresql.org/docs/current/sql-copy.html — 支撑 §1 与 §5.1 的批量装载通道 — 采用 `COPY … FROM STDIN` CSV 格式；不用 `text` 格式。
- [R2] PostgreSQL JSON 类型 — https://www.postgresql.org/docs/current/datatype-json.html — 支撑 §3.1 jsonb 映射与 §4 非法值拦截 — 采用 `jsonb`；本阶段不建 GIN 索引。
- [R3] SQLite 数据类型亲和性 — https://www.sqlite.org/datatype3.html — 支撑 §3.1 INTEGER/REAL 判定与混型风险 — 按列声明映射，不按值猜类型。
- [R4] SQLite STRICT tables — https://www.sqlite.org/stricttables.html — 支撑 §3.1 的 `NOT NULL` / `DEFAULT` 保留规则 — 逐列保留约束；不照搬 STRICT 表级语法。
- [R5] PostgreSQL `INSERT … ON CONFLICT` — https://www.postgresql.org/docs/current/sql-insert.html — 支撑 §2.2 幂等写入与 §6 重复执行口径 — 采用主键冲突更新；SQLite 侧仍用现有实现。
- [R6] PostgreSQL 事务与 `TRUNCATE` — https://www.postgresql.org/docs/current/sql-truncate.html — 支撑 §2.4 回滚删除范围 — 只 DROP 本轮登记表，禁止 `TRUNCATE` 共享库。
- [R7] precizer — https://github.com/precizer/precizer — 支撑 §3.3 校验的计数 + 哈希双保险思路 — 借鉴「全量计数 + 抽样校验和」；不引入其文件树扫描机制。
- [R8] OWASP REST Security Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html — 支撑 §4 错误消息最小披露 — 不把整行数据、SQL 原文带进用户可见消息。
- [R9] DBDiff/DBDiff — https://github.com/DBDiff/DBDiff — 支撑 §7 行数与内容分层比对 — 借鉴 schema/data 双层比对；不引入其 PHP 栈。
