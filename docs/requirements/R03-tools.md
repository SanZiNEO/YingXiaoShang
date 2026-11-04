# R03 工具层

> 状态：MVP（本轮）
> 依赖：[R01](R01-single-agent.md)
> 代码：`packages/agent/src/tools/`、`packages/agent/src/tool-loop.ts`
> 上位原则：[`../principles/single-agent.md`](../principles/single-agent.md)

## 1. 要什么（学生可见结果）

- 学生说一句话，营小商能自己取到需要的东西：知识点、教材原文、手册、新闻，并把结果做成页面或题目集。
- 取不到就说「资料不足」，不拿目录或常识冒充原文。
- 一次取太多会截断，并明确告诉模型还剩多少、下一步该怎么换参数；不把整本书塞进上下文。
- 学生看不到工具名、调用次数、参数和返回；只看到最终回复与右栏产物。

## 2. 落位（提示词 / 工具 / skill / 数据）

| 层 | 承担什么 |
|---|---|
| 工具 | 真实数据、副作用、结构化结果：读材料、查新闻、写页面、出题 |
| 提示词 | 什么时候用哪个工具、用完怎么收口（[R02](R02-prompt.md)） |
| skill / 手册 | 工具取回材料之后「怎么做到合格」（[R04](R04-skills.md)） |
| 数据 | 工具只通过 `learningDb` 与 `ctx` 访问数据；不直连文件、不拼 SQL |

工具不认识「消费者行为」这类业务概念，也不判断学生意图；它只把材料摊开，选哪个由模型决定。

## 3. 行为（一轮里怎么发生）

1. `agentTools(turn)` 把 `AGENT_TOOLS` 的声明绑到本轮状态，模型看到 name / description / parameters。
2. 模型发起调用；`runAgentLoop()` 按 name 在**本轮工具清单**里查找，找不到就返回错误文本。
3. 同一轮里的多个调用并行执行；相同 `name + args` 的调用走缓存，不重复执行。
4. 工具返回字符串；`retainToolOutput()` 按字节预算保留头尾，超长部分附省略说明。
5. 结果作为 `tool` 消息进入 `messages`，模型下一轮基于它继续。
6. 写类工具把内容收进 `emit.pending`，本轮结束由 `finalizeArtifacts()` 统一校验、落库。
7. 轮次用尽时只保留写类工具再要一次结果；读类工具关闭，避免无限查资料。

## 4. 契约

```ts
// packages/agent/src/tools/types.ts
export interface ToolSpec {
  name: string
  kind: 'read' | 'write'
  description: string
  parameters: Record<string, unknown>   // JSON Schema
  execute: (args: Record<string, unknown>, turn: ToolContext) => string | Promise<string>
}
```

`ToolContext` 由主循环组装一次，工具自己不持有状态：

```ts
interface ToolContext {
  ctx: Context
  chapterId: string
  citations: Citation[]
  reads: ReadLedger
  emit: EmitContext
  firstTime(key: string): boolean   // 本轮首次交付 → true
  seen(key: string): boolean        // 纯查询，不产生副作用
  chapterBlocks(): ChapterBlock[]
  cite(citation: Citation): void
}
```

现有清单（以 `read-tools.ts` / `write-tools.ts` 为准）：

| 类别 | 工具 | 参数 | 有界返回 |
|---|---|---|---|
| 读 | `list_chapter_kps` | `chapterId?` | 全章知识点，每个一行 |
| 读 | `read_kp` | `name` | 一个知识点的定义、别名、例子、非例子 |
| 读 | `read_textbook` | `kps?`（≤4）、`kp?`、`query?`、`limit?`（1–6） | 每个知识点最多 6 段原文 |
| 读 | `read_material` | `kps`（1–4）、`query?`、`limit?`（1–4） | 整次返回 ≤ 12,000 字符 |
| 读 | `read_reference` | `name`（7 份之一） | 单份手册全文（当前最大 4,269 字符） |
| 读 | `search_news` | `query?`、`limit?`（1–20） | 候选标题、来源、日期、摘要 |
| 读 | `read_news` | `id?`、`title?` | 正文 ≤ 4,000 字符 |
| 写 | `write_page` | `title?`、`html`、`sourceRefs?` | 收进产物，返回一句确认 |
| 写 | `emit_question_set` | `title?`、`content`、`markdown?`、`sourceRefs?` | 收进产物，返回题目数 |

