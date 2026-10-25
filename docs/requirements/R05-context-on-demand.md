# R05 上下文按需获取

> 状态：MVP（本轮）
> 依赖：[R02](R02-prompt.md)、[R03](R03-tools.md)
> 代码：`packages/agent/src/team.ts`、`packages/agent/src/tools/`、`packages/agent/src/tool-loop.ts`
> 上位原则：[`../principles/single-agent.md`](../principles/single-agent.md)

## 1. 要什么（学生可见结果）

- 营小商讲概念、分析新闻、出题前，真的去读材料；引用的句子能回到原文段落。
- 学生说「谢谢」「那学习呢」时，不会突然多出一批没要过的知识点或新闻。
- 同一个材料一轮只读一次；下一轮想核对时可以再读，不会被上一轮的「已读」挡住。
- 长材料进来会截断，并说明还剩多少；不会把整本书塞进上下文。
- 上一轮的结论还在，但上一轮读过的原文不会假装还在；需要时重新读。

## 2. 落位（提示词 / 工具 / 数据）

| 内容 | 放在哪 | 规则 |
|---|---|---|
| 本章知识点目录 | system | 只有名称、小节、定义前 60 字；标注「不是原文，不能当引用」 |
| 教材原文、知识点详情、新闻正文、手册、skill | 工具返回 | 进 `messages`，不进 system |
| 本轮读了什么 | `turn.reads` | 由读工具自己写，程序侧记账 |
| 引用 | `turn.citations` | 由读工具自己写；目录、摘要、常识不能写 |
| 历史对话 | `messages` | 只放 user / assistant 正文；工具结果不跨轮保留 |
| 产物 | 右栏 + 摘要 | system 只放标题/类型/状态，正文不进上下文 |

判断标准：**如果一段内容每轮都出现，它要么是稳定指令，要么是目录；否则必须变成工具。**

## 3. 行为（一轮里怎么发生）

1. `environment()` 生成本章目录：`name` + 小节 + 定义前 60 字；不查正文、不写 `reads`。
2. 模型看到目录与工具清单，自己决定读什么。
3. 读工具返回正文，同时写 `reads` 与 `citations`；结果作为 `tool` 消息进入 `messages`。
4. 模型基于刚读到的原文回答或写产物；引用必须来自工具返回的 `quote`。
5. 同一轮再次读同一份材料：`firstTime()` 返回 false，工具回「本轮已经读过，内容完全相同」。
6. 本轮结束，`turn.reads` 与 `citations` 进入 trace 与落库；工具原文不写回 system。
7. 下一轮重新组装 system：目录重算、历史只取 user / assistant 正文、产物只取摘要。

## 4. 契约

目录（system 内）：

```text
## 本章知识点目录（N 个）
只用于选材料，不是原文。讲概念、案例、新闻前先调用 read_kp / read_material / read_textbook 读正文；不要拿目录当引用。
- <名称>（<小节>）：<定义前 60 字>
```

- 只列当前章节；换章后重建。
- 不写别名、教材例子、非例子、原文段落。
- 目录不写 `reads`、不写 `citations`；`list_chapter_kps` 同样不写。
- 定义按码点截断，不切坏 surrogate pair；超出加 `…`。

本轮记账：

```ts
// packages/agent/src/tools/types.ts
export interface ReadLedger {
  kps: Set<string>       // 知识点中文名
  blocks: Set<string>    // 教材段落 id
  news: Set<string>      // 新闻 id
  queries: Set<string>   // 检索词
  references: Set<string> // 手册名
  skills: Set<string>    // skill 名（R04 新增）
}
```

- 只有读工具写 `reads`；写工具、目录、system 都不写。
- `cite()` 按 `sourceType + sourceId` 去重；同一出处一轮只记一次。
- 引用只能来自工具返回的原文：知识点定义、教材段落、新闻正文；手册与 skill 不作为引用。
- `firstTime(key)` 的 key 命名空间：`kp:<name>`、`block:<id>`、`news:<id>`、`ref:<name>`、`skill:<name>`。
- `seen(key)` 只查询，不产生副作用；不得用它替代 `firstTime()` 来「先标记后读」。

历史与产物：

- 历史只放 user / assistant 正文，按时间顺序；开头若是 assistant 则丢弃，保证第一条是 user。
- 跨轮不保留工具结果原文；需要时重新调工具（新的一轮 ledger 重置）。
- system 的「最近产物」最多 3 条：标题、类型、状态；不含 HTML、Markdown、sourceRefs 全文。
- 需要修改已有产物时，由 [R15](R15-artifacts.md) 定义读取方式；读取必须走工具并记账，不把产物正文预塞进 system。

有界：

- 单次工具结果 36,000 字节；超了保留头尾并写「省略 N 字节」。
- 本轮工具结果总量 48,000 字符后，旧结果裁到 4,096 头 + 1,024 尾。
- 单工具另有上限：新闻正文 4,000 字符、`read_material` 12,000 字符（见 [R03](R03-tools.md)）。

## 5. 边界（不做什么、失败怎么表现）

