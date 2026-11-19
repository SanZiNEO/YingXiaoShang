# 服务端 / 客户端模块

本目录按模块拆分。每个目录的 `README.md` 只写要实现什么。

| 目录 | 要实现 |
|---|---|
| `A-server-core/` | HTTP 服务端：登录、token、30 个业务方法、SSE、OpenAPI、日志、指标、Docker 镜像 |
| `B-news-quality/` | 新闻正文质量抽检脚本与按源质量报告 |
| `C-crawler-docker/` | 采集服务 Docker 镜像、全栈 compose、30 分钟调度 |
| `D-pg-migration/` | SQLite → PostgreSQL 迁移、双跑校验、回滚 |
| `E-contract-tests/` | HTTP / Electron 双目标契约测试与 OpenAPI 覆盖 |
| `F-loadtest-observability/` | 40–60 并发压测、P50/P95/P99、按学生 token、告警 |
| `G-backup-restore/` | SQLite / PostgreSQL 备份、恢复、真删演练 |
| `H-electron-mutation/` | 5 条 Electron 用例的 mutation 验证 |
| `I-miniprogram-mock/` | 小程序 5 页纯 mock UI |
