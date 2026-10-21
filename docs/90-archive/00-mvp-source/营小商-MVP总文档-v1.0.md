# 营小商 MVP 总文档 v1.0

> 产品：**营小商**（山东大学威海商学院市场营销专业）  
> 日期：2026-10-19  
> 状态：MVP 主文档。合并并取代以下三份文档的阅读入口：
> - `营小商-MVP调研与设计报告-v0.1.md`（调研与架构）
> - `营小商-MVP实现说明-v0.1.md`（实现记录）
> - `营小商-对话与多Agent优化-v0.2.md`（对话与多 Agent 基线）
>
> 后续增补继续保留为独立文档：
> - `营小商-案例联动与部署-v0.3.md`（案例精讲、Web 部署）
> - `营小商-Codex式多Agent路由-v0.4.md`（路由、并行/串行、上下文连续性）

---

## 0. 一句话

**营小商是一个聊天优先、状态驱动、多 Agent 分工的营销学习智能体：学生只负责聊天，主 Agent 判断学习状态并调度专业子 Agent，ChatAgent 统一说话，记录 Agent 把每轮整理成可追溯的学习状态。**

它不是“功能入口集合”，也不是“学生先选章节/选专家”的工具箱。

---

## 1. 产品定位

| 项 | 内容 |
|---|---|
| 产品名 | 营小商 |
| 学校/专业 | 山东大学威海商学院市场营销专业 |
| 课程切片 | 本科市场营销，MVP 以第 4 章「消费者市场与购买行为分析」为验收章节 |
| 核心目标 | 用真实商业案例学习营销知识，把“知识点 → 案例 → 判断 → 证据 → 成长”串起来 |
| 交互形态 | 聊天为主；右栏是当前任务的工作区 |
| 部署形态 | Electron 桌面端 + Web 长驻服务（复用同一份 React 界面） |
| 数据形态 | 本地优先 SQLite；单学生演示库 `student_demo`；未来可服务端化 |

### 1.1 用户不需要做什么

- 不需要先选章节；章节由对话和状态推断，不确定时才问。
- 不需要选专家/子 Agent；由 JudgeAgent 调度。
- 不需要看内部枚举、置信度、工具调用日志。
- 不需要把产物当“终点”；产物是下一轮判断的输入。

### 1.2 产品要做什么

1. 判断学生现在在 pre / learning / post 的哪个阶段。
2. 判断这句话是聊天、追问、解释、练习、调研、BP、复盘，还是新闻分析。
3. 选择最合适的子 Agent，必要时组合 read/write 步骤。
4. 用 ChatAgent 给出一段自然、连贯、有判断的回复。
5. 把本轮产物、引用、证据、状态写入可追溯的记录。

---

## 2. 核心设计原则

1. **聊天是主线。** 中栏是唯一对话页；左栏是会话与档案；右栏只服务当前任务。
2. **主 Agent 只判断与调度。** 不拼长回复，不替学生写作业，不暴露内部结构。
3. **子 Agent 只做专业模块。** 知识新闻、出题、调研、BP、成长、新闻、案例、反馈；不直接对学生说话。
4. **ChatAgent 常驻。** 每轮都必须有自然语言回复；模型失败也要有可读兜底。
5. **卡片是附件。** 产物默认以附件条出现，点击才在右栏打开；只有题目集和案例精讲因学习需要自动打开。
6. **状态可追溯。** 每轮写 `TurnPlan` / `TurnRecord`；记录 Agent 异步整理摘要、证据、状态、账本。
7. **规则优先，LLM 受限。** 明确请求走规则；模糊/多意图才咨询受限 LLM 路由；失败回退规则。
8. **读并行、写串行。** 读步骤可并行；写产物必须串行，避免冲突。
9. **不编造。** 没有证据就说证据不足；新闻/案例引用必须可回到原文。
10. **不把内部字段给学生看。** phase、intent、decision、scope 置信度、工具枚举都不进聊天正文。

---

## 3. 运行时架构

