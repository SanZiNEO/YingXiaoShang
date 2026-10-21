# 营小商：Codex 式多 Agent 路由 v0.4

> 日期：2026-10-19  
> 产品：**营小商**（山东大学威海商学院市场营销专业）  
> 状态：本轮路由/编排实现基线。本文补充 v0.2 的“主 Agent 判断、子 Agent 干活、ChatAgent 说话”约束，不替代 v0.2 的对话规范和 v0.3 的案例/部署基线。  
> 范围：只改“一轮消息怎么判断、调谁、怎么并行、怎么留痕”。不改产物契约、案例内容、ChatAgent 的说话职责。

---

## 0. 一句话结论

**主线程只做判断、编排和最终说话；子 Agent 只做有界工作；读步骤可以并行，写步骤必须串行；每次路由决策写进 `TurnPlan.routing`，在右栏“过程”里可查。**

这不是把 Codex 的 subagent 机制整套搬进营小商，而是只取其中四条对教学对话有用的约束：

1. 主线程不被中间结果污染；
2. 子 Agent 的任务边界要窄；
3. 读操作并行、写操作串行；
4. 编排过程要可检查。

---

## 1. Codex 官方做法（调研摘要）

### 1.1 主线程负责需求、决策与最终输出

Codex 的 subagent 文档把主线程的职责写得很清楚：主 Agent 保持在**需求、约束、决策和最终输出**上，把探索、测试、日志分析这类噪声大的工作移交给子 Agent。否则主对话会被探索笔记、测试日志、堆栈和命令输出填满，出现 context pollution / context rot，越到后面越不可靠。

子 Agent 返回的是**摘要**，不是原始中间输出。这样主线程拿到的是可用于决策的结论，而不是一堆需要再次阅读的材料。

