# R18 模型运行时

> 状态：MVP（本轮）
> 依赖：R01（单主循环）、R17（Key 与设置落盘）
> 代码：`apps/desktop/src/main/llm.ts`、`apps/desktop/src/main/settings.ts`、`apps/desktop/src/main/env.ts`、`apps/desktop/src/main/index.ts`、`packages/agent/src/tool-loop.ts`
> 上位原则：[`../principles/single-agent.md`](../principles/single-agent.md)

## 1. 要什么（学生可见结果）

- 一轮对话只有一个模型通道，字边生成边出现，不等整段写完。
- 没配 Key 时，界面说一句能照做的中文（去「设置」填 Key），不出现英文报错与调用栈。
- Key 失效、调用太频繁、网络断掉时，各给一句人话，并且明确这一段没有记成学生的作答。
- 设置里能填 Key、能改模型名；环境变量配置的 Key 永远优先，并且界面上说清楚「当前生效的是哪一个」。

## 2. 落位（提示词 / 工具 / skill / 数据）

属于**运行时**：既不是提示词，也不是工具或 skill。

- 提示词里不写 Key、不写模型名、不写 endpoint；模型不知道自己被谁调用。
- 工具层不直接发 HTTP：只通过 `ctx.llm.stream()`。
- 主循环（`tool-loop.ts`）负责把流拼成文本与工具调用，不关心 provider 细节。
- Key 与模型的存储是数据：`settings.json`（Electron `userData`）+ `process.env`。

## 3. 行为（一轮里怎么发生）

1. 主进程启动：`loadDotEnv` 依次读 `process.cwd()`、仓库根、appPath 的 `.env`，只补未设置的变量（`apps/desktop/src/main/env.ts:8-27`；调用点 `apps/desktop/src/main/index.ts:42-46`）。
2. `SettingsStore.read()` 合成生效配置：Key 取 `DEEPSEEK_API_KEY` 或本机文件；模型取 `DEEPSEEK_MODEL`、本机文件、`deepseek-chat` 三级（`apps/desktop/src/main/settings.ts:24-30`）。
3. 主循环每轮调 `ctx.llm.stream({ system, messages, tools, maxTokens })`（`packages/agent/src/tool-loop.ts:232-240`）；桌面端适配器把消息改写成 DeepSeek 线格式后 POST `/chat/completions`（`apps/desktop/src/main/llm.ts:92-124`）。
4. 适配器逐行解析 SSE：文本增量先发 `block-start` 再发 `text-delta`；工具调用按 `index` 累积 `id/name/arguments`，结束时补一条完整 `tool-call`；`[DONE]` 或 `finish_reason` 收尾（`llm.ts:126-198`）。
5. 主循环用 `BlockAssembler` 组装，并把写成正文的 DSML 调用捞回来当工具调用执行（`tool-loop.ts:241-277`）。
6. 异常冒泡到 IPC 边界，`friendlyError` 翻译成中文再交给界面（`apps/desktop/src/main/index.ts:376-391`）。

## 4. 契约（工具签名、数据结构、字段、命令）

**生效配置的优先级**

| 项 | 高 → 低 | 默认 |
|---|---|---|
| API Key | `process.env.DEEPSEEK_API_KEY` → `settings.json.apiKey` | 空 |
| 模型 | `process.env.DEEPSEEK_MODEL` → `settings.json.model` → `deepseek-chat` | `deepseek-chat` |
| 服务地址 | `process.env.DEEPSEEK_BASE_URL` → `https://api.deepseek.com` | 官方地址（`llm.ts:84-87`） |

`.env` 被灌进 `process.env` 后与系统环境变量同级；系统里已有的值优先（`env.ts:26`）。

**设置文件**

- 路径：`app.getPath('userData')/settings.json`。
- 字段：`{ apiKey: string, model: string }`；写盘时保留未提供的字段，`clearApiKey` 只清本机 Key（`settings.ts:43-58`）。
- 对外只暴露 `PublicSettings { hasApiKey, model, apiKeySource: 'env' | 'stored' | 'none' }`，不回传 Key 本身（`settings.ts:5-10`）。
- IPC：`learning:settings:get` / `learning:settings:set`（`apps/desktop/src/main/index.ts:461-462`）。