白名单与边界：

- 只有 `AGENT_TOOLS` 里的工具可被调用；没有 shell、没有任意命令、没有任意 URL 抓取。
- 工具名与参数由声明自描述；模型看到的就是全部，不需要额外文档。
- 读工具自己写 `turn.reads` 与 `turn.cite`；写工具只调 `collect(turn.emit, spec, args)`。
- 对外说人话：`emit_question_set` 收知识点中文名，内部 id 由 `resolveKpIds()` 翻译。

错误返回形态（一律返回文本，不向学生抛栈）：

| 情况 | 返回 |
|---|---|
| 未知工具 | `未知工具：<name>` |
| 缺参数 | `缺少参数 name。` |
| 找不到知识点 | `当前章节里没有找到知识点「x」。可先调用 list_chapter_kps。` |
| 找不到手册 | `没有这份资料：x。可选：a / b / …` |
| 工具抛错 | `工具执行失败：<message>` |
| 参数被 token 上限截断 | `工具执行失败：参数太长……不要重写整份：把内容拆成 2–3 次调用` |

有界策略：

- 单次工具结果上限 36,000 字节（`LEARNING_AGENT_TOOL_MAX_BYTES` 可覆盖）；超了保留头尾，附「省略 N 字节。需要这部分就换更窄的参数重读，不要原样重试。」
- 本轮工具结果总量超过 48,000 字符（`LEARNING_AGENT_TURN_TOOL_MAX_CHARS` 可覆盖）时，旧结果被裁到 4,096 头 + 1,024 尾，插入 `[... tool result middle pruned ...]`。
- 单工具自身也要有上限：新闻正文 4,000 字符、`read_material` 12,000 字符；新增工具必须声明自己的上限。

加一个工具的步骤：

1. 选 `kind`：只取材料写 `read`，落产物写 `write`。
2. 在 `read-tools.ts` 或 `write-tools.ts` 加一条 `ToolSpec`；`AGENT_TOOLS` 自动收录，不改 `packages/agent/src/tools/index.ts`。
3. 参数用 JSON Schema；`description` 写清「什么时候用」和「返回什么」。
4. 读工具写 `reads` / `cite`；写工具复用 `ArtifactSpec` + `collect`。
5. 在 `agents/mentor.md` 的手册/工具表里加一句何时用（不是必需，但推荐）。
6. 不改 `tool-loop.ts`、`team.ts`、`packages/agent/src/tools/types.ts` 的调度逻辑。

## 5. 边界（不做什么、失败怎么表现）

- 不做：shell、任意命令、任意 URL 抓取、文件系统任意读写。
- 不让工具持有本轮状态；状态只从 `ToolContext` 传入。
- 不把业务判断写进工具：工具不判断「学生是不是要产物」，只提供能力。
- 不在工具里按品牌、章节、关键词写特例；需要特例说明它其实是 skill 或数据。
- 失败一律返回可读文本；工具内部异常由 `runCalls` 捕获，转成 `工具执行失败：…`。
- 超长不静默：必须出现省略说明与恢复建议；否则视为验收失败。

## 6. 验收（场景 → 期望）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 新增一个 `read_section` 工具，只改 `read-tools.ts` 并在提示词加一句 | 模型能调用；`tool-loop.ts`、`team.ts`、`packages/agent/src/tools/index.ts` 无需改动；`trace.toolCalls` 正常计数 |
| 2 | 模型调用一个未注册的工具名 | 返回 `未知工具：x`；本轮不崩溃；模型能改调已注册工具 |
| 3 | 读一份超长教材 | 返回头尾 + 「省略 N 字节」；模型按建议换窄参数，而不是原样重试 |
| 4 | 工具抛异常 | 返回 `工具执行失败：…`；聊天里不出现英文堆栈；本轮其余工具结果不受影响 |
| 5 | 写类工具参数被截断 | 返回「参数太长，拆成 2–3 次」；模型拆分后系统合并，不产生重复题目 |
| 6 | 轮次用尽 | 只保留 `write_page` / `emit_question_set` 再要一次结果；读工具不再可用 |

