# R14 学情与记忆

> 状态：MVP（本轮）
> 依赖：[R01 单一智能体](R01-single-agent.md)、[R05 上下文按需获取](R05-context-on-demand.md)、[R17 本地数据](R17-local-data.md)
> 代码：`packages/agent/src/state.ts`、`packages/agent/src/recorder.ts`、`packages/profile/src/index.ts`、`packages/db/src/index.ts`
> 上位原则：[`../principles/single-agent.md`](../principles/single-agent.md)

## 1. 要什么（学生可见结果）

- 每轮开始，营小商知道：学到哪一章、处在什么阶段、计划做到哪、上次整理到第几条消息、最近聊了什么、记得学生的目标/偏好/约束、还有哪些待确认问题、手上有多少能力证据。
- 学生打开「学习档案」能看到：目标与约束、当前状态、四维能力、证据账本、待确认问题、最近整理。能认可或驳回一条证据，能记录前测/后测快照。
- **连续多轮不重复写**：同一轮被重复处理时不产生第二条相同证据；同一段对话不产生第二份相同摘要；水位只前进不回退。
- **历史可追溯**：每条证据、每份摘要都能回到原消息或原作答；学生问「你为什么这么说」时能指到原话。
- demo 种子数据只用于演示，不得混进真实学情与成长结论。

## 2. 落位（提示词 / 工具 / skill / 数据）

| 层 | 职责 |
|---|---|
| 数据 | `chat_sessions` / `chat_messages`（会话与消息）、`turns`（每轮记录）、`learning_states`（学情快照）、`evidence`（能力证据）、`memory_facts`（记忆事实）、`memory_episodes`（会话摘要）、`summary_ledger`（整理水位） |
| 代码 | `StateProjector.project()` 生成快照；`RecorderAgent` 写证据、摘要、水位与轮末事实；学生更正走 `ProfileService.upsertMemoryFact()`；`ProfileService` 负责读取与汇总 |
| 提示词 | system 的「学情」一行：阶段、计划、证据概况、待确认问题、整理水位；明细由历史消息与工具提供 |
| 工具 | 本轮不新增工具。成长证据的细读由 [R13](R13-growth-card.md) 的 `read_growth` 按需取 |
| 历史 | 对话历史作为 `messages` 传给模型，不折进 system；正文材料一律由工具读 |

- 不预取教材、新闻、题库；学情段只给状态与摘要，不给原文。
- 记忆与评价分离：`memory_facts` 记关系与约束，`evidence` 记能力证据，两者不互相替代。

## 3. 行为（一轮里怎么发生）

1. 学生发消息，`StateProjector.project()` 读会话、轮次、计划、证据、水位，产出 `LearningStateSnapshot`。
2. 拼 system：身份与规则（[R02](R02-prompt.md)）+ 学情一行 + 章节与知识点目录（[R05](R05-context-on-demand.md)）。历史消息按 `seq` 顺序进 `messages`。
3. 模型跑一轮，产出回复与（可选）产物；`chat_messages` 落 user/assistant 两条，`turns` 落一条完整 `TurnRecord`。
4. 轮末 `recorder.schedule()`：同一会话串行处理，消费水位之后的完整轮次。
5. 每条被消费的轮次：抽取证据（只从学生原话或真实作答）、写记忆事实、更新学情快照、按水位写一份摘要。
6. `summary_ledger` 水位前移；下一轮的学情段与历史随之刷新。

**只写一次的三道闸**：

- `summary_ledger.summarized_seq` 单调递增（`saveSummaryLedger` 用 `MAX`），同一段消息不会被重复消费；
- 摘要 id 固定为 `ep_<sessionId>_<watermark>`，重复插入被 `INSERT OR IGNORE` 挡住；
- 证据 id 由学生、维度、会话、消息、原文位置确定；记忆事实 id 为 `<studentId>:<kind>:<key>`，按 key 覆盖而不是追加。

**下一轮怎么被提示词使用**：学情段每轮重算，只放当前事实；历史对话由 `messages` 提供；需要原文时模型自己调工具。学情段不是「已读回执」，不会阻止模型重读材料。

