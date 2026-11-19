# E · 契约测试

## 要实现

- `tools/contract-tests`：同一套断言跑 HTTP 服务端和本地 Electron。
- 每个服务端方法至少两条：合法输入断言响应结构；非法输入断言中文错误消息。
- 非法输入覆盖：缺字段、类型错、资源不存在、越权、未知方法。
- `coverage` 命令：核对 OpenAPI 覆盖 30 个服务端方法 + 5 个专用通道。
- 特殊通道覆盖：`chat` SSE 顺序、取消后停止、`answer`/`answer-set` 回读、`health` 无鉴权。
- 3 条 mutation：改错返回字段、改错错误消息、删掉 `done` 事件，对应用例必须变红。
- 支持 `--target http`、`--target electron`、`--target both`。

## 产出

```text
tools/contract-tests/
  src/cli.ts
  src/targets/http.ts
  src/targets/electron.ts
  src/schema/validate.ts
  src/cases/methods.ts
  src/cases/special.ts
  src/report.ts
  README.md
```