## 7. 现状与差距（代码事实）

| # | 事实 | 位置 |
|---|---|---|
| 1 | `ToolSpec` 已定义 name / kind / description / parameters / execute | `packages/agent/src/tools/types.ts:51-58` |
| 2 | `toAgentTool()` 把声明绑到本轮状态，`write` 标记由 `kind === 'write'` 得出 | `packages/agent/src/tools/types.ts:61-69` |
| 3 | `AGENT_TOOLS` 是读写清单的合并，加工具只加声明 | `packages/agent/src/tools/index.ts:13` |
| 4 | `createToolContext()` 组装本轮状态；`firstTime` / `seen` / `cite` 都在这里 | `packages/agent/src/tools/index.ts:39-66` |
| 5 | 读工具 7 个、写工具 2 个 | `packages/agent/src/tools/read-tools.ts:18`、`packages/agent/src/tools/write-tools.ts:95` |
| 6 | 新闻正文硬上限 4,000 字符；`read_material` 整次截 12,000 字符 | `packages/agent/src/tools/read-tools.ts:12`、`:288` |
| 7 | 单次工具结果 36,000 字节、头尾保留；本轮总量 48,000 字符后裁剪旧结果 | `packages/agent/src/tool-loop.ts:9`、`:12`、`:25` |
| 8 | 旧结果裁剪阈值 8,192 字符，保留 4,096 头 + 1,024 尾 | `packages/agent/src/tool-result-pruner.ts:18-22` |
| 9 | 未知工具、执行失败、参数截断都有固定文案 | `packages/agent/src/tool-loop.ts:297`、`:324`、`:327` |
| 10 | 同一轮多个工具并行执行，相同 name + args 走缓存 | `packages/agent/src/tool-loop.ts:273-350` |
| 11 | 轮次用尽时只给写类工具再开一轮 | `packages/agent/src/tool-loop.ts:360`、`:391-396` |
| 12 | `read_textbook` 有 per-kp 段数上限，但没有整次返回的字符上限 | `packages/agent/src/tools/read-tools.ts:91-190` |
| 13 | `read_news` 直接截到 4,000 字符，不附「省略多少」的说明 | `packages/agent/src/tools/read-tools.ts:394` |

## 8. MVP 范围与后续

**MVP 做到哪**

- 保持现有 9 个工具（7 读 + 2 写）与 `ToolSpec` 契约。
- MVP 新增 3 条声明，全部按本节步骤加，不改调度：[R04](R04-skills.md) 的 `read_skill`、[R07](R07-news.md) 的 `ingest_news`、[R13](R13-growth-card.md) 的 `read_growth`；加完共 12 个。
- 后续新增（不排期）：`verify_quote`、`search_case_cards`（[R10](R10-case-lesson.md)）、`read_artifact`（[R15](R15-artifacts.md)）。
- 给每个读工具补齐整次返回上限（尤其是 `read_textbook`），统一走有界返回。
- 统一错误文案：缺参、找不到、超长、内部异常四类，学生侧只看到最终人话。
- 写工具继续走 `ArtifactSpec` + `collect`；新增写能力必须先有 schema，不直接写文件。
- 删除工具层的业务特例；工具只做「取」和「写」。

**后续留什么**

- 工具结果的结构化摘要（例如「读了 3 个知识点、2 段原文」）用于 trace，不返回给模型。
- 读工具的批量取材料能力（一次多个知识点）继续保留，减少往返。

**明确不做**

- shell、任意命令、任意 URL 抓取、任意文件读写。
- 让工具自己决定「该不该产附件」或「该由谁回答」。
- 为某个品牌、某条新闻、某一章写工具分支。