```text
学生消息
→ 写入 chat_messages（seq / turn_id / kind / payload_json）
→ StateProjector 计算 StateFeatures + LearningStateSnapshot
→ JudgeAgent 生成 TurnPlan（phase / scope / intent / decision / asks / steps / routing）
→ 执行器调用职能子 Agent（read 可并行，write 串行）
→ 子 Agent 返回 SubagentResult（content / citations / evidenceCandidates / artifactDrafts）
→ ChatAgent 生成最终回复（结论、解释、下一步、一个检查问题）
→ 写 TurnRecord 到 turns
→ RecorderAgent 异步整理 memory / evidence / learning_states / summary_ledger
→ QuestionOrganizer 把新题去重写入 question_bank
```

### 3.1 角色

| 角色 | 职责 | 不做什么 |
|---|---|---|
| **JudgeAgent** | 读快照、判 phase/scope/intent、决定追问/执行、选择子 Agent、写 TurnPlan | 不写长回复；不直接执行专业任务 |
| **职能子 Agent** | 知识解释、出题、调研、BP、成长、新闻分析、案例精讲、反馈 | 不直接对学生说话；不互相自由协商 |
| **ChatAgent** | 唯一说话人；把状态、子 Agent 摘要、引用、产物组织成回复 | 不决定调谁；不编造证据 |
| **RecorderAgent** | 消费 TurnRecord；写摘要、事实、证据、学习状态、账本 | 不改教学策略；不重复总结 |
| **QuestionOrganizer** | 按 normalized stem 去重写题库 | 不面向用户；不阻塞聊天 |

### 3.2 为什么这样分层

- 避免“每个功能各说各话”，学生只需要面对一个说话人。
- 避免主对话被检索原文、题目生成细节、日志污染。
- 路由可回放、可测试、可解释；规则失败时不会把整轮拖垮。
- 产物与证据分开：`source_refs` 是课程/新闻来源，`evidence_ids` 是学生能力证据。

---

## 4. 状态模型

### 4.1 阶段

MVP 主实现 `pre / learning / post`；`review / assessment` 有类型与判定，完整 UI 流程属于后续。

| 阶段 | 判定信号 | 主 Agent 首要动作 |
|---|---|---|
| pre | 无当前章节证据、无 active 计划、首次进入、问“从哪开始” | 诊断 1–2 个问题，生成最小计划，不急着产出长文档 |
| learning | 有 active 计划、最近有证据/产物、围绕概念/案例/题目提问 | 先让学生判断，再给提示；按需调子 Agent；每轮最多一个检查问题 |
| post | 计划完成、学生说“写完了/帮我看看/总结一下” | 用证据账本复盘；指出证据不足；给迁移任务 |
| review | 明确说“复习/考试/再看一遍” | 间隔复习：先回忆、再测、再补缺 |
| assessment | 要成长卡、教师复核、阶段验收 | 只依据证据账本给结论；证据不足明确标注 |

### 4.2 章节推断

顺序固定：

1. 消息里的显式章节（“第 4 章”“ch04”）；
2. 消息里的知识点/案例名，经 `searchKps` 映射；
3. 当前会话继承的 scope；
4. 最近活跃章节 / 学习计划；
5. 课程默认章节。

输出 `scope.source` 与 `scope.confidence`。置信度低且后果大时只问一个必要问题；开放式聊天不追问。

### 4.3 快照

`LearningStateSnapshot` 是投影，不是事实表。包含：

- `phase / phase_confidence / phase_reasons`
- `scope`（chapter、topicIds、source、confidence）
- `goal`
- `plan`（active item、completed、total）
- `evidence`（count、coverage、recent）
- `artifacts`（recent_types、pending_review）
- `session`（turns、open_questions、last_summary_seq）
- `signals`
- `features`（证据天数、章节证据数、计划状态、最近意图、题型分布、复习状态等）

主 Agent 每轮只读快照，不重读全部数据库。

---

## 5. 数据模型

