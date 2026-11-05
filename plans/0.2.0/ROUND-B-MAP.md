# B 轮派单：最小原生链路跑通

> 依据：[`ROUND-A-CONCLUSION.md`](ROUND-A-CONCLUSION.md) 的挂载清单与顺序。
> 本轮目标：**在真实环境里跑通一次「发一句话 → 流式返回 → 自然结束」**，不接业务。
> 探针放仓库外 `G:/市场营销ai/probe/a0-dsh/`，**不入库**。

## 〇、本轮口径

1. **先探针后产品**：先在仓库外用 `node` 跑通，再接 Electron。React 层的问题不能混进来。
2. **不接受「挂上了」当跑通**：服务可见 ≠ 一轮对话成立。必须真的收到模型返回。
3. **失败也要留证据**：报错原文、复现命令、已试过的方案，全部写进本文件。
4. 不设固定轮次/时长（沿用审计 §4.4.3）。

## 一、任务清单

| 编号 | 目标 | 验收 | 状态 |
|---|---|---|---|
| B1 | 按 A 轮顺序把原生插件挂起来 | 8 个插件 `✅`，`ctx.llm/sessions/tools/agents/systemPrompt/sessionProjections` 全部可见 | ✅ 通过 |
| B2 | 建一个 agent 并拿到句柄 | `ctx.agents.create({sessionId, agentOptions})` 返回 `{agent, dispose}`，句柄方法含 `followup/steer/inject/cancel/whenIdle/kick` | ✅ 通过 |
| B3 | 发一句话收到模型返回 | `followup(...)` 后 `whenIdle()` 结束，且拿到非空 assistant 文本 | ❌ **阻塞**，见 §3 |
| B4 | 带一个工具跑通 `tool_use → 执行 → end_turn` | 事件里出现工具调用与结果，最终 `end_turn` | ☐ 待 B3 |
| B5 | 取消 | `cancel()` 后不再发新请求、不再起新工具，已出文字保留 | ☐ 待 B3 |
| B6 | 事件接到界面 | `started / stream / tool start / tool end / terminal` 齐全且 `terminal` 恰好一次 | ☐ 待 B3 |

## 二、B1 / B2 已确认的事实（可复用）

**插件形状不统一**，必须 `m.default ?? m`：

| 包 | 导出形状 |
|---|---|
| `dsh-llm` / `dsh-session` / `dsh-system-prompt` / `dsh-tools` / `dsh-agent` / `dsh-agent-loop` | `default` 是类（`LlmRuntime` / `SessionStore` / `SystemPrompt` / `ToolRuntime` / `AgentRegistry` / `AgentLoop`） |
| `dsh-llm-deepseek-api-key` | **没有 default**，模块命名空间本身带 `apply` |

**根上下文**：`new Context()`（`@deepseek-ai/cordis` 没有 `App` 导出），挂载用 `ctx.plugin(plugin, config)`。

**注入依赖**（`AgentLoop.inject`）：`agents`、`sessions`、`llm`、`tools`、`systemPrompt`、`sessionProjections`。

**创建 agent**：README 里的 `agents.create({ ... })` 是对象式；`create(id, options)` 那种签名会让
session id 与 agent id 对不上（实测报 `agent id "undefined" does not match session id "session-1"`）。

## 三、B3 阻塞点（2026-11-04）

**现象**：

```
phase = running
❌ agent/error: Cannot read properties of undefined (reading 'kind')
❌ agent/error: messages: at least one message is required (request_id: ...)
kick 完成
```

**已确认**：`followup({content:[{type:'text',text:'…'}]})` 确实进了收件箱——
`session/event` 里能看到 `agent/inbox/spliced`，`inserted` 内容就是我们发的那句。

**推断**：收件箱里的消息没有被折叠成派生历史，所以组装请求时 `messages` 为空；
`reading 'kind'` 是同一路径上更早的一次失败（某个 projection / unit 的 `phase` 为 undefined）。
两个错误是同一个根因的两个症状。

**已试过（都无效）**：补挂 `cordis-plugin-timer`、`dsh-llm-retry`、
`dsh-session-projection-cache`、`dsh-agent-preset`。

**下一步（按成本排序）**：

1. 读 `dsh-agent-loop/lib/index.js` 里派生历史的实现，定位 `.kind` 读取点，反查缺哪个 service（约 30 分钟，最可能一次定位）。
2. 对照 `dsh-sdk-app` 的启动路径：它可能注册了某个 projection 或 initiator，这是 `sdk-minimal` 能跑而探针不能跑的原因。
3. 退路：`npm approve-scripts` 放行 `node-pty`，用 `dsh --profile sdk-minimal` 跑通一次，把它的运行时配置树打印出来对照。

**注意**：不要为了绕过这个错误去改产品代码或自写循环——那正是审计 §4.3.2 禁止的。

## 四、B3 通过后立刻要验的五条

1. 首字延迟（`assistant-stream` 第一个 delta 的时间）。
2. `terminal` 是否恰好一次。
3. `stop_reason` 是否原样保留（`end_turn` / `tool_use` / `max_tokens`）。
4. 重启后 `resume` 同一 session 能否继续。
5. token 用量与 chat/completions 端点对照（A2 残留项）。