## 4. 契约（工具签名、数据结构、字段、命令）

**学情快照字段**（`LearningStateSnapshot`，落 `learning_states.state_json`）：

| 字段 | 含义 |
|---|---|
| `scope.chapterId` / `scope.chapterTitle` | 当前章节；来源为显式、推断、继承或默认 |
| `phase` / `phase_confidence` / `phase_reasons` | 学习前、学习中、学习后、复习、评估；这是环境线索，供模型判断，不驱动工具选择 |
| `plan.active_item` / `plan.completed` / `plan.total` | 当前计划与进度 |
| `evidence.count` / `evidence.coverage` / `evidence.recent` | 本章证据数、覆盖维度、最近三条摘录 |
| `artifacts.recent_types` / `artifacts.pending_review` | 最近产物类型、待复核证据数 |
| `session.turns` / `session.open_questions` / `session.last_summary_seq` | 轮次数、待确认问题、整理水位 |
| `features.*` | 距上次证据天数、计划状态、意图分布、题型分布、复核分布等，供判断用 |

**最近对话**：快照不存对话全文。`chat_messages` 按 `seq` 取本会话消息作为 `messages` 传入；快照只保留轮次数与待确认问题。水位用 `session.last_summary_seq`。

**学情一行**（system 内，1 行，≤200 字符；明细不进 system）：

```text
学情：学习中，计划 2/4；本章 5 条证据覆盖 3 个维度；待确认 1 个；上次整理到第 24 条消息
```

- 只写中文，不写 `learning` / `pre` / `post` 等枚举，不写 `student_demo`、`ch04`、`kp_*`。
- 证据摘录不进 system；要引用哪条证据，模型按需调 `read_growth`（[R13](R13-growth-card.md)）。
- 没有证据就写「证据不足」，不补空话。

**记忆事实**：`kind` 取 `goal`、`preference`、`constraint`、`background`、`self_assessment`、`open_question`；`key` 稳定，`value` 可更新，`confidence` 内部使用，`source` 标明来自学生更正还是轮末记录。

**会话摘要**：`memory_episodes` 存 `summary`、`decisions`（产物 id）、`open_questions`；一条摘要对应一个水位，不按轮次各写一份。

**可追溯字段**：证据必须有 `source_type`（chat / question / …）、`source_id`（消息 id 或作答 id）、`session_id`、`excerpt`（学生原话的连续片段）、`occurred_at`；摘要必须有 `session_id` 与 `created_at`。

## 5. 边界（不做什么、失败怎么表现）

- 不写参与度：出勤、发言次数、聊天时长、字数、PPT 页数不进证据。
- 不把 AI 的话、AI 产物、学生自报「我会了」当能力证据；`D` 级直接丢弃。
- 不编造：证据摘录必须能在原消息或原作答里逐字定位，定位不到就丢弃。
- 不重复写：同一水位不写第二份摘要；同一轮重复处理不写第二条证据；事实按 key 覆盖。
- 不覆盖学生更正：学生改目标或约束，以新值为准；不悄悄回滚。
- 不跨学生：单学生本地库，所有查询带 `student_id`。
- 失败表现：模型不可用 → 保留一条可见提示「本轮有学生原话，但证据抽取未完成」，不写假证据；整理失败 → 水位不动、记录失败原因，最多重试 3 次；摘要失败不阻塞对话。

## 6. 验收（场景 → 期望）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 连续聊 3 轮 | `summary_ledger.summarized_seq` 单调前进到最新 `seq`；`memory_episodes` 每个水位一条，不出现 3 条重复摘要 |
| 2 | 同一轮因重试被记录器处理两次 | 证据 id 相同，只保留一条；摘要仍只一份；水位不倒退 |
| 3 | 学生说「我每周只有 4 小时」 | `memory_facts` 只保留一条 `constraint`，值为 4 小时；下一轮学情段体现 |
| 4 | 打开学习档案 | 每条证据有日期、维度、原文摘录、认可/驳回状态；能对应到具体会话 |
| 5 | 未配置模型 Key 时聊一轮 | 不写证据与摘要；界面一句人话说明；水位不前进，不伪造摘要 |
| 6 | demo 种子证据与摘要 | 不出现在四维结论与「最近整理」里；真实数据可覆盖同维度结论 |