| 表/字段 | 作用 | 谁写 |
|---|---|---|
| `chat_messages` + `seq/turn_id/kind/payload_json` | 追加式事件日志（消息、答题、产物事件） | 主 Agent / 子 Agent / 反馈 |
| `turns` | 一轮的 TurnPlan / TurnRecord 摘要 | 主 Agent |
| `learning_states` | “学生 × 章节”当前状态投影 | 记录 Agent |
| `summary_ledger` | 已总结/待总结/需重算/失败水位 | 记录 Agent |
| `memory_episodes` / `memory_facts` | 会话摘要与事实 | 记录 Agent |
| `evidence` | 学生能力证据（来自学生原话/作答，不来自 AI 产物） | 记录 Agent |
| `growth_snapshots` | 前测/后测快照 | 记录 Agent / 档案页 |
| `artifacts` + `content_json/schema_version/version/status/source_refs_json` | 结构化产物 + Markdown 降级 | 产物服务 |
| `question_attempts` | 单题/整卷作答 | 反馈 Agent |
| `question_bank` | 去重题库（stem_hash 唯一） | 题目整理 Agent |

### 5.1 账本规则

- **read-before-summarize**：只读 `summarized_seq + 1 .. source_seq`。
- **幂等**：episode id 使用 `ep_<sessionId>_<sourceSeq>`，重复 flush 不重复写。
- **stale**：新事件使 `source_seq > summarized_seq` 即标记 stale。
- **失败可见**：`attempts / last_error` 保留；连续 3 次失败停止自动重试，UI 可手动重试。
- **single owner**：只有记录 Agent 写账本、证据、学习状态。

---

## 6. 对话与多 Agent 规范

### 6.1 每轮必须有回复

- ChatAgent 是唯一说话人。
- 模型失败/超时/子 Agent 失败时，必须有可读兜底：说明没拿到什么、给一个可执行下一步。
- 不暴露错误栈、内部枚举、原始 JSON。

### 6.2 回复结构

**复杂解释 / 新闻 / 案例：**

1. 先给结论：这是什么样本/问题；
2. 拆 3–5 个知识点：概念 + 原文证据 + 为什么成立；
3. 给 2–3 条可迁移结论；
4. 说明边界条件；
5. 最后只问一个检查问题。

**产物类（调研/BP/出题/成长卡）：**

1. 先说做了什么判断、为什么现在做；
2. 再说 2–3 个最重要的取舍/证据缺口；
3. 给明确下一步；
4. 卡片作为附件，不替代回复。

**追问/计划：**

- 追问：ChatAgent 用自然语言引出问题，选项由结构化 `asks` 渲染。
- 计划：先说明“为什么这样排”，再给最小计划。

### 6.3 对话连续性

- Router 读取最近 8 条 user/assistant 消息。
- ChatAgent 的 `chat / ask / plan / synthesize` 都读取最近 10 条消息。
- 短追问（“那学习呢 / 再 / 继续 / 为什么”）必须沿用上一轮主题。
- 案例追问只展开被追问的知识点，不重复整份案例。
- 长会话仍靠 summary ledger / memory episodes 压缩，不把全部历史塞进 prompt。

### 6.4 路由与执行

- 规则判断是默认路径和安全兜底。
- 受限 LLM 路由只在开放聊天、新闻、多意图时咨询；明确产物请求不走 LLM。
- 规则计划已包含 `knowledge` 步骤时不咨询路由，避免把明确解释改写成案例。
- 计划最多 3 步、最多 2 个 read、最多 1 个 write；write 必须最后。
- 未知 Agent、mode 不符、`feedback` 误选、前向依赖、两个 write → 回退规则。
- read 并行；write 串行；`dependsOn` 未满足则等待。
- 路由轨迹写入 `TurnPlan.routing`，过程面板显示策略/原因/候选/并行/耗时。

### 6.5 显示清理

必须删除/不展示：

- scope chip 里的“学习中/学习前/学习后”；
- “本次使用：出题/知识新闻/调研”整行；
- 执行块里的 `explain · act`、`判断状态 → ...`、`假设：...`；
- 文档头“已生成 · v1”；
- 依据卡里的 `kp_consumer_definition` 内部 ID；
- 助手正文里的原始 Markdown 标记；
- 自动弹出的非题目集/非案例精讲产物。

---

## 7. 教学闭环

### 7.1 学习前

