# D · SQLite → PostgreSQL 迁移

## 要实现

- `migrate`：把 `learning.db` 导入 PostgreSQL。
- schema 映射：TEXT→text、INTEGER→bigint、REAL→double precision、JSON 列→jsonb。
- 批量导入用 `COPY`。
- 幂等：同一源重复跑，不重复插入。
- `verify`：逐表比行数 + 抽样内容 hash；不一致非零退出，打印第一处差异。
- `rollback`：默认 dry-run，确认后清理本次创建的表。
- 回滚说明。
- 只做迁移工具，不改 `packages/db` 的运行时 SQL 方言。

## 产出

```text
tools/migrate-pg/
  src/cli.ts
  src/schema-map.ts
  src/copy.ts
  src/verify.ts
  src/hash.ts
  src/tables.ts
  sql/schema.sql
  sql/rollback.sql
  README.md
```