- 不预取业务材料：不由代码替模型挑知识点、拼原文、塞进 system。
- 不把预取内容标成「本轮已读」；`seed` 不得用于业务材料。
- 不用目录、摘要、模型常识冒充教材原文；没读到就说「资料不足」。
- 不把历史折进 system；不在 system 里重复最近对话。
- 不把整本书、整篇新闻、整个题库塞进上下文；超长必须截断并说明剩余。
- 工具读不到：返回明确错误或「本章没有该段落」，模型据此说资料不足；不静默返回空。
- 目录体积随章节增长：只允许名称 + 一句话，不允许把定义扩成段落。

## 6. 验收（场景 → 期望）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 「用第 4 章讲一下消费者」 | 模型先调 `read_kp` 或 `read_material`；回复引用的定义/原文来自工具结果；`trace.reads.kps` 只含真正读过的 |
| 2 | 学生说「谢谢」 | `trace.reads` 为空、`citations` 为空；回复不引用目录定义；system 不新增材料 |
| 3 | 连续两轮追问同一个概念 | 第二轮不预取正文；需要时能重新读到（ledger 重置），不会回「本轮已经读过」 |
| 4 | 同一轮重复读同一知识点 | 第二次返回「本轮已经读过，内容完全相同」；`reads.kps` 与 `citations` 不重复计数 |
| 5 | 只调 `list_chapter_kps` 看目录 | 返回全章知识点；`trace.reads` 仍为空；目录内容不出现在 `citations` |
| 6 | 读一条超长新闻/教材 | 返回头尾 + 「省略 N 字节」；模型换窄参数重读，不原样重试 |
| 7 | 写完页面后的下一轮 | system 出现「最近产物」一行；不含 HTML 正文；`citations` 仍只来自原文 |
| 8 | 连续 30 轮长会话 | system 不随轮次增长；历史按预算截断；不出现整段旧工具结果 |

## 7. 现状与差距（代码事实）

| # | 事实 | 位置 |
|---|---|---|
| 1 | 预取已删除：全仓搜不到 `prefetch`；system 只放目录 | `packages/agent/src/team.ts:91-110` |
| 2 | 目录只含名称、小节、定义前 60 字，并明确标注不是原文 | `packages/agent/src/team.ts:91-106` |
| 3 | `createToolContext()` 支持 `seed`，但 `runTeamTurn()` 没有传；业务材料没有预取入口 | `packages/agent/src/tools/index.ts:39-49`、`packages/agent/src/team.ts:182-188` |
| 4 | `firstTime` / `seen` / `cite` 都在本轮上下文里，工具自己不持有状态 | `packages/agent/src/tools/types.ts:25-45`、`packages/agent/src/tools/index.ts:50-66` |
| 5 | `read_kp`、`read_textbook`、`read_material` 写 `reads` 与 `citations` | `packages/agent/src/tools/read-tools.ts:58-59`、`:169-177`、`:224-243` |
| 6 | `read_reference` 只写 `reads.references`，不写引用 | `packages/agent/src/tools/read-tools.ts:311` |
| 7 | `search_news` 只写 `reads.queries`；`read_news` 才写 `reads.news` 与引用 | `packages/agent/src/tools/read-tools.ts:350`、`:382-383` |
| 8 | `list_chapter_kps` 不写 `reads`、不写 `citations`；它是看全章的兜底，主路径仍要求 `read_kp` / `read_material` 记账 | `packages/agent/src/tools/read-tools.ts:18-37` |
| 9 | 历史只取 user / assistant 正文；跨轮不带工具结果 | `packages/agent/src/index.ts:439-441` |
| 10 | 历史没有条数/字符上限；长会话会一直增长 | `packages/agent/src/index.ts:439-441` |
| 11 | `memory_episodes` 由记录器写入，但对话路径不读摘要；聊天轮 `record_json` 为空，记录器拿不到完整记录 | `packages/agent/src/recorder.ts:217`、`packages/agent/src/index.ts:501` |
| 12 | `state.ts` 已算出 `artifacts.recent_types`，但没有传进 `runTeamTurn()` 的 scope | `packages/agent/src/state.ts:259`、`packages/agent/src/index.ts:443-451` |
| 13 | 程序状态每轮注入一条 `[程序状态]`，就地替换、不累积 | `packages/agent/src/tool-loop.ts:363-374` |
| 14 | 工具结果有头尾保留与中间裁剪，阈值见 [R03](R03-tools.md) | `packages/agent/src/tool-loop.ts:9-12`、`packages/agent/src/tool-result-pruner.ts:18-22` |

## 8. MVP 范围与后续

**MVP 做到哪**

- 保持「system 只有目录与摘要、正文只走工具」；不恢复任何预取。
- 补 `reads.skills` 字段（配合 [R04](R04-skills.md)），读 skill 也记账。
- 把 `artifacts.recent_types` 接进 system 的「最近产物」，最多 3 条。
- 给历史加字符预算：超出时保留第一条 user 与最近若干条；不伪造摘要，不把旧工具结果塞回去。
- 统一截断文案与剩余量说明；目录、摘要、常识不得写入 `citations`。

**后续留什么**

- 长会话摘要：由 [R14](R14-profile-memory.md) 提供可读摘要，system 只放一句，正文仍在工具/历史。
- 读产物工具：修改已有产物时按 [R15](R15-artifacts.md) 的契约读取片段，读一次记一次。
- 目录按章节缓存，减少每轮查库。

**明确不做**

- 预取知识点、原文、新闻正文、题库；把预取标成「已读」。
- 向量检索、自动 rerank、MCP resources / URI 协议。
- 把历史、产物正文、工具日志折进 system。
