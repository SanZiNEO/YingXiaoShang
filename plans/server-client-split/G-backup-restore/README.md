# G · 备份与恢复

## 要实现

- SQLite 备份：`.backup` 或 `VACUUM INTO`，不直接 `cp`。
- SQLite 恢复：恢复到临时路径或停服务后切换，恢复后做完整性检查。
- PostgreSQL 备份：`pg_dump --format=custom`。
- PostgreSQL 恢复：`pg_restore`。
- `drill`：备份 → 真删测试库 → 恢复 → 校验行数和 20 条抽样记录。
- 演练报告：时间、源、备份文件、删除方式、恢复耗时、校验结果。

## 产出

```text
tools/backup/
  backup.sh
  restore.sh
  drill.sh
  lib/sqlite.sh
  lib/pg.sh
  drill-report.md
  README.md
```
