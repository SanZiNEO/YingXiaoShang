# 03 · 公共参考库（真实链接）

> 铁律：**文档里出现的每一个外部 URL，必须来自本文件，或来自你自己用 `magpie` GitHub 搜索 / 官方文档站当场查到的结果。**
> 不许凭记忆写 URL，不许写 `example.com` 占位，不许写「详见某文」而不给链接。
>
> 搜索方法（照做，不要自创）：**一次只用一个关键词、用通用词、不要带领域限定。**
> 例：`openapi`、`jsonrpc`、`loadtest`、`backup`、`stryker`、`pgloader`、`sse`、`compose`。
> 反例（不要这么做）：`education learning platform server client split`、`marketing course RAG` —— 这个领域没人做，限定越多越搜不到可借鉴的东西。

## 1. 通用（九轮都可能用）

| 编号 | 参考 | URL | 用来支撑什么 | 借鉴 / 不照搬 |
|---|---|---|---|---|
| [R1] | OpenAPI Specification 仓库 | https://github.com/OAI/OpenAPI-Specification | A/E：契约文档形态、`paths`/`components` 组织 | 用它的结构；**不**用 3.1（工具链差异，冻结 3.0.3） |
| [R2] | OpenAPI 3.0.3 规范正文 | https://spec.openapis.org/oas/v3.0.3 | A：响应 schema、错误对象建模 | 只取 `requestBody`/`responses`；不引入 `$ref` 远程引用 |
| [R3] | JSON-RPC 2.0 规范 | https://www.jsonrpc.org/specification | A：单端点方法分发、错误对象字段 | 借鉴「method + params + id + error{code,message}」；**不照搬** JSON-RPC 的 batch 与 notification（我们不做批量） |
| [R4] | fastapi | https://github.com/fastapi/fastapi | A：从类型生成 OpenAPI、SSE 写法、依赖注入式鉴权 | 借鉴「schema 由类型生成」；我们不用 Python 栈，只借结构 |
| [R5] | full-stack-fastapi-template | https://github.com/fastapi/full-stack-fastapi-template | A/C：Docker Compose + 健康检查 + 反代布局 | 借鉴 compose 分层与 healthcheck；**不**引入前端容器与 JWT 体系 |
| [R6] | 12-Factor · Logs | https://12factor.net/logs | A/F：日志当事件流、stdout 单行 JSON | 直接采用；不引入日志聚合服务 |
| [R7] | OWASP REST Security Cheat Sheet | https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html | A/E：鉴权、越权、错误信息不泄漏 | 采用「不区分登录失败的两种原因」；不引入 API key 体系 |
| [R8] | OWASP Session Management Cheat Sheet | https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html | A：token 生命周期、注销、过期 | 采用「服务端可撤销 + 短期过期」；不用 cookie session（客户端是 Electron/小程序） |
| [R9] | Node.js `crypto` 文档（scrypt） | https://nodejs.org/api/crypto.html | A：口令哈希参数与 `timingSafeEqual` | 采用 `N=16384,r=8,p=1,keylen=64`；不自己发明 KDF |

## 2. A · 服务端骨架