**适配器接口**

```ts
class DeepSeekLlm {
  constructor(settings: () => DeepSeekSettings)
  stream(options: {
    messages: readonly LlmMessage[]
    system?: string
    maxTokens?: number
    temperature?: number
    tools?: readonly LlmTool[]
    signal?: AbortSignal
  }): AsyncIterable<StreamChunk>
  chat(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): Promise<string>
}
```

- 请求体：`model`、`messages`、`max_tokens`（默认 4096）、`temperature`（默认 0.2）、`stream: true`、`stream_options.include_usage`；有工具时附 `tools` 与 `tool_choice: 'auto'`（`llm.ts:95-120`）。
- 工具结果必须一条 `role: 'tool'` 对应一个 `tool_call_id`（`llm.ts:44-57`）。
- 主循环实际传 `maxTokens: 8192`（`packages/agent/src/team.ts:209-211`）。

**错误 → 中文提示**

| 上游特征 | 界面文案 |
|---|---|
| `DEEPSEEK_API_KEY is not configured` / `请先在设置中填写` | 还没配置模型密钥：点左下角「设置」填入 DeepSeek Key 后再发一次。 |
| `401` / `invalid api key` / `unauthorized` | 模型密钥无效或已过期，请在「设置」里重新填写。 |
| `429` / `rate limit` | 模型调用太频繁了，等几秒再发一次。 |
| `timeout` / `aborted` / `ETIMEDOUT` / `ECONNRESET` | 模型响应超时，这一段没有记成你的作答，可以直接重发。 |
| 其余 | 原文透传（现状，见第 7 节） |

## 5. 边界（不做什么、失败怎么表现）

- 只支持一个 provider（DeepSeek）。不做多模型路由、不做按意图选模型。
- 不在代码里写死模型名：默认值 `deepseek-chat` 只在「什么都没配」时生效；界面可改。
- 不上传 Key、不落日志、不回传渲染进程；设置页只显示来源。
- 不做自动重试：失败就是失败，提示学生重发（现状）。
- 流中断：已显示的字留在界面，该轮不写 assistant 消息；用户消息已入库，重发会产生新的用户消息。
- 无 Key 的降级：
  - 聊天：直接失败并给中文提示，不产生假回复。
  - 新闻匹配：`LLM_FALLBACK` 命中后走确定性三阶段召回（`packages/matcher/src/index.ts:43`、`:185-190`）。
  - 新闻抓取补充：`deepSeekFetch` 无 Key 直接返回 `undefined`（`packages/news/src/index.ts:139-142`）。
  - 课程检索、题目校验、规则候选不依赖模型，照常可用。
- 超时：适配器只把调用方给的 `signal` 透传给 `fetch`（`llm.ts:121`），主循环当前不传（`tool-loop.ts:232-239`）；没有显式超时。

## 6. 验收（场景 → 期望）

1. **没配 Key**：清空 `.env` 与本机 Key → 发一句话 → 界面只出现「还没配置模型密钥…」，控制台无英文栈，聊天区不出现 `Error invoking remote method`。
2. **Key 无效**：填 `sk-invalid` → 发一句话 → 出现「模型密钥无效或已过期…」，不是 `DeepSeek API 401: {...}`。
3. **流中断**：设 `DEEPSEEK_BASE_URL=http://127.0.0.1:1` 启动 → 发一句话 → 出现可读失败提示；界面不崩，重发不产生重复 assistant 消息。
4. **环境变量优先**：本机存 Key A，启动时设 `DEEPSEEK_API_KEY=B` → 设置页显示「当前生效的是环境变量」；点「清除本机 Key」后仍能正常对话。
5. **模型生效**：设 `DEEPSEEK_MODEL=deepseek-chat`、本机文件写别的模型名 → `learning:settings:get` 返回 `deepseek-chat`；界面「模型」输入框显示同一个值。
6. **流式可见**：发一个长回答请求 → 第一个字在整段结束前出现（用真 Key 真跑，不用假模型）。

