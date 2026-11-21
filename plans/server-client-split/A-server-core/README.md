# A · 服务端骨架

## 要实现

- 新建 `apps/server`，提供 HTTP + SSE 服务。
- 登录：学号 + 口令；密码 scrypt 哈希；token 随机 32 字节，可登出。
- 预留 CAS / OAuth2 回调路由，本阶段返回 501。
- 所有业务请求从 token 解析 `studentId`，不信任请求体里的 `studentId`。
- 资源归属校验：会话、题目集必须校验属于当前学生。
- 实现 30 个服务端业务方法，统一走 `POST /api/v1/rpc`。
- 实现 `chat` SSE、`cancel`、`answer`、`answer-set`、`health`。
- 生成 OpenAPI 3：`docs/contracts/openapi.yaml`，覆盖 30 个方法 + 5 个专用通道。
- 输出结构化请求日志：请求 id、学生 id、方法、耗时、错误分类。
- 输出 `/metrics`：请求数、耗时、token、错误、`SQLITE_BUSY`。
- 写 `apps/server/Dockerfile`，可被 compose 引用。
- 写 mock LLM 和五步 smoke：登录 → 提问 → 出题 → 交卷 → 查档案。

## 30 个服务端方法

```text
student.current
chapters.list
kps.list
news.list
news.status
news.refresh
news.get
news.match
questions.attempts
profile.get
profile.growth
profile.evidence
profile.snapshot
profile.review
artifacts.list
artifacts.get
artifacts.export
memory.facts
memory.episodes
memory.summary
memory.upsert
memory.delete
chat.sessions
chat.messages
agent.snapshot
agent.suggestions
agent.turns
agent.ledger
agent.retry
agent.sessions
```

## 不放进服务端

```text
files.reveal
files.preview
files.openDialog
settings.get
settings.set
```

## 产出

```text
apps/server/
docs/contracts/openapi.yaml
```