来源：[Subagents – Codex](https://developers.openai.com/codex/subagents)

### 1.2 读密集任务并行，写密集任务谨慎

官方建议把并行 Agent 优先用于读密集任务：代码库探索、测试、triage、总结。对写密集工作流要更谨慎，因为多个 Agent 同时改同一批文件会产生冲突，协调成本会上升。

这条经验对营小商的映射不是“多个子 Agent 同时改文件”，而是：

- **读步骤**（查知识点、收集证据、解释概念）可以同时跑；
- **写步骤**（生成题目集、调研设计、BP 目录、成长卡、案例精讲、新闻抓取/分析）会落产物或写库，必须串行。

### 1.3 子 Agent 返回摘要，不回传原始过程

Codex 的 subagent 结果由主线程收集后进入最终回复；子 Agent 的线程可以被打开检查，但主线程不需要吞下全部原始输出。官方还把“返回 summary 而不是 raw intermediate output”列为 subagent 工作流的主要收益之一。

### 1.4 自定义 Agent 的字段与边界

Codex 的自定义 Agent 是独立 TOML 文件，放在 `~/.codex/agents/`（个人）或 `.codex/agents/`（项目）。每个文件必须定义：

| 字段 | 作用 |
|---|---|
| `name` | Agent 名称，Codex 用它来 spawn 和引用 |
| `description` | 面向人的“什么时候该用这个 Agent” |
| `developer_instructions` | 定义 Agent 行为的核心指令 |

可选字段包括 `model`、`model_reasoning_effort`、`model_reasoning_summary`、`model_verbosity` 等模型设置；也可以通过 feature 开关和 `skills.config` 收窄能力。官方给的建议是：**最好的自定义 Agent 是窄而明确的**——一个清楚的职责、匹配职责的工具面、防止它漂移到相邻工作的指令。

权限方面，自定义 Agent 继承父级的 permissions、provider 和 MCP servers，不能用 Agent 文件覆盖 `sandbox_mode`、`approval_policy`、`model_provider`、`mcp_servers`；沙箱和审批设置在父会话上统一设置。

来源：[Subagents – Agent configuration](https://developers.openai.com/codex/agent-configuration/subagents)

### 1.5 编排会等待、汇总，线程可检查

Codex 负责 spawn、转发后续指令、等待结果和关闭线程。多个 Agent 同时运行时，Codex 会等所有请求的结果都可用，再返回一个 consolidated response。桌面端、CLI 和 IDE 都能打开子 Agent 线程检查进度和结果；CLI 用 `/subagents` 切换线程。

审批和沙箱也由父级继承：子 Agent 继承父轮次的 sandbox 和 approval 设置，包括 `/permissions` 或 `--yolo` 的改动；自定义 Agent 文件不能替换这些设置。非交互流程中如果需要新的审批而无法弹出，动作会失败并把错误回传给父工作流。

### 1.6 模型与推理档位用于平衡成本/质量

Codex 允许在 spawn 时、`[agents]` 默认值或自定义 Agent 文件里指定模型和 `model_reasoning_effort`。未指定时子 Agent 继承父级的模型和推理档位；只指定模型而未指定推理档位时，使用该模型的默认档位。官方给出的取向是：重的、模糊的、多步骤工作用更强的模型/更高推理；快扫、窄范围、重复性工作用更快更便宜的模型。

来源：[Subagents – Choosing models and reasoning](https://developers.openai.com/codex/agent-configuration/subagents)

### 1.7 对营小商的直接启示

| Codex 做法 | 营小商对应 |
|---|---|
| 主线程只做需求/决策/最终输出 | 主 Agent 只产出 `TurnPlan`；ChatAgent 只负责最终回复 |
| 子 Agent 做有界工作 | 8 个专业子 Agent，职责写进 `AgentSpec.whenToUse` |
| 读并行、写串行 | `TurnStep.mode` + 执行器：read 并发，write 按计划顺序串行 |
| 子 Agent 返回摘要 | 子 Agent 只返回 `SubagentResult`；原始检索结果不进 ChatAgent |
| 自定义 Agent 的 name/description/instructions | `AgentSpec` 的 `name` / `description` / `whenToUse` |
| 编排等待并汇总、线程可检查 | 等待所有步骤结束再交给 ChatAgent；`routing` + 过程 tab |
| 权限继承 | 子 Agent 不单独申请权限；沿用当前会话的 LLM/工具配置 |
| 模型档位平衡成本/质量 | 本轮**不做** per-agent 模型档位，只用“何时调用 LLM 路由”控制成本 |

---

## 2. 营小商采纳的路由模型

### 2.1 总流程

```text
学生消息
→ 规则判断（确定性，默认路径）
   - 生成规则 TurnPlan
   - 明确产物请求 / 追问 / 诊断 → 直接使用规则计划
   - chat / explain / news 或多意图 → 进入受限 LLM 路由
→ 受限 LLM 路由（只在需要时）
   - 输入：消息 + 压缩状态 + AgentSpec 目录
   - 输出：JSON 计划片段（校验通过才采用）
   - 6 秒超时；任何失败 → 回到规则计划
→ 计划校验（registry + 执行策略）
→ 执行
   - read 步骤并行
   - write 步骤串行
   - dependsOn 未满足的步骤等待
→ ChatAgent 汇总成一条回复
→ 写 TurnPlan.routing / TurnRecord
```

关键约束：

- **规则判断是默认路径，也是安全兜底。** 明确产物请求和追问不调用路由 LLM；开放对话（`chat`/`news`）仍可能咨询一次。规则计划已经包含 `knowledge` 步骤时也不再咨询路由，避免把明确的“为什么/是什么”改写成案例或空计划。
- **LLM 只做路由，不做执行、不写回复、不调用工具。** 它返回的是计划片段，不是给学生看的文本。
- **校验不通过就当路由失败。** 不允许“模型说能跑就跑”。
- **ChatAgent 仍是唯一说话人。** 子 Agent 不直接对学生说话。

### 2.2 `AgentSpec` 注册表

注册表在 `packages/agent/src/registry.ts`，是“路由能选谁、谁是读/写、产出什么 schema、什么时候用”的唯一来源。字段：

```ts
interface AgentSpec {
  name: SubagentName
  description: string
  mode: 'read' | 'write'
  skills: string[]
  outputSchema: string
  whenToUse: string
}
```

注册表当前登记 8 个 Agent（其中 `feedback` 设计上只用于交卷链路，不参与普通轮次路由）：

| Agent | mode | 何时用（`whenToUse` 摘要） | 输出 schema |
|---|---|---|---|
| `knowledge` | `read` | 学生问“是什么/为什么/怎么理解”，需要先建立概念框架；只读，不产出文件 | `KnowledgeExplanation@1` |
| `case` | `write` | 学生要案例、举例，或要把概念落到真实情境并生成案例精讲 | `CaseStudy@1` |
| `question` | `write` | 学生明确要出题、练习、测验、几道题；不用于泛泛的概念解释 | `QuestionSet@1` |
| `research` | `write` | 学生要做调研、问卷、访谈、抽样或研究设计 | `ResearchDesign@1` |
| `bp` | `write` | 学生提到商业计划书、BP、创业计划或商业模式梳理 | `BpOutline@1` |
| `growth` | `write` | 学生问学得怎么样、复盘、评估、进步 | `GrowthCard@1` |
| `news_lab` | `write` | 学生给新闻链接、要求分析新闻/报道，或要求根据最新消息分析 | `NewsLab@1` |
| `feedback` | `write` | 只用于答题反馈链路，不用于普通对话规划 | `Feedback@1` |

补充说明：

- `plan` 是 `SubagentName` 里的内部占位，不在可路由注册表中；普通轮次不会把 `plan` 作为步骤派发。
- `feedback` 虽然登记为 write，但正常轮次不应选它；它只通过 `answerQuestion` 的交卷链路执行。`validatePlanSteps()` 会直接拒绝把 `feedback` 排进普通轮次，路由 prompt 里也有同样的约束。
- `knowledge` 是唯一的 read Agent；其余会落产物或写库的 Agent 都是 write。
- 注册表还导出 `routingCatalog()`，把每个 Agent 的 `name/mode/skills/schema/用途/何时用` 压成紧凑目录，供 LLM 路由 prompt 使用。

### 2.3 确定性规则判断：默认与兜底

规则判断由 `JudgeAgent` 承载，输入是消息、`LearningStateSnapshot` 和上一轮 `TurnPlan`。它负责：

- 判断 phase / scope / intent；
- 判断是直接聊、追问，还是调用子 Agent；
- 生成 `TurnPlan.steps`；
- 处理 pending（诊断、调研澄清、BP 澄清）；
- 在没有必要时不调用路由模型。

规则路径的特征：

- **可预测**：同样的状态和消息得到同样的计划；
- **无额外路由延迟**：不增加一次 LLM 路由往返（ChatAgent 的回复生成另算）；
- **可测试**：`pnpm test:router` 可以直接断言计划；
- **可兜底**：LLM 路由超时、返回非法 JSON、选了未知 Agent、违反读写约束时，回到规则计划。

规则判断不追求覆盖所有说法。它覆盖高频、边界清楚的请求；开放对话（`chat`/`explain`/`news`）、模糊和多意图请求交给下一节的受限 LLM 路由。

### 2.4 受限 LLM 路由

#### 触发条件

是否咨询 LLM 路由由 `shouldConsultRouter(rulePlan, message)` 决定：

```ts
if (rulePlan.decision === 'ask') return false
if (RULE_ONLY_INTENTS[rulePlan.intent]) return false
if (rulePlan.intent === 'chat' || rulePlan.intent === 'explain' || rulePlan.intent === 'news') return true
return MULTI_INTENT_PATTERN.test(message) // /并|顺便|同时|再.*(?:题|分析|案例|解释)/
```

其中 `RULE_ONLY_INTENTS` 包含 `practice`、`research`、`bp`、`growth`、`news_lab`、`diagnose`、`plan`。

因此：

- **不咨询**：规则已经明确要追问（`decision='ask'`）；或明确出题、调研、BP、成长卡、新闻抓取/分析、诊断、计划。这些请求由规则直接排步骤。
- **咨询**：规则只判到 `chat`、`explain`、`news`；或消息命中多意图模式（“并 / 顺便 / 同时 / 再……题|分析|案例|解释”）。
- 明确案例请求如果被规则判成 `case`，不在 `RULE_ONLY_INTENTS` 中，但也不在 `chat/explain/news` 里，只有命中多意图模式才会咨询 LLM。
- 明确单意图（出题/调研/BP/成长卡/新闻抓取/诊断/计划）不会额外调用路由模型。
- 注意：`chat` 意图一律咨询 LLM，所以简单寒暄也可能触发一次路由调用；这是当前实现的成本点，见 §5.1。

#### 输入

- 学生当前消息；
- 压缩后的状态摘要（phase、phaseConfidence、scope、plan、evidence 计数/覆盖/最近两条、artifacts、signals），不塞完整历史；
- `routingCatalog()` 生成的 Agent 目录；
- 上一轮计划摘要（intent、decision、steps 的 `agent:mode` 列表）。

不把原始聊天全文、完整产物正文、题库内容塞进路由 prompt。

#### 输出

模型只返回 `intent`、`reason`、`steps` 三个字段；`steps` 对应 `TurnStepSchema` 的计划片段。示意：

```json
{
  "intent": "research",
  "reason": "学生先要概念解释，再要一份调研设计",
  "steps": [
    {
      "id": "s1",
      "agent": "knowledge",
      "skill": "knowledge.explain",
      "mode": "read",
      "dependsOn": [],
      "input": { "query": "消费者市场" }
    },
    {
      "id": "s2",
      "agent": "research",
      "skill": "research.design",
      "mode": "write",
      "dependsOn": ["s1"],
      "input": { "brief": "消费者市场调研" }
    }
  ]
}
```

#### 硬约束

| 约束 | 规则 |
|---|---|
| 超时 | 6 秒；超时后不再等待并回退，不无限等待（不保证取消底层 LLM 调用） |
| 输出 | prompt 要求纯 JSON；解析器允许代码块围栏和前后缀，但围栏内/首个 `{` 到最后一个 `}` 之间必须是可解析的 JSON 对象 |
| 工具 | 路由阶段不调用任何工具 |
| 步骤数 | 1–3 步 |
| read 步骤 | 最多 2 步 |
| write 步骤 | 最多 1 步 |
| 顺序 | write 必须放在最后一步 |
| Agent | 必须是注册表中的 `name` |
| mode | 可省略；若提供，必须与注册表一致，不允许模型把 write 改成 read |
| dependsOn | 只能引用前面已经出现的步骤，天然排除环 |
| input | 必须是对象 |
| 失败 | 超时、非法 JSON、未知 Agent、mode 不符、超过步数、依赖非法 → 回退规则计划 |

校验由 `validatePlanSteps()` 统一执行；校验通过后，步骤的 `skill` 缺省取该 Agent 的第一个 skill，`outputSchema` 和 `mode` 以注册表为准，不信任模型自报值。

#### 失败语义

- LLM 返回非法结果：不重试、不“修 JSON 再试一次”，直接回退，避免把一次路由拖成多次模型调用。
- 回退后仍使用规则计划；`routing.strategy` 记为 `fallback`，`reason` 为“路由器未返回有效计划”，`elapsedMs=0`。
- 路由失败不影响本轮对话：ChatAgent 仍然要给出可读回复。
- 规则直接命中时，`routing.strategy` 记为 `rule`，`reason` 为“规则命中”，`elapsedMs=0`。

### 2.5 执行策略

执行器按 `TurnPlan.steps` 运行：

1. **先算依赖。** `dependsOn` 只允许引用前面的步骤；执行前按 id 建立结果表，未完成的依赖不会被当作已完成。
2. **read 成批并行。** 每一轮循环取出所有“依赖已满足”的 read 步骤，用 `Promise.all` 一起执行；每个 read 拿到的是本批次开始前已完成的结果快照。校验保证 read 最多 2 个，所以实际并发上限就是 2。
3. **write 串行。** 没有就绪 read 时，按计划顺序取第一个就绪 write 执行；一个 write 结束并落完产物后，才进入下一轮循环。校验保证 write 最多 1 个且必须在最后，但执行器不依赖“校验应该没问题”。
4. **结果按计划顺序返回。** 并行执行不改变结果顺序；最终 `results` 按 `plan.steps` 原顺序排列，ChatAgent 看到的序列稳定。
5. **失败不伪造成功。** 单个步骤抛错时记录到 `errors`，不写入结果表；依赖它的步骤永远不就绪，循环结束时报告“步骤 … 依赖未完成”。无依赖的其他步骤仍可继续。
6. **产物串行创建。** 一批 read 并行结束后，按该批次顺序逐个创建产物；write 也是执行完立即创建。避免同一 turn 内产物 id/排序竞争。
7. **统一汇总。** 所有步骤结束后，才把结果交给 ChatAgent；ChatAgent 拿到的是各步骤的 `content`、最多 4 条截断引用和压缩后的产物内容，不是子 Agent 的原始检索过程或中间日志。

`routing.parallel` 的口径是**计划层面**：只有通过校验的 LLM 计划包含 2 个及以上 read 步骤时才为 `true`。规则计划和回退计划一律为 `false`；单个 read 或纯 write 计划也为 `false`。

### 2.6 路由轨迹

`TurnPlan.routing` 使用共享契约 `RoutingTraceSchema`：

```ts
interface RoutingTrace {
  strategy: 'rule' | 'llm' | 'fallback'
  reason: string
  candidates: string[]
  parallel: boolean
  elapsedMs: number
}
```

| 字段 | 含义 |
|---|---|
| `strategy` | `rule`：规则直接给出计划；`llm`：LLM 结果通过校验并被采用；`fallback`：尝试过 LLM 但失败，回退到规则计划 |
| `reason` | 一句话说明为什么这样路由；规则路径为“规则命中”，回退路径为“路由器未返回有效计划”，LLM 路径用模型给出的理由（缺省为“LLM 路由器选择步骤”） |
| `candidates` | 计划中每个步骤的 Agent 名称，按步骤顺序排列；不是“所有考虑过但没选的 Agent” |
| `parallel` | 计划中是否有 2 个及以上 read 步骤；规则/回退恒为 `false` |
| `elapsedMs` | LLM 路由从发起到校验完成的耗时；规则/回退为 `0`。不是整轮执行耗时 |

写入位置：

- `TurnPlan.routing` 随 `plan_json` 写入 `turns`；
- 右栏“过程 / 记录”读取最近一轮的 `routing`，显示策略标签（规则/LLM/兜底）、用时、候选、原因、步骤序列；
- 历史 turn 列表同样显示策略标签，便于回看某轮为什么走了某条路径。
- `routing` 在 schema 中是 optional；旧 turn 没有该字段时，过程面板不显示路由区块，历史列表也不显示策略标签。

`routing` 只记录决策摘要，不记录完整 prompt、模型原始输出或子 Agent 中间日志。这样既够排查，也不会把内部提示词和原始材料带进学生可见区域。

### 2.7 ChatAgent 仍是唯一说话人

路由只决定“谁去干活”，不决定“谁对学生说话”。

- 子 Agent 返回 `SubagentResult`：`content`、`citations`、`evidenceCandidates`、`artifactDrafts`、`warnings`；
- ChatAgent 读取状态、计划、各步骤 `content`、截断后的引用和压缩产物内容，生成最终回复；
- 子 Agent 不直接写聊天消息，不直接面对学生，不做追问；
- 路由的 `reason` 也不直接展示成聊天文本，只出现在过程面板。

这条约束与 v0.2 一致：**主 Agent 不拼长文本，ChatAgent 不决定调谁，子 Agent 不说话。**

### 2.8 对话连续性（本轮补充）

路由不是“每轮重新开始”。本轮把最近对话显式带进三个位置：

1. **RouterAgent**：读取最近 8 条 user/assistant 消息；追问（“那…呢 / 再 / 继续 / 为什么 / 它”）要沿用上一轮主题，不能因为句子短就退回普通聊天。
2. **ChatAgent**：`chat`、`ask/plan`、`synthesize` 三种模式都收到最近 10 条消息；系统提示要求“先接上一轮的具体结论，再补新增部分，不要重新开场或复述整份产物”。
3. **子 Agent**：`StepContext.recentMessages` 可用；`KnowledgeAgent` 对短追问会把上一条用户消息拼进检索 query；`CaseCoach` 会识别当前消息提到的知识点，返回 `focusKpIds`，聊天兜底只展开被追问的那一个知识点，而不是重复三张卡。

效果示例：

```text
学生：用胖东来案例讲消费者
学伴：消费者 / 消费者市场 / 学习 三张卡

学生：那学习呢
学伴：接着上一轮，只把「学习」落到案例里；不重复消费者市场
```

边界：最近消息只用于当前轮决策和说话，不替代 `summary_ledger` / `memory_episodes`；长会话仍靠记录 Agent 的摘要压缩，不把全部历史塞进 prompt。

---

## 3. 本轮明确不采纳

| 不采纳 | 原因 | 什么时候再评估 |
|---|---|---|
| 子 Agent 之间自由对话/协商 | 教学对话需要可控、可解释；自由协商会把延迟和不确定性放大，也会让“谁说的”变得模糊 | 出现必须由多个专业 Agent 互相质疑才能定案的场景，且有稳定的评测集 |
| 嵌套子 Agent（子 Agent 再 spawn） | 本轮最多一层；嵌套会让超时、权限、成本、追踪都变复杂 | 单层计划无法表达任务，且已有可靠的深度/预算控制 |
| 模型自主 spawn | 路由由规则或受限 LLM 显式产出计划，不允许模型在运行中自行决定“再开一个 Agent” | 有明确的自主性需求和人工审批机制 |
| per-agent 模型档位路由 | 当前只有一个主模型；按 Agent 分模型会增加配置面和成本不确定性，收益尚未验证 | 路由评测能证明“轻任务用小模型”在质量不降的前提下显著省钱 |
| 路由阶段自由调用工具 | 路由只产出计划；工具调用属于子 Agent 执行阶段 | 需要路由先查外部状态才能决策时，另设只读探测步骤 |
| 子 Agent 实时流式输出到聊天 | 会把中间噪声带回主线程，违背“返回摘要”的初衷 | 需要展示长任务进度时，用过程面板的结构化状态，而不是把原始输出倒进聊天 |

---

## 4. 验证

实现落点：

| 文件 | 作用 |
|---|---|
| `packages/shared/src/index.ts` | `TurnStepSchema.mode`、`RoutingTraceSchema`、`TurnPlanSchema.routing` |
| `packages/agent/src/registry.ts` | `AgentSpec`、`routingCatalog()`、`validatePlanSteps()` |
| `packages/agent/src/router.ts` | `RouterAgent`、6 秒超时、JSON 解析与计划校验 |
| `packages/agent/src/index.ts` | `shouldConsultRouter()`、规则/LLM/回退策略、`executePlan()` |
| `apps/desktop/src/renderer/src/workspace.tsx` | 过程 tab 的策略标签、原因、候选、并行标记、耗时、步骤序列 |
| `scripts/test-router.ts` | 路由与编排的冒烟测试 |

以下命令**由主 Agent 在代码合并后运行**；本文档不执行构建/测试。

| 命令 | 覆盖什么 | 期望 |
|---|---|---|
| `pnpm typecheck` | shared 契约、registry、router、执行器、桌面/Web UI 的类型一致性 | 无 TypeScript 错误；`TurnStep.mode`、`RoutingTrace`、`TurnPlan.routing` 在所有调用点可用 |
| `pnpm test:router` | 规则路径、LLM 路径、失败回退、注册表校验、并行/串行 | 明确产物请求（practice/research/bp/growth/news_lab）不调用 LLM；开放对话/模糊/多意图走 LLM；非法 JSON/超时/未知 Agent/mode 不符/超过 1 个 write/write 不在最后/前向依赖 → `fallback`；read 并发、write 串行；`routing` 字段完整 |
| `pnpm test:agent` | 原有对话/产物链路不回归 | 每轮仍有 ChatAgent 回复；子 Agent 结果进入 `TurnRecord`；产物、引用、证据行为不变 |
| `pnpm test:context` | 追问上下文 | 第一轮案例；第二轮“那学习呢”只展开学习；第三轮“消费者市场”只展开消费者市场；开放聊天能拿到最近消息 |
| `pnpm test:ui-case` | 案例 UI + 追问 | 定义在对话前；发送“那学习呢”后仍保持学习知识点与定义先行结构 |
| `pnpm test:ui-flow` | 过程 tab 与历史 turn 展示 | 能看到策略标签（规则/LLM/兜底）、原因、候选、并行标记、`elapsedMs`、步骤序列；不把 `routing.reason` 混进聊天正文 |

建议的 router 断言清单：

1. 明确产物请求命中规则时，`strategy='rule'`，不产生 LLM 调用。
2. 多意图消息走 LLM；合法结果被采用时 `strategy='llm'`。
3. LLM 超时/非法 JSON/未知 Agent 时 `strategy='fallback'`，且步骤仍可执行。
4. 模型自报 `mode` 与注册表不一致时校验失败，不执行。
5. 2 个无依赖 read 步骤并发；1 个 read + 1 个 write 时 write 最后执行。
6. `dependsOn` 引用不存在的步骤、后续步骤或形成环时校验失败。
7. `routing.parallel` 只在 LLM 计划含 2 个及以上 read 步骤时为 `true`；规则/回退为 `false`。
8. `routing.elapsedMs` 为非负整数，且只统计路由阶段。

---

## 5. 限制与下一步

### 5.1 当前限制

1. **规则判断仍是正则/关键词驱动。** 换说法、夹英文、长句复合意图容易漏；漏了才轮到 LLM 路由，因此规则覆盖质量直接决定成本和体验。另一个成本点是 `chat` 意图一律咨询 LLM：简单寒暄也会多一次路由调用，后续可按消息长度/是否含动作词收紧 `shouldConsultRouter`。
2. **LLM 路由等待上限 6 秒。** 超时会回退到规则计划；回退计划可能比 LLM 计划粗，复杂请求需要下一轮再补。
3. **计划规模很小。** 最多 3 步、2 个 read、1 个 write；一次要多个产物（例如题目集 + 调研设计）必须拆成多轮，不能在一轮里全做完。
4. **并行只发生在 read 步骤之间，而且当前只有 `knowledge` 是 read。** write 永远串行；依赖 write 的 read 也必须等待。所谓并行，实际主要是同一轮里的多个 `knowledge` 检索/解释步骤，收益有限。
5. **没有 per-agent 模型档位。** `AgentSpec` 没有 `model` / `reasoning` 字段，所有 Agent 共用当前模型；成本控制主要靠“少调用 LLM 路由”，而不是“轻任务用小模型”。
6. **没有跨轮子 Agent 记忆。** 子 Agent 每轮从状态/输入重新开始；跨轮上下文由 `LearningStateSnapshot`、`summary_ledger` 和产物承担，不是子 Agent 私有线程。
7. **过程面板是决策快照，不是回放。** 只展示 `routing` 摘要和步骤序列，不展示完整 prompt、原始模型输出、子 Agent 中间日志。
8. **`feedback` 已由校验层硬性排除。** 注册表和 prompt 都说明它只用于交卷链路；`validatePlanSteps()` 现在会直接拒绝把 `feedback` 排进普通轮次，避免模型误选后走到失败分支。
9. **路由质量还没有独立评测集。** 当前主要靠单元测试和少量端到端用例，缺少“同一批真实学生消息，规则 vs LLM vs 回退”的对比数据。

### 5.2 下一步

1. **建路由评测集。** 收集真实消息，标注正确 Agent/步骤/是否该追问；至少覆盖：单意图、多意图、指代、省略、中英混合、新闻链接、交卷后追问。
2. **把规则命中率做成指标。** 统计 `strategy` 分布、`fallback` 比例、`elapsedMs` 分位数；如果 `fallback` 长期偏高，优先补规则，而不是放宽 LLM 权限。
3. **再评估 per-agent 模型档位。** 先用评测集证明“knowledge/growth 等轻任务用更小模型不掉质量”，再引入 `model` / `reasoning` 字段；不要先加配置再找理由。
4. **评估多 write 的批次执行。** 如果“题目集 + 调研设计”这类组合请求频繁出现，再设计受控的多 write 计划（仍串行，但允许同一轮排多个），而不是放开并行写。
5. **只在确有收益时考虑嵌套。** 嵌套 Agent 的前提是：单层计划无法表达任务、深度/预算/超时可控、过程可追踪；三者缺一不做。

---

## 6. 参考

- [Subagents – Codex](https://developers.openai.com/codex/subagents)：主线程/子 Agent 分工、读并行写谨慎、摘要返回、编排等待与线程检查、审批与沙箱继承。
- [Subagents – Agent configuration](https://developers.openai.com/codex/agent-configuration/subagents)：自定义 Agent 的 `name` / `description` / `developer_instructions`、模型与推理档位、权限继承与能力收窄。
- [Customization – Codex](https://developers.openai.com/codex/concepts/customization)：AGENTS.md、skills、MCP 与 subagents 的分层关系。
- 仓库内相关文档：
  - [`营小商-对话与多Agent优化-v0.2.md`](营小商-对话与多Agent优化-v0.2.md)：ChatAgent 常驻、主 Agent 判断、子 Agent 不说话。
  - [`营小商-案例联动与部署-v0.3.md`](营小商-案例联动与部署-v0.3.md)：案例精讲产物与部署基线。