## 7. 现状与差距（代码事实）

| 事实 | 位置 |
|---|---|
| Key/模型三级回退 | `apps/desktop/src/main/settings.ts:24-30` |
| 对外设置结构（含 `apiKeySource`） | `apps/desktop/src/main/settings.ts:5-10`、`:32-41` |
| endpoint 读 `DEEPSEEK_BASE_URL` | `apps/desktop/src/main/llm.ts:84-87` |
| 无 Key 抛英文错误，由上层翻译 | `llm.ts:94`、`index.ts:379-381` |
| 真流式 SSE 解析（文本 + 工具调用 + usage） | `llm.ts:126-198` |
| 主循环不传 `signal` | `packages/agent/src/tool-loop.ts:232-239` |
| 主循环 maxTokens 8192、最多 10 轮 | `packages/agent/src/team.ts:222-224` |
| 单轮路由常量写 `deepseek-flash` | `packages/llm-json/src/index.ts:9-12`、`tool-loop.ts:232-234` |
| 适配器忽略路由里的 `model`，只用设置里的模型 | `llm.ts:95-96` |
| 新闻服务自带 DeepSeek 地址，不走 `DEEPSEEK_BASE_URL` | `packages/news/src/index.ts:96`、`:142` |
| `chat()` 当前无调用方（仅定义） | `apps/desktop/src/main/llm.ts:204-224` |

差距：

1. **路由模型名与生效模型名不一致**：`DEFAULT_ROUTE.model = 'deepseek-flash'`、profile 补丁也写 `deepseek-flash`，但桌面适配器用设置里的 `deepseek-chat`。要么统一成一个来源，要么删掉路由里的模型名，否则读代码的人会以为实际跑的是 flash。
2. **没有超时**：`fetch` 不设 `signal` 时，网络半死会让一轮挂很久；`friendlyError` 的超时分支只有在底层抛 `aborted/timeout` 时才生效。
3. **兜底错误原样透传**：未命中的错误直接 `new Error(stripped)`，仍可能是英文（如 DNS 失败、证书错误）。
4. **`.env.example` 未列 `DEEPSEEK_BASE_URL`**，而代码会读它；`营小商-代码卫生检查-v0.1.md` 第 3 节第 4 条已记录。
5. **`chat()` 是死代码**：无调用方，且错误文案与 `stream()` 不一致。
6. **新闻的搜索/抓取地址写死**：本地假服务只能覆盖聊天通道，新闻通道无法用同一套配置验证。
7. **没有 token 预算提示**：`usage` 事件被适配器发出，但界面只显示调用次数（`App.tsx:1381`）。

## 8. MVP 范围与后续

**MVP 做到哪**

- 一个 DeepSeek 通道、真流式、工具调用解析、Key 优先级、设置读写、五类中文错误提示、无 Key 的降级路径。
- 验收见第 6 节六条。

**后续**

- 统一模型来源（删路由里的 `model`，或让适配器接受 `options.model` 并在设置页暴露同一字段）。
- 显式超时（首字节超时 + 整轮超时），超时后把「已收到的字」与「没记成作答」分开呈现。
- 兜底错误加一层「可执行提示」白名单（网络、证书、磁盘满）。
- `usage` 显示 token 用量，用于本地成本自检。
- 删 `chat()`，或让它复用 `stream()`。

**明确不做**

- 多 provider、自动切换、按任务选模型、模型降级链。
- 在提示词里注入模型名或 Key。
- 把 Key 写进仓库、日志、产物或数据库。
- 用假模型/桩回复做「行为验收」（见 [R20](R20-run-verify.md)）。

相关：[R01 单一智能体](R01-single-agent.md)、[R17 本地数据](R17-local-data.md)、[R20 运行与验收](R20-run-verify.md)。