- 首次进入“我想学消费者行为”：判 pre，最多问 2 个诊断问题。
- 回答后生成最小计划（前测完成、学习中 active、后测 pending）。
- 不出现章节下拉框。

### 7.2 学习中

- 概念解释：调知识新闻 Agent，引用 KP/新闻，给一个检查问题。
- 案例精讲：调 CaseCoach，定义先行 + 案例对应 + 对话。
- 练习：调出题 Agent；题目集自动打开右栏；答案交卷前折叠。
- 学生作答：写 `question_attempts`；反馈 Agent 产 `evidenceCandidates`；记录 Agent 写证据。

### 7.3 学习后

- “我学得怎么样”：按证据账本生成成长卡；证据不足的维度明确标注。
- 不把 AI 产物当学生证据。
- 可给迁移任务：换品类/换人群/换情境验证。

### 7.4 出题与交卷

- “20 道题”就出 20 道，上限 30；不足时最多 3 次续出，并暴露 requested/actual/shortfall。
- 一次交卷、一个 TurnRecord；交卷前不显示答案；交卷后逐题显示对错/你的答案/标准答案/解析。
- 出题后 QuestionOrganizer 按 stem hash 去重写题库。

### 7.5 新闻与最新消息

- 学生给 URL → 抓取入库 → 按当前章节选 KP → 生成新闻分析；需要时出题。
- 学生说“这条新闻/最新的消息/最新新闻” → 用当前会话最近入库或 DB 最新新闻，不退化。
- 学生说“搜一下/找新闻” → 搜索并入库。
- 新闻分析按“定义 → 案例对应 → 原文证据 → 对话”渲染；旧产物缺字段自动降级。

---

## 8. 产物与右栏

### 8.1 产物类型

| 类型 | 渲染 |
|---|---|
| `question_set` | 题目卡、选项、交卷、交卷后解析 |
| `research_design` | 研究问题、目标、方法取舍、抽样、风险、下一步 |
| `bp_outline` | 目录 accordion、每节目的一节所需证据 |
| `case_analysis` | 新闻卡、知识点定义/案例对应/证据/对话 |
| `case_study` | 案例精讲：定义 → 案例对应 → 证据 → 对话 → 结论/边界 |
| `growth_card` | 四维能力卡、等级文字、证据引用、下一步 |
| 未知 schema | Markdown renderer 降级 |

### 8.2 右栏

- 多标签文档工作区；顶部标签可关闭；`+` 打开任务概览/产物/依据/过程/文件/本地文件。
- 文档头：标题、导出（Markdown/Word）、打开文件夹、全屏、引用选中文本。
- 支持 Markdown、DOCX（转 HTML）、图片、PDF 只读预览。
- 任务概览显示状态、产物、记录水位、新闻库。
- 依据只展示本轮引用；完整证据在左栏学习档案。

---

## 9. 空态建议

空态不是固定三条。`AgentService.suggestions()` 按快照生成：

- 标题/说明：phase、章节、证据数、最近产物、新闻状态；
- 2–3 个入口：pre 摸底/案例/自测；learning 案例/概念/新闻或情境题；post 复盘/迁移/练习；有未完成研究设计则优先“继续改”。
- 固定三条只在接口失败时兜底。
- 当前是规则模板 + 状态插值，不是每次 LLM 自由生成；同一状态会稳定输出同一组。

---

## 10. 验收

### 10.1 核心场景