| 编号 | 参考 | URL | 用来支撑什么 | 借鉴 / 不照搬 |
|---|---|---|---|---|
| [R10] | Server-Sent Events（WHATWG 规范） | https://html.spec.whatwg.org/multipage/server-sent-events.html | A/E：`text/event-stream` 帧格式、`id`/`retry`、断线语义 | 采用 `event:`/`data:`/`id:`；**不**实现自动重连与 Last-Event-ID 重放 |
| [R11] | MDN · Using server-sent events | https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events | A：心跳注释行、代理缓冲坑 | 采用 15s `: keep-alive` 与 `X-Accel-Buffering: no`；不做 polyfill |
| [R12] | jsonrpc（Rust 实现） | https://github.com/paritytech/jsonrpc | A：方法注册表与未知方法处理 | 借鉴「未知方法返回结构化错误而非 500」；不引入其传输层 |
| [R13] | ybbus/jsonrpc（Go 客户端） | https://github.com/ybbus/jsonrpc | A：客户端调用形态、错误解包 | 借鉴错误对象；不引入其重试策略 |
| [R14] | fastapi-jsonrpc | https://github.com/smagafurov/fastapi-jsonrpc | A：单端点 + OpenAPI 共存的做法 | 借鉴「RPC 也能出 OpenAPI」；不照搬其 ASGI 依赖 |
| [R15] | Insomnia（API 客户端，支持 SSE） | https://github.com/Kong/insomnia | A/E：手工验 SSE 的工具与交互预期 | 仅作为验证工具；不作为依赖 |
| [R16] | Yaak（API 客户端） | https://github.com/mountain-loop/yaak | E：SSE/HTTP 手工回归 | 同上 |
| [R17] | RFC 6749（OAuth 2.0） | https://www.rfc-editor.org/rfc/rfc6749 | A：预留回调路由的字段与错误码命名 | 只借 `error`/`state` 命名；本阶段返回 501，不实现授权码流 |
| [R18] | PostgreSQL `INSERT … ON CONFLICT` | https://www.postgresql.org/docs/current/sql-insert.html | A/D：`memory.upsert` 的幂等写法（PG 侧） | 借鉴 upsert 语义；SQLite 侧仍用 `packages/db` 现有实现 |

## 3. B · 新闻正文质量

| 编号 | 参考 | URL | 用来支撑什么 | 借鉴 / 不照搬 |
|---|---|---|---|---|
| [R19] | trafilatura | https://github.com/adbar/trafilatura | B：正文抽取质量的评价维度（长度、导航噪声、重复） | 借鉴「正文/导航词/去重」三类指标；不引入其抽取器 |
| [R20] | python-readability | https://github.com/buriy/python-readability | B：正文≈摘要这类退化形态的识别 | 借鉴「正文与摘要高度重叠 = 抽取失败」的判据 |
| [R21] | newspaper | https://github.com/codelucas/newspaper | B：按源统计与样本抽样展示 | 借鉴报告结构；不引入其抓取栈（我们已有 crawler） |
| [R22] | SQLite STRICT tables | https://www.sqlite.org/stricttables.html | B：读库时字段可空性假设 | 用于说明 `NOT NULL DEFAULT ''` 下「空标题」怎么判 |

## 4. C · 采集服务 Docker 化

| 编号 | 参考 | URL | 用来支撑什么 | 借鉴 / 不照搬 |
|---|---|---|---|---|
| [R23] | Docker 官方 Python 镜像 | https://hub.docker.com/_/python | C：`python:3.12-slim` 选型与体积基线 | 采用 slim；不装 Playwright（冻结：镜像里不含浏览器） |
| [R24] | Dockerfile 参考（`USER`/`HEALTHCHECK`） | https://docs.docker.com/reference/dockerfile/ | C：非 root、健康检查、`ENTRYPOINT` | 采用 `USER 10001` 与 `HEALTHCHECK`；不用 `--platform` 多架构 |
| [R25] | Docker 多阶段构建 | https://docs.docker.com/build/building/multi-stage/ | C：依赖层与代码层分离，减小体积 | 采用两阶段（builder 装 wheel / runtime 只装运行时） |
| [R26] | Compose 服务定义（healthcheck/depends_on/volumes） | https://docs.docker.com/reference/compose-file/services/ | C：compose 写法与健康依赖 | 采用 `healthcheck`+`depends_on: condition: service_healthy`；不用 `deploy.replicas` |
| [R27] | Compose profiles | https://docs.docker.com/reference/compose-file/profiles/ | C：`crawler`/`full` 两档并行验收 | 直接采用 |
| [R28] | 12-Factor · Logs | https://12factor.net/logs | C：容器日志走 stdout，不写文件 | 复用 [R6]，不重复引用 |

## 5. D · SQLite → PostgreSQL 迁移

