# R02 提示词装配

> 状态：MVP（本轮）
> 依赖：[R01](R01-single-agent.md)
> 代码：`packages/agent/src/prompts.ts`、`packages/agent/agents/mentor.md`、`packages/agent/src/team.ts`
> 上位原则：[`../principles/single-agent.md`](../principles/single-agent.md)

## 1. 要什么（学生可见结果）

- 每轮 system 都能复现同一套身份、同一套规矩；学生感到「它知道我在学哪一章、学到哪」，但看不到任何内部字段。
- 学生问「谢谢」和问「讲一下消费者」时，system 的差别只有当前环境，不会突然多出一批业务材料。
- 章节再大，system 也不会把教材原文、新闻正文、题库塞进来；这些只能由模型调工具读（见 [R05](R05-context-on-demand.md)）。
- 回复稳定：同一轮里不会出现两套互相冲突的规则，也不会把「本轮工具」写成操作日志。

## 2. 落位（提示词 / 工具 / skill / 数据）

| 内容 | 落在哪 | 说明 |
|---|---|---|
| 身份、判断顺序、回复规范、硬边界 | 提示词 | `agents/mentor.md`，常驻，唯一一份 |
| 当前章节、学情、知识点目录、最近产物 | 运行时环境 | `team.ts` 的 `environment()` 每轮重算 |
| 教材原文、新闻正文、题目 | 工具 | 不在 system，见 [R03](R03-tools.md)、[R05](R05-context-on-demand.md) |
| 判据与方法论 | skill / 手册 | 正文不在 system；只放名称 + 触发描述，见 [R04](R04-skills.md) |
| 章节、学情、产物的事实 | 数据 | 由 [R14](R14-profile-memory.md)、[R15](R15-artifacts.md)、[R06](R06-knowledge.md) 提供 |

提示词、skill、手册三层不重复：**同一句判据只存一处**。提示词说「什么时候读」，skill 说「做到什么程度算合格」，手册说「具体怎么做」。

## 3. 行为（一轮里怎么发生）

1. `loadAgent()` 读 `agents/mentor.md`，剥掉 YAML frontmatter（frontmatter 是宿主元数据，不是指令）。
2. `environment()` 生成当前环境：章节、学情一句话、本章小节、知识点目录、最近产物。
3. `runTeamTurn()` 按固定顺序拼接 system：主提示词 → 当前环境 → 本轮规则。
4. 历史消息（user / assistant 正文）进 `messages`；工具结果只在本轮内进 `messages`；system 每轮重新计算，不累积。
5. 模型回复前不回显 system；回复中不出现阶段、意图、工具名、内部 id。
6. 本轮产物落库后，下一轮的「最近产物」才更新；system 里永远只有摘要，没有产物正文。

## 4. 契约

system 固定由五块组成，顺序不变：

```text
<主提示词：身份 / 判断 / 回复规范 / 边界>

## 当前环境
章节：<中文名>
学情：<一句人话>
本章小节：<小节名 / 小节名>
## 本章知识点目录（N 个）
只用于选材料，不是原文。讲概念、案例、新闻前先调用读工具取正文；不要拿目录当引用。
- <知识点名>（<小节>）：<定义前 60 字>

## 最近产物
- 《<标题>》· <类型> · <可继续 / 已完成>

## 规则
<只在 system 里说一次的硬规则>
```

字段规则：

- 章节只写中文名；不写 `ch04`、`kp_*`、`student_demo` 这类内部标识。章节名缺失时写「当前章节」，不拿 id 顶替。
- 学情只写一句人话（例如「已进入学习阶段，已有 3 条证据」）；不写 `pre` / `learning` / `post` 枚举。
- 目录每行只含名称、小节、定义前 60 字；不含别名、教材例子、非例子、原文段落。
- 最近产物最多 3 条，每条只含标题、类型、状态；不含 HTML、Markdown 正文、sourceRefs 全文。没有产物时整块省略，不写「无」。
- 规则块只写 system 独有的话；与主提示词重复的句子删除。
- 若启用了 skill，目录作为「当前环境」的一部分：每行 `- <name>：<description>`，正文不出现；见 [R04](R04-skills.md)。

长度预算：

| 块 | 上限 | 超出时 |
|---|---|---|
| 主提示词 | 6,000 字符 | 删重复规则，不删身份与边界 |
| 环境（含目录） | 4,000 字符 | 定义 60 → 40 字；仍超则只列本章前 60 个知识点并注明 |
| 目录单行 | 80 字符 | 截定义并加 `…`，不拆 surrogate pair |
| 最近产物 | 3 条 × 60 字符 | 只留标题与类型 |
| skill 目录 | 1,000 字符 | 只留名称 + 触发描述 |
| skill / 手册正文 | 0 字符 | 一律不常驻 |
| 工具 schema | 不计入 system | 单独计入 `toolsChars` |

