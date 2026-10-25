# R01 单一智能体

> 状态：MVP（本轮）
> 依赖：无
> 代码：`packages/agent/src/index.ts`、`packages/agent/src/team.ts`、`packages/agent/src/tool-loop.ts`
> 上位原则：[`../principles/single-agent.md`](../principles/single-agent.md)

## 1. 要什么（学生可见结果）

- 学生从头到尾只和「营小商」一个人说话。没有角色选择、没有模式选择、没有「让谁来答」。
- 一轮只有一条正文回复。工具调用过程不是对话气泡，学生看不到「谁在干活」。
- 学生不选章节。章节由系统从对话和学情推断，不确定时只问一个必要问题。
- 回复里不出现阶段标签、意图标签、工具名、内部 id、分工名。
- 学生说「换个老师」「让出题的来」时，仍然是营小商接住，不切换人格、不换一套提示词。
- 连续多轮、跨能力（讲解 → 出题 → 成长卡）都在同一个会话里完成，上下文连续。

## 2. 落位（提示词 / 工具 / skill / 数据）

| 层 | 承担什么 | 不承担什么 |
|---|---|---|
| 提示词 | 身份、每轮判断顺序、回复规范、边界；见 [R02](R02-prompt.md) | 不承载业务数据 |
| 工具 | 取材料、查新闻、写产物；见 [R03](R03-tools.md) | 不决定「该由谁回答」 |
| skill / 手册 | 判据与方法论，按需读；见 [R04](R04-skills.md) | 不是角色，不另起循环 |
| 数据 | 会话、轮次、产物、证据；见 [R17](R17-local-data.md) | 没有成员表、没有角色配置表 |

内部分工只允许三种存放方式：提示词里的判断规则、工具、skill / 手册。数据只提供事实，不承担分工。

## 3. 行为（一轮里怎么发生）

1. 学生发一句话，`handleConversation()` 建或取会话，写入一条 user 消息。
2. `StateProjector.project()` 推断章节、学情阶段与范围（见 [R14](R14-profile-memory.md)）。
3. `runTeamTurn()` 拼 system、绑定本轮工具，调用 `runAgentLoop()`。
4. 模型看工具清单自己决定：读知识点、读教材、查手册、搜新闻、写页面。可以连续调多次。
5. 模型不再调工具时给出唯一一段正文；`finalizeArtifacts()` 把本轮产物落库。
6. 返回一条 `text`、本轮产物、引用、trace。学生只看到 `text` 和右栏产物。
7. 交卷是独立入口：`answerQuestionSet()` 逐题评分并返回一条反馈正文。它是确定性评分，不参与对话主循环，也不另起一套 system。

## 4. 契约

```ts
// packages/agent/src/index.ts
handleConversation(input: HandleTurnInput): Promise<HandleTurnOutput>

// packages/agent/src/team.ts
runTeamTurn(input: TeamTurnInput): Promise<TeamTurnResult>

// packages/agent/src/tool-loop.ts
runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult>
```

- 一轮恰好一个正文：`HandleTurnOutput.text`。输出结构里没有 `speaker`、`agent`、`role` 字段。
- `TeamTurnResult.findings` 恒为 `[]`；`TurnTrace.members` 恒为 `[]`。
- 进度事件 `TeamEvent.agent` 只允许 `lead`，不允许按成员分发。
- 会话创建不接受 `preset`、`persona`、`role` 参数。
- 交卷输出只有 `text` + 逐题 `results`，不产生第二个对话回合、不署角色名。
- 失败时由上层转成一句人话；不静默切换到另一条旧路径重试。

## 5. 边界（不做什么、失败怎么表现）

- 不做：在一条主循环之外再加说话人、角色路由、意图分流、preset 选择、成员白名单、按能力拼第二套 system。
- 不按关键词、品牌、章节写调度分支。能力差异只体现在工具与 skill，不体现在「谁上场」。
- 章节只由系统推断；`scopeOverride` 只作为可选覆盖，不作为必选入口（界面口径见 [R16](R16-conversation-ui.md)）。
- 不把 `phase`、`intent`、工具名、`kp_*` 写进回复。
- 允许同一轮内并行调用多个工具（`runCalls` 已经用 `Promise.all`），这不算第二个说话人。
- 模型空返回或超过轮次仍不收敛：抛错，由上层给一句可理解的说明；不换角色重来。
- 答题评分是系统能力，不是第二个说话人；它的输出只有一条反馈，不进入主循环的历史角色。