| 编号 | 参考 | URL | 用来支撑什么 | 借鉴 / 不照搬 |
|---|---|---|---|---|
| [R29] | pgloader | https://github.com/dimitri/pgloader | D：SQLite→PG 的映射表与坑（类型、布尔、空串） | 借鉴「类型映射表 + 批量 COPY + 统计」；**不用**它跑迁移（要可审计、可 verify、可 rollback） |
| [R30] | PostgreSQL `COPY` | https://www.postgresql.org/docs/current/sql-copy.html | D：批量导入格式、`HEADER`、`NULL` 表示 | 采用 `COPY … FROM STDIN WITH (FORMAT csv, HEADER true)`；不用 `text` 格式（转义坑多） |
| [R31] | PostgreSQL JSON 类型 | https://www.postgresql.org/docs/current/datatype-json.html | D：`TEXT` 存 JSON → `jsonb` | 采用 `jsonb`；不做 GIN 索引（本阶段不查 JSON） |
| [R32] | SQLite 数据类型 | https://www.sqlite.org/datatype3.html | D：亲和性与「TEXT 里存数字」的现实 | 用于解释为什么要按列声明而不是按值猜 |
| [R33] | PostgreSQL 事务与 `TRUNCATE` | https://www.postgresql.org/docs/current/sql-truncate.html | D：rollback 的清理口径 | 采用「先 dry-run 打印，再 `DROP TABLE` 本次创建的表」；**禁止** `TRUNCATE` 共享库 |

## 6. E · 契约测试

| 编号 | 参考 | URL | 用来支撑什么 | 借鉴 / 不照搬 |
|---|---|---|---|---|
| [R34] | Playwright | https://playwright.dev/docs/intro | E/H：断言、fixture、失败取证 | 采用 fixture + 证据落盘；不用其快照测试 |
| [R35] | Playwright Electron | https://playwright.dev/docs/api/class-electron | E/H：`_electron.launch`、主进程求值 | 采用；但 spec 不得直接 `import _electron`（沿用仓库现有约束） |
| [R36] | JavaScript Testing Best Practices | https://github.com/goldbergyoni/javascript-testing-best-practices | E：测试结构、避免固定等待、契约测试分层 | 采用「禁止 sleep、用轮询断言」；不引入其全部工具链 |
| [R37] | OpenAPI 校验思路（Redocly CLI 文档） | https://redocly.com/docs/cli | E：OpenAPI lint/覆盖检查的可行手段 | 借鉴「先 lint 再比对覆盖」；不引入其云服务 |
| [R38] | bruno | https://github.com/usebruno/bruno | E：把用例存成可读的请求集合 | 仅作对照；我们的用例是代码不是 GUI 集合 |

## 7. F · 压测与可观测性

| 编号 | 参考 | URL | 用来支撑什么 | 借鉴 / 不照搬 |
|---|---|---|---|---|
| [R39] | k6 文档 | https://grafana.com/docs/k6/latest/ | F：VU 模型、阈值、结果汇总 | 借鉴「场景 = VU 脚本 + 阈值」；不引入 k6 运行时（用 Node 自研，便于复用登录逻辑） |
| [R40] | Gatling | https://github.com/gatling/gatling | F：场景编排与报告字段（P50/P95/P99） | 借鉴报告结构；不引入 Scala |
| [R41] | alexfernandez/loadtest | https://github.com/alexfernandez/loadtest | F：轻量并发模型与延迟直方图 | 借鉴「并发数 + 每秒统计」；不照搬其 CLI |
| [R42] | Prometheus 告警实践 | https://prometheus.io/docs/practices/alerting/ | F：告警该报什么、`for` 的意义 | 采用「症状告警 + for 抑制抖动」；不做因果推断类告警 |
| [R43] | Prometheus 告警规则语法 | https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/ | F：`alerts.yml` 可被 `promtool` 校验 | 直接采用；字段名不得自创 |
| [R44] | Prometheus 直方图与分位数 | https://prometheus.io/docs/practices/histograms/ | F：P95/P99 必须由 histogram 算，不能平均值 | 直接采用 `histogram_quantile`；禁止用 `avg` 代替分位数 |

## 8. G · 备份与恢复