## 7. 现状与差距（代码事实，路径 + 行号）

| 现状 | 位置 | 差距 |
|---|---|---|
| `StateProjector.project()` 计算章节、阶段、计划、证据、产物、会话与特征 | `packages/agent/src/state.ts:43-271` | 快照齐全；阶段仍由关键词正则判定（`:175-177`），应降为低置信线索，不据此路由 |
| 快照 schema 与字段默认值 | `packages/shared/src/index.ts:687-715` | 符合 |
| 快照落 `learning_states`（student_id + chapter_id 唯一） | `packages/db/src/index.ts:355-363` | 符合 |
| 记录器按会话串行，`flush()` 可等待 | `packages/agent/src/recorder.ts:74-93` | 符合「每轮只写一次」 |
| 水位消费要求完整 `TurnRecord`；缺记录直接 `break` | `packages/agent/src/recorder.ts:127-140` | 对话轮没有完整记录时永远不消费 |
| 记忆事实按 `<studentId>:<kind>:<key>` 覆盖写入 | `packages/agent/src/recorder.ts:168-178` | 符合去重；但轮末记录会按同一 key 覆盖学生更正 |
| 学生更正直接写同一张表，来源标为 `student-correction` | `packages/profile/src/index.ts:144-162`、`apps/desktop/src/main/index.ts:309-318` | 缺少「更正优先于轮末记录」的约束 |
| 摘要 id 为 `ep_<sessionId>_<watermark>`，`INSERT OR IGNORE` | `packages/agent/src/recorder.ts:214-230` | 符合「一水位一条」 |
| `saveProgress` 用 `MAX` 推进水位，失败记次数 | `packages/agent/src/recorder.ts:408-431`、`packages/db/src/index.ts:1478-1527` | 符合单调 |
| 摘要由轮次记录拼装，含请求、阶段、产物、作答、证据候选 | `packages/agent/src/recorder.ts:434-459` | 符合 |
| 对话历史作为 messages 传入，不折进 system | `packages/agent/src/index.ts:438-440` | 符合 |
| **对话轮写 `record_json: {}`**，记录器拿不到 `TurnRecord` | `packages/agent/src/index.ts:499-502` | 关键差距：聊天不产证据、不写摘要、不更新快照 |
| 只有作答路径写完整 `TurnRecord` | `packages/agent/src/index.ts:606-631,830-870` | 记录器目前只服务做题 |
| 证据抽取只收学生原话，逐字定位，排除自报与 D 级 | `packages/profile/src/index.ts:178-329` | 符合「不编造」 |
| `environment()` 只放章节、阶段与知识点目录 | `packages/agent/src/team.ts:82-113` | 学情段尚未接入主循环 |
| `chatContext()` 能拼学情文本，但当前无调用方 | `packages/profile/src/index.ts:430-452` | 待接入或被 R05 的新装配替代 |
| `memorySummary()` 可汇总目标/偏好/约束与最近摘要 | `packages/profile/src/index.ts:126-145` | 已用于学习档案；未进 system |
| demo 摘要按精确 id + session 过滤 | `packages/db/src/index.ts:1606-1633` | 符合「不冒充真实学情」 |

## 8. MVP 范围与后续

**MVP 做到哪**：学情快照（章节/阶段/计划/证据/水位/最近对话）；记忆事实与摘要；证据可追溯；每会话串行、水位单调、摘要与证据不重复；学习档案可查、可认可/驳回、可记前后测；demo 数据过滤；对话轮也写完整记录。

**后续留什么**：跨会话长期画像与语义检索；记忆过期与置信度衰减；学生更正的审计记录；摘要的层级压缩（会话 → 章节 → 课程）；六维能力；教师端只读视图。

**明确不做**：云端同步与多学生画像；把聊天活跃度、出勤、字数当学情；自动心理画像或情绪推断；把 AI 产物当学生证据；在界面暴露 `seq`、`attempts`、原始错误或内部枚举。