## 6. 验收（场景 → 期望）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 同一会话连续问概念、要 3 道题、要成长卡 | 三轮都只有「营小商」一个说话人；没有角色名、没有「已切换」；`trace.members` 为空 |
| 2 | 学生说「换个老师」「让出题的来」 | 不切换人格、不换 system；仍由营小商接住并继续当前上下文 |
| 3 | 新会话第一句「直播间为什么让人冲动消费」 | 正常推断章节并回答；界面没有角色选择器；不要求先选章节 |
| 4 | 一轮里连续调用 4 个工具 | 聊天区只有一条最终正文；工具过程不出现在消息气泡里 |
| 5 | 交卷一份题目集 | 只出现一条反馈正文；逐题结果在题目集壳子里，不出现第二个说话人 |
| 6 | 未配置模型 Key | 一句人话说明；不吐英文堆栈，不换角色重试 |

## 7. 现状与差距（代码事实）

| # | 事实 | 位置 |
|---|---|---|
| 1 | 主循环已经是单条：`runTeamTurn()` 调 `runAgentLoop()`，没有成员分发 | `packages/agent/src/team.ts:169`、`packages/agent/src/tool-loop.ts:173` |
| 2 | trace 仍保留成员字段，但恒为空 | `packages/agent/src/team.ts:235` |
| 3 | `team.ts` 与 `Team*` 类型仍是旧团队命名，实际只有一条循环；`findings` 字段恒为 `[]` | `packages/agent/src/team.ts:8-82` |
| 4 | 对话入口唯一，调 `runTeamTurn()` | `packages/agent/src/index.ts:400`、`:443` |
| 5 | 旧评分路径仍在跑：`FeedbackAgent` 被单题与交卷调用 | `packages/agent/src/subagents.ts:248`；`packages/agent/src/index.ts:200`、`:207`、`:558`、`:755` |
| 6 | 两个零引用文件仍在仓库：`news-lab.ts` 588 行、`case-coach.ts` 841 行；后者还依赖 `subagents.ts` 的 `StepContext` | `packages/agent/src/news-lab.ts`、`packages/agent/src/case-coach.ts:34` |
| 7 | `bundle` 仍按四个 preset 组织，每个带一段 persona 前缀 | `packages/bundle/cordis.patch.yml:61`、`:86`、`:105`、`:124` |
| 8 | 默认 preset 仍是 `knowledge-news` | `packages/bundle/cordis.patch.yml:4-6` |
| 9 | 旧 Web 面仍被挂载；其客户端类型是四选一 preset | `packages/bundle/cordis.patch.yml:56-57`、`packages/ui/src/client/client-context.ts:50` |
| 10 | 桌面端仍把 `skills`、`ui` 列为依赖 | `apps/desktop/package.json:28-29` |
| 11 | 旧 skills 包仍以 `expertId` 分组能力 | `packages/skills/src/index.ts:38` |
| 12 | 旧意图正则仍留在 `index.ts`，全仓只命中定义、没有调用方 | `packages/agent/src/index.ts:115-135` |
| 13 | 界面仍允许手动调整章节，并展示「本轮实际读到的材料」（模型调用、工具调用次数） | `apps/desktop/src/renderer/src/App.tsx:1324`、`:1369` |
| 14 | 建议入口写死了具体品牌案例 | `packages/agent/src/index.ts:346`、`:359`、`:366` |

## 8. MVP 范围与后续

**MVP 做到哪**

- 保留一条主循环、一个说话人；对话与交卷都只产生一条正文。
- 停用四个 preset 与旧 Web 面挂载；删除 `news-lab.ts`、`case-coach.ts`。
- `subagents.ts` 只保留评分与证据 id 逻辑，并迁出为服务/工具，不再以「Agent」形式出现在对话路径。
- 界面不把章节选择做成必选入口；trace 面板去掉模型/工具调用计数，改为中文的「读过什么」（见 [R16](R16-conversation-ui.md)）。
- 清理 `index.ts` 里无调用方的意图正则与写死品牌的建议文案。

**后续留什么**

- 真需要并行取多个来源时，仍在同一轮内并行调工具；不引入第二个说话人或角色路由。
- 需要独立审查时，用工具产出审查结果，再回到同一个说话人。

**明确不做**

- 任何多说话人架构、角色路由、角色选择器、按意图切换 system。
- 为某个能力单独起一个会说话的东西、单独拼提示词、单独开调用路径。
- 把内部分工名暴露给学生。
