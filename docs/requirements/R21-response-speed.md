# R21 响应速度

> 状态：MVP（本轮）
> 依赖：R01（单一智能体）、R16（对话界面）、R18（模型运行时）
> 代码：`packages/agent/src/tool-loop.ts`、`packages/agent/src/index.ts`、`apps/desktop/src/renderer/src/App.tsx`、`apps/desktop/src/main/llm.ts`
> 上位原则：[`../principles/single-agent.md`](../principles/single-agent.md)

## 1. 要什么（学生可见结果）

- 学生发一句话，**3 秒内能看到第一个字动起来**，不用等到整段生成完。
- 工具在跑的时候，界面上要能看出「在干什么、走到第几步、大概还要多久」，而不是一句静止的「正在判断并整理…」。
- 常规一问（讲个概念、分析一条新闻）**20 秒内出完**；长产物（案例精讲、题目集）**45 秒内出完**。
- 等待超过 15 秒时，界面上有明确预期（「大约还需要 30 秒」），学生知道不是卡死。

老师的原话是「发个消息他要转半天」；学长的判断是**主观观感与客观耗时分开治**。这条需求两层都要管。

## 2. 落位（提示词 / 工具 / skill / 数据）

**不开新落位，全部落在已有的运行时与界面上。**

- **不属于提示词**：不要靠「回答快一点」这类提示词描述来解决。
- **不属于 skill**：判据解决不了耗时。
- **属于工具层 + 运行时**：轮次预算、并行、缓存、打点，都是 `tool-loop.ts` / `llm.ts` 的事。
- **属于界面**：阶段文案与进度是 `App.tsx` 的事，不新增能力。

按 R01，**不允许**为了提速引入子代理或并行多 agent——那只会让总耗时更难控。

## 3. 行为（一轮里怎么发生）

现状（已存在，别重复造）：

1. 学生发送 → 渲染层写入 `stream.step = '正在判断这一句该怎么接…'`（`App.tsx:908`）。
2. 主循环每轮向 `llm.stream()` 请求（`tool-loop.ts:232`），文本增量用 `emit({type:'text'})` 推给界面。
3. 每个工具调用前推 `emit({type:'tool-start', name})`（`tool-loop.ts:309`），渲染层映射成「查资料」等中文阶段（`App.tsx:725`）。
4. 每轮开始推 `emit({type:'round'})`（`tool-loop.ts:379`），渲染层显示「正在组织回答…」（`App.tsx:731`）。

要补的：

5. **轮次预算**：`maxRounds` 默认从 8 降到 3；复杂任务由调用方显式传 5（`tool-loop.ts:174`）。
6. **耗时打点**：每轮记录 `round`、`tRoundMs`、`tFirstTokenMs`，整轮结束汇总进 `TurnRecord`。
7. **阶段细化**：`tool-start` 增加 `index`/`total`（第 n 步 / 预计 m 步），界面显示「第 2 步 · 查知识点」。
8. **超时预期**：超过 15 秒，阶段行追加「已用 15 秒，大约还要 30 秒」。

## 4. 契约（事件、字段、命令）

**循环事件（`tool-loop.ts` 的 `AgentLoopEvent`）**

```ts
type AgentLoopEvent =
  | { type: 'text'; text: string }
  | { type: 'tool-start'; name: string; index: number; total?: number }   // index/total 新增
  | { type: 'round'; round: number; tRoundMs: number }                    // tRoundMs 新增
```

**轮次记录（进 `TurnRecord`）**

```ts
{
  rounds: number
  toolCalls: number
  tFirstTokenMs: number
  tTotalMs: number
}
```

**参数**

```ts
runToolLoop({ ..., maxRounds: 3 })   // 默认值改 3；上限 5
```

## 5. 边界（不做什么）

- **不为提速牺牲可追溯**：R10 的「引文必须回原文」不能因为少一轮就被跳过。
- **不做假流式**：不允许先整段生成再打字机式回放，冒充生成过程。
- **不为了快而砍自检**：自检失败要重试，不许为了 45 秒达标跳过。
- **不引入第二说话人**（R01）。
- **不改提示词来解决耗时**。

## 6. 验收

- [ ] 首 token P50 < 3s（实测 10 次，记录原始数据）
- [ ] 常规一问 P50 < 20s，P90 < 30s
- [ ] 长产物 P90 < 45s
- [ ] 等待期间界面持续有阶段变化，最长静止不超过 8 秒
- [ ] 同一问题改动前后 `tTotalMs` 有对照数据（不是感觉）
- [ ] `maxRounds` 超限时有明确收尾（现有 closingRound 逻辑保留）

## 7. 现状与差距

| 项 | 现状 | 差距 |
|---|---|---|
| 流式文本 | ✅ 已有（`llm.stream` + `emit text`） | 首 token 时间未测 |
| 工具阶段文案 | ✅ 已有（`tool-start` → 中文标签） | 没有「第几步/共几步」 |
| 轮次上限 | ⚠️ 默认 8（`tool-loop.ts:174`） | 太宽，最坏 80–160 秒 |
| 耗时打点 | ❌ 无 | 无法定位慢在哪一轮 |
| 超时预期 | ❌ 无 | 长时间静止无解释 |
| 并行工具 | ❌ 无 | 互不依赖的读操作仍串行 |

## 8. MVP 范围与后续

**MVP（本轮）**

1. `maxRounds` 默认 3，上限 5
2. 每轮打点，写入 `TurnRecord`
3. `tool-start` 带 `index`，界面显示「第 n 步 · xxx」
4. 超过 15 秒追加预估

**后续（不排期）**

- 工具并行（需确认无副作用）
- 同章节知识点 / 新闻正文的进程内缓存
- 模型分级（规划用大模型、收尾用小模型）

**触发条件**：MVP 做完后若 P90 仍 > 45s，再上并行与缓存；没有打点数据之前不做这两项。