system 合计目标 ≤ 10,000 字符。预算按字符计，不按 token 估算。

## 5. 边界（不做什么、失败怎么表现）

- 不预取业务材料：system 里不出现教材原文、新闻正文、题目、题库。
- 不把历史对话折进 system；历史只在 `messages`。
- 不把工具说明整段抄进 system；工具自描述，见 [R03](R03-tools.md)。
- 不把「本轮读了什么、调了什么工具」写进 system 或回复。
- 提示词文件缺失：`loadAgent()` 抛错并指出路径，不静默用空 system 继续跑。
- 超预算：先缩目录，再删重复规则；不删「不编造」「不代写」「不暴露内部」三条底线。
- 学情与产物摘要只做索引，不做判断；判断仍由模型完成。

## 6. 验收（场景 → 期望）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 新会话首轮抓 system 快照 | 只含身份、环境、目录、规则；搜不到「原文：」「教材例子：」「新闻正文」；`trace.context.systemChars` ≤ 10,000 |
| 2 | 学生说「谢谢」 | system 与上一轮只差学情/产物摘要；不新增任何知识点正文或新闻 |
| 3 | 41 个知识点的章节 | 目录行数等于知识点数；每行 ≤ 80 字符；超长定义带 `…` |
| 4 | 写完一份页面后的下一轮 | 「最近产物」出现该页面一行；system 里没有 HTML 片段 |
| 5 | 全文检索 system | 不出现 `student_demo`、`ch04`、`learning`、`pre`、`kp_`；不出现工具调用日志（`tool-start` / `tool-end`）或整段工具说明 |
| 6 | 删掉 `agents/mentor.md` 后启动 | 明确报「找不到提示词」，不空转、不降级成无提示词 |

## 7. 现状与差距（代码事实）

| # | 事实 | 位置 |
|---|---|---|
| 1 | `loadAgent()` 只读一份主提示词，剥 frontmatter；找不到就抛错 | `packages/agent/src/prompts.ts:49-51`、`:43-45` |
| 2 | 七份手册名固定在 `REFERENCE_NAMES`，正文按需读 | `packages/agent/src/prompts.ts:59-67` |
| 3 | 主提示词 192 行、4,351 字符；七份手册合计 23,341 字符 | `packages/agent/agents/mentor.md`、`packages/agent/references/` |
| 4 | 环境当前只拼：学生 id、章节标题 + id、`学情阶段：${phase}`、小节、目录 | `packages/agent/src/team.ts:97-110` |
| 5 | 目录定义截 60 字，按码点切，不会切坏代理对 | `packages/agent/src/team.ts:91-95` |
| 6 | system 由主提示词 + 环境 + 「本轮工具」五条规则组成；规则与主提示词有重复 | `packages/agent/src/team.ts:190-201` |
| 7 | 没有产物摘要：`scope` 只传章节与阶段，`state.ts` 算出的产物类型没有进 system | `packages/agent/src/index.ts:443-451`、`packages/agent/src/state.ts:259` |
| 8 | 没有学情摘要：证据数、待办问题、最近意图都没进 system | `packages/agent/src/state.ts:242-270` |
| 9 | 内部标识直接进 system：`学生：student_demo`、`章节：…（ch04）`、`学情阶段：learning` | `packages/agent/src/team.ts:99-101` |
| 10 | 主提示词点名 8 个工具，实际注册 9 个（漏 `list_chapter_kps`） | `packages/agent/agents/mentor.md`、`packages/agent/src/tools/index.ts:13` |

## 8. MVP 范围与后续

**MVP 做到哪**

- 固定四块骨架与拼接顺序；system 每轮重算，不累积。
- 去内部标识：章节只写中文名，学情写一句人话，不写 `phase` 枚举。
- 加「最近产物」摘要（最多 3 条，只含标题/类型/状态），数据来自 [R15](R15-artifacts.md)。
- 加长度预算与超限处理；目录单行 ≤ 80 字符。
- 合并主提示词与「本轮工具」里的重复规则，保留一份。
- 主提示词工具清单与 `AGENT_TOOLS` 对齐。

**后续留什么**

- 学情摘要更细（证据覆盖、待复习、最近一次失败），仍只写一行到两行。
- 按章节缓存目录文本，减少每轮查库；缓存失效以章节切换为准。

**明确不做**

- 把手册、skill、教材原文、新闻正文常驻 system。
- 把历史消息折进 system 或摘要后替代 `messages`。
- 为不同能力动态改写主提示词或另拼一套 system。