1. 首次进入“我想学消费者行为” → 诊断 1–2 问 → 最小计划，无章节下拉框。
2. “直播间为什么让人冲动消费” → 推断 ch04，知识解释 + 引用 + 一个检查问题。
3. “给我出 3 道题” → 题目集；答案折叠；作答写 attempt；反馈产证据。
4. “帮我设计国潮联名调研” → 只问一个缺失关键问题 → 研究设计。
5. “校园二手书 BP” → BP 目录；每节目的与所需证据。
6. “我学得怎么样” → 成长卡；证据不足明确标注。
7. 连续多轮后 → summary ledger 已整理/待整理/需重算；重复 flush 不重复写。
8. 产物预览不出现 `##`、`**` 等原始 Markdown；导出可用。
9. “给我出 20 道题” → 20 道，题目集 tab `题目集 · 20 题`。
10. 交卷前无答案；交卷后逐题解析；一次交卷只产生一个 TurnRecord。
11. 出题后 question_bank 增加非重复题目；重复生成不重复入库。
12. “根据最新的消息给我出题” → 使用最新新闻，不退化。
13. scope chip 不显示“学习中”；无“本次使用”行；文档头无“已生成 v1”和 MD/DOCX 文字按钮。
14. 调研/BP/新闻分析后，ChatAgent 先给自然语言总结，卡片只是附件。
15. 依据卡显示知识点名称，不显示 `kp_*`。
16. 空对话页建议随状态变化；固定三条只在模型失败时出现。
17. 案例精讲：定义 → 案例对应 → 对话；消费者/消费者市场/学习三个知识点；追问“那学习呢”只展开学习。
18. 过程面板显示路由策略（规则/LLM/兜底）、原因、候选、并行、耗时、步骤 read/write。

### 10.2 验证命令

```bash
pnpm typecheck
pnpm test:agent
pnpm test:case
pnpm test:router
pnpm test:context
pnpm test:web
pnpm test:ui-case
pnpm test:ui-flow
pnpm test:ui-queue
pnpm test:offline
pnpm test:skills
```

---

## 11. 当前实现状态与已知差异

### 11.1 已实现

- 主 Agent / TurnPlan / TurnRecord / 状态投影；
- 知识、出题、调研、BP、成长、反馈、新闻、案例子 Agent；
- ChatAgent 常驻、Markdown 渲染、动态空态；
- 题目集交卷、题库去重、20/30 道题、最新新闻；
- 右栏多标签、结构化 renderer、导出/预览；
- 记录 Agent + summary ledger + 证据 + 学习状态；
- 案例精讲 + 定义先行 + 案例对话；
- Web 长驻服务 + Docker + 持久化；
- Codex 式路由：注册表、受限 LLM、规则兜底、read 并行/write 串行、路由轨迹；
- 对话连续性：最近消息注入、案例追问聚焦。

### 11.2 已知差异

| 差异 | 现状 | 影响 |
|---|---|---|
| 任务概览形态 | 右栏标签，不是浮层 | 功能齐全，交互形态未完全对齐 |
| 左栏会话状态 | 只显示标题/章节，无“进行中/待确认/有新产物/已整理” | 不易一眼看出待续会话 |
| 通用知识解释离线兜底 | 无模型时只有概念+定义+提醒，未达五段式 | 案例/新闻不受影响，通用 explain 离线质量偏低 |
| scope confidence | 推断出章节即 high | 弱匹配可能过度自信 |
| 多学生 | 单学生实例 | 一个服务供多个学生需登录/隔离 |
| 多 write | 一轮最多 1 个 write | 案例+题目等双产物需拆两轮 |
| per-agent 模型档位 | 未做 | 所有 Agent 共用当前模型 |

### 11.3 P1 未做

- 对话内搜索；
- 产物编辑、版本历史、content_hash/stale 重算；
- 完整 review/assessment 独立流程；
- 题库抽题/错题重练/相似题；
- 多学生登录/教师端/多租户；
- 路由评测集、per-agent 模型路由。

---

## 12. 文档关系

```text
营小商-MVP总文档-v1.0.md          ← 本文件，MVP 主阅读入口
├── 营小商-案例联动与部署-v0.3.md   ← 案例精讲 + Web 部署增补
├── 营小商-Codex式多Agent路由-v0.4.md ← 路由 + 上下文连续性增补
├── 营小商-MVP反馈-2026-10-19.md    ← 用户反馈与处理记录
└── 旧文档（保留追溯）
    ├── 营小商-MVP调研与设计报告-v0.1.md
    ├── 营小商-MVP实现说明-v0.1.md
    └── 营小商-对话与多Agent优化-v0.2.md
```

旧三份文档不再作为第一阅读入口；需要追溯调研细节、迁移记录、逐条验收时再查。