| 编号 | 参考 | URL | 用来支撑什么 | 借鉴 / 不照搬 |
|---|---|---|---|---|
| [R45] | SQLite Online Backup API | https://www.sqlite.org/backup.html | G：`.backup` 为什么不能用 `cp` | 直接采用；`cp` 会拿到半写状态 |
| [R46] | SQLite `VACUUM INTO` | https://www.sqlite.org/lang_vacuum.html | G：无 sqlite3 CLI 时的等价备份 | 采用 `VACUUM INTO` 兜底 |
| [R47] | SQLite `PRAGMA integrity_check` | https://www.sqlite.org/pragma.html#pragma_integrity_check | G：恢复后完整性校验 | 采用 `quick_check` + `integrity_check` 双档 |
| [R48] | `pg_dump` | https://www.postgresql.org/docs/current/app-pgdump.html | G：custom 格式、一致性快照 | 采用 `--format=custom`；不用 `--format=plain`（无法并行恢复） |
| [R49] | `pg_restore` | https://www.postgresql.org/docs/current/app-pgrestore.html | G：恢复、`--clean` 的风险 | 采用「恢复到新库」；**禁止** `--clean` 直接打生产库 |
| [R50] | pgBackRest | https://pgbackrest.org/ | G：保留策略、校验思路 | 借鉴「备份要可验证」；不引入其 repo 体系 |
| [R51] | restic | https://github.com/restic/restic | G：备份产物命名与保留策略 | 借鉴 `host/path/timestamp` 命名；不引入加密仓库 |

## 9. H · Electron mutation

| 编号 | 参考 | URL | 用来支撑什么 | 借鉴 / 不照搬 |
|---|---|---|---|---|
| [R52] | Stryker JS | https://github.com/stryker-mutator/stryker-js | H：mutation 的「改坏一处 → 用例必须红」范式 | 借鉴范式与报告字段；**不引入** Stryker 运行时（我们手动维护 5 个 patch） |
| [R53] | Stryker 文档 | https://stryker-mutator.io/docs/ | H：mutant 状态（killed/survived）与报告口径 | 采用 killed/survived 术语；不做全量 mutant 扫描 |
| [R54] | Playwright Electron | https://playwright.dev/docs/api/class-electron | H：用例启动与断言 | 复用 [R35] |

## 10. I · 小程序 mock

| 编号 | 参考 | URL | 用来支撑什么 | 借鉴 / 不照搬 |
|---|---|---|---|---|
| [R55] | 微信小程序设计指南 | https://developers.weixin.qq.com/miniprogram/design/ | I：375 宽度、点击区域、页面结构惯例 | 借鉴尺寸与信息层级；**不引入**小程序框架/构建链（纯静态 HTML） |
| [R56] | MDN 响应式设计 | https://developer.mozilla.org/en-US/docs/Learn/CSS/CSS_layout/Responsive_Design | I：不横向滚动的布局约束 | 采用 `max-width:100%`、`overflow-wrap`、`min-width:0` |
| [R57] | MDN `prefers-reduced-motion` | https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion | I：动效降级 | 采用；不做复杂动画 |

## 11. 引用写法（照这个格式）

正文里：

```markdown
登录失败不区分「学号不存在」和「口令错」[R7]，口令用 scrypt 存储 [R9]。
```

文末：

```markdown
## 参考

- [R7] OWASP REST Security Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html — 支撑 §3 鉴权与错误信息 — 采用「不区分失败原因」。
- [R9] Node.js crypto — https://nodejs.org/api/crypto.html — 支撑 §3.1 scrypt 参数 — 采用 N=16384,r=8,p=1。
```

规则：

- 编号在同一份文档内**连续且唯一**；跨文档不要求一致（各文档自带编号表）。
- 每个二级节至少 1 个 `[Rn]`；引用要落在**具体论断**后面，不要堆在段落末尾当装饰。
- 一条参考只写一次完整信息；正文后续复用同编号即可。
- 不用脚注语法（`[^1]`），统一 `[Rn]`。
