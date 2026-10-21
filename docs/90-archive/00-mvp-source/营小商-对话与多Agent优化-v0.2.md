# 营小商对话与多 Agent 优化 v0.2

> **阅读入口**：`营小商-MVP总文档-v1.0.md`；本文保留在 `00-mvp` 同一目录，作为对话/多 Agent 逐条验收的追溯来源。

> 日期：2026-10-18  
> 状态：需求基线。本文替代 v0.1，所有实现以本文的“必须删除 / 必须实现 / 验收”为准。  
> 参考：`local://paste-1.md`（WorkBuddy 胖东来案例回答）、Codex Subagents/Web Search、Anthropic Context Engineering、Cherry Studio Chat Attachments。

---

## 0. 一句话目标

**聊天是主线，ChatAgent 常驻；主 Agent 退到“判断与调度”层；子 Agent 只做专业模块；卡片只是附件；出题后由整理 Agent 入库去重。**

不是“主 Agent 判断完丢一张卡片”，也不是“每次回复都套同一个模板”。

---

## 1. 用户明确提出的要求

### 1.1 必须删除的显示

| 必须删除 | 原因 |
|---|---|
| scope chip 里的“学习中 / 学习前 / 学习后” | 当前状态不展示，学生不需要看到内部 phase |
| “本次使用：出题 / 知识新闻 / 调研”整行 | 工具使用不展示，避免像调试面板 |
| 执行块里的 `explain · act`、`判断状态 → ...`、`假设：...` | 内部枚举/假设不展示 |
| 文档头“已生成 · v1” | 版本状态不展示 |
| 文档头 MD / DOCX 两个文字按钮 | 改成单个“导出 / 下载”按钮 |
| 依据卡里的 `kp_consumer_definition` | 显示知识点名称，不显示内部 ID |
| 非题目集产物自动打开右栏 | 卡片是附件，点击才打开；只有题目集因作答需要自动打开 |
| 旧文档 v0.1 的过时要求 | 本文替代 |

### 1.2 必须实现的交互

1. **ChatAgent 常驻**：每轮用户消息都必须先由 ChatAgent 以自然语言回应；不能直接丢卡片，也不能只用固定模板。
2. **主 Agent 只做判断**：读状态、判 phase/scope/intent、决定是否追问、决定调用哪些子 Agent、写 TurnRecord；不负责组织最终长回复。
3. **子 Agent 只做专业模块**：知识新闻、出题、调研、BP、新闻入库、反馈、成长；不直接对学生说话。
4. **卡片是附件**：聊天回复先给结论/解释/下一步，卡片以附件条出现；点击才在右栏打开。
5. **出题数量**：用户说“20 道题”就出 20 道，不能被 10 道上限截断。
6. **交卷制**：题目集一次作答，底部一个“交卷”；交卷后统一判题；交卷前不显示答案。
7. **出题后整理入库**：出题 Agent 展示题目；另一个整理 Agent 把非重复题目写入题库（例题类），供后续抽取/复用。
8. **最新消息识别**：用户说“根据最新的消息/新闻出题”时，必须用最新新闻，而不是退化成普通知识点出题。
9. **导出**：文档头只保留一个导出/下载按钮，点开可选 Markdown / Word。
10. **回答要灵动**：参考 `paste-1.md`，复杂解释要“结论先行 → 3–5 个知识点 → 原文证据 → 可迁移结论 → 边界条件”，不要每轮都套同样短句。
11. **上下文可见但不外泄内部字段**：可以有一个“上下文”入口，但只显示章节、证据数、最近产物、可用工具；不显示 intent/decision/phase。
12. **每轮都有回复**：模型失败/超时/子 Agent 失败时，也要有可读的兜底回复，不能空白或只出卡片。
13. **空态建议动态生成**：空对话页的标题、说明和 2–3 个建议不能硬编码成固定三条；必须根据当前 `LearningStateSnapshot`（phase / scope / goal / plan / evidence / 最近产物 / 待确认问题）、最近会话和课程内容生成。固定文案只能作为模型失败时的兜底，不能作为主路径。

---

## 2. 目标架构

```text
学生消息
→ 主 Agent（判断 Agent）
   - 读 LearningStateSnapshot
   - 判 phase / scope / intent / 准备度
   - 决定：直接聊 / 追问 / 调哪个子 Agent
   - 写 TurnPlan + TurnRecord
→ 子 Agent（专业模块）
   - 知识新闻 / 出题 / 调研 / BP / 新闻入库 / 反馈 / 成长
   - 只返回 SubagentResult，不直接对学生说话
→ ChatAgent（常驻说话人）
   - 拿状态 + 最近消息 + 子 Agent 摘要 + 引用 + 产物摘要
   - 生成最终回复：结论、解释、下一步、一个检查问题
→ 题目整理 Agent
   - 把新生成的题目去重后写入 question_bank
→ 记录 Agent
   - 异步整理摘要/证据/状态/账本
```

关键约束：

- ChatAgent 不是“结果润色器”，而是每轮都必须经过的说话层。
- 主 Agent 不直接拼长文本；ChatAgent 不决定调用哪个子 Agent。
- 子 Agent 的原始检索结果不进 ChatAgent；只进摘要和引用。
- 题目整理 Agent 不面向用户，只写题库。

---

## 3. ChatAgent 回复规范

### 3.1 复杂解释（知识新闻 / 新闻分析）

参考 `paste-1.md` 的结构：

1. **先给结论**：一句话说明这篇材料/问题在营销学上是什么样本。
2. **拆 3–5 个知识点**：每个知识点给“概念 + 原文证据 + 为什么成立”。
3. **给可迁移结论**：2–3 条学生能带走的判断规则。
4. **给边界条件**：说明这套解释在什么情况下不成立。
5. **最后只问一个检查问题**：推动学生自己判断，不直接给答案。

不要：

- 每轮都用“这轮先做两道题……”这种模板；
- 只写 2–4 句就丢卡片；
- 把 `intent/decision/phase` 写进回复；
- 用 Markdown 原始标记（`##`、`**`）直接显示；如果模型输出 Markdown，前端必须用 Markdown renderer 解析。

### 3.2 产物类回复（调研 / BP / 出题 / 成长卡）

1. 先说“做了什么判断 / 为什么现在做这个”；
2. 再说产物里最重要的 2–3 个取舍或证据缺口；
3. 给一个明确的下一步；
4. 卡片作为附件出现，不替代回复。

### 3.3 追问 / 计划

- 追问：ChatAgent 用自然语言引出问题，问题选项由结构化 `asks` 渲染；不能只显示固定模板。
- 计划：ChatAgent 用聊天方式说明“为什么这样排”，再给最小计划；不能只贴任务列表。

### 3.4 空态建议生成

空对话页不是固定展示“我想学消费者行为 / 直播间为什么让人冲动消费 / 给我出 3 道题”。这三条只是兜底，不是产品主路径。

生成输入：

- `phase`：pre / learning / post；
- `scope`：当前章节、推断来源、置信度；
- `goal`：学生目标；
- `plan`：当前 active 计划项；
- `evidence`：证据数量与覆盖维度；
- `artifacts`：最近产物类型；
- `session.open_questions`：待确认问题；
- 最近 3–5 条会话标题/摘要；
- 当前新闻库是否有与 scope 相关的最新新闻。

生成规则（示例）：

| 状态 | 建议方向 |
|---|---|
| pre + 无计划 | “先用 2 个问题测一下你的起点”“告诉我你这周想解决的一个营销问题” |
| learning + 有 active 计划 | 围绕当前章节的具体概念/案例出 2–3 个可点击问题 |
| learning + 最近有新闻 | “用第4章分析这条最新新闻”“就这条新闻出 2 道情境题” |
| post / 有后测 | “用证据账本复盘”“只练错题”“换一个品类验证迁移” |
| 有未完成产物 | “继续改研究设计”“把 BP 第 2 节补证据” |

约束：

- 每次最多 3 个建议，必须具体到当前章节/概念/产物，不写泛化口号；
- 建议由 ChatAgent 或独立的 suggestion 生成步骤产出，主 Agent 只提供状态；
- 同一个 snapshot 下不重复生成；snapshot 变化后缓存失效；
- 模型失败/超时/无 Key 时才回退到固定兜底文案；
- 空态标题和说明也应由状态生成，至少不能永远写“今天想解决什么？”；
- 生成结果不能暴露 `intent/decision/phase/scope` 等内部字段。

### 3.5 兜底

模型失败、超时、子 Agent 失败时：

- 必须有一条可读回复；
- 说明“这轮没拿到足够信息/产物没生成”；
- 给一个可执行的下一步；
- 不暴露内部错误栈/枚举。

---

## 4. 出题、交卷与题库

### 4.1 出题

- 用户说“20 道题” → 生成 20 道；上限提高到 30，不再默认截断 10。
- 出题 Agent 负责：题型、难度、KP 绑定、答案、解析、校验。
- 题目集以原生 QuestionSet renderer 展示；ChatAgent 先给一段导语和做题建议。

### 4.2 交卷

- 题目集底部只有一个“交卷”按钮；
- 交卷前不显示答案/解析；
- 学生一次答完所有题；
- 交卷后统一判题：逐题显示对错、你的答案、标准答案、解析；
- 一次交卷只产生一个 TurnRecord，`attemptIds` 包含全部题目；
- 记录 Agent 统一抽 evidence，不逐题打断聊天。

### 4.3 题目整理 Agent

- 出题后异步运行；
- 按 normalized stem 去重；
- 非重复题目写入 `question_bank`；
- 字段：`question_id / stem_hash / stem / chapter_id / kp_ids_json / type / difficulty / source / usage_count / created_at / last_used_at`；
- 后续可从题库抽题、做错题重练、生成相似题；
- 不面向用户展示，不阻塞聊天。

---

## 5. 新闻与“最新消息”

- 学生给 URL → `crawlAndIngest`；
- 学生说“这条新闻/最新的消息/最新新闻” → 用当前会话最近入库新闻或 DB 最新新闻，不得退化成普通知识点；
- 学生说“搜一下/找新闻” → DeepSeek Search + 入库；
- 新闻分析后需要出题 → 基于新闻情境生成 QuestionSet；
- ChatAgent 拿新闻摘要 + 原文关键片段（不整篇）生成解释。

---

## 6. 显示清理清单

| 位置 | 现在 | 目标 |
|---|---|---|
| scope chip | `第4章 · 消费者行为 · 学习中` | `第4章 · 消费者行为` |
| 执行行 | `本次使用：出题 ›` | 删除 |
| 执行展开 | `explain · act`、`假设` | 删除 |
| 文档头 | `已生成 · v1` | 删除 |
| 文档操作 | `MD` `DOCX` | 一个下载/导出按钮 + 菜单 |
| 依据卡 | `知识点 · kp_consumer_definition` | `知识点 · 消费者` |
| 右栏 tab | `题目集 · 消费者市场与购买行为分析` | `题目集 · 20 题` |
| 产物打开 | 调研/BP/成长卡自动打开 | 只有题目集自动打开 |
| 助手正文 | 纯文本 pre-wrap | Markdown renderer（标题/列表/粗体正常渲染，不显示原始标记） |

---

## 7. 验收

1. 说“给我出 20 道题” → 生成 20 道，题目集 tab 显示 `题目集 · 20 题`。
2. 题目集交卷前无答案；交卷后逐题显示对错/解析；只产生一个 TurnRecord。
3. 出题后 `question_bank` 增加非重复题目；重复生成不重复入库。
4. 说“根据最新的消息给我出题” → 使用最新新闻，不退化。
5. scope chip 不显示“学习中”；聊天里没有“本次使用”行；文档头没有“已生成 v1”和 MD/DOCX 文字按钮。
6. 调研/BP/新闻分析后，ChatAgent 先给 2–5 段自然语言总结，卡片只是附件。
7. 依据卡显示知识点名称，不显示 `kp_*`。
8. 复杂解释达到 `paste-1.md` 的结构完整度（结论、知识点、证据、迁移结论、边界条件）。
9. 空对话页的建议随状态变化：pre / learning / post、不同章节、是否有新闻、是否有未完成产物，至少出现两组不同建议；固定三条只在模型失败时出现。
10. `pnpm typecheck`、`pnpm build:desktop`、`pnpm test:agent`、`pnpm test:ui-flow`、`pnpm test:ui-queue` 通过。

---

## 8. 实施顺序

1. 删显示：当前状态、工具行、执行枚举、已生成 v1、MD/DOCX 文字按钮。
2. ChatAgent 常驻：ask/plan/results/chat 全部走 ChatAgent；提高回复结构完整度；助手正文用 Markdown renderer。
3. 出题上限 20/30；交卷制；question_bank + 整理 Agent。
4. “最新消息”意图与新闻出题。
5. 空态建议动态生成：按 snapshot 生成标题/说明/2–3 个建议；固定三条只做失败兜底。
6. 测试与文档同步。

---

## 9. 当前实现状态（2026-10-18）

| 要求 | 状态 | 说明 |
|---|---|---|
| scope chip 不显示“学习中” | 已实现 | 只显示 `第4章 · 消费者行为` |
| 不显示“本次使用”工具行 | 已实现 | 聊天中删除执行块；上下文浮层也不显示工具 |
| 不显示“已生成 v1” | 已实现 | 文档头只保留标题和操作 |
| MD/DOCX 改为导出按钮 | 已实现 | 单个下载按钮 + Markdown/Word 菜单 |
| 20 道题 | 已实现 | 上限从 10 提到 30；测试生成 20 道 |
| 交卷制 | 已实现 | `answerQuestionSet`，一次 TurnRecord，交卷后统一判题 |
| 题目整理入库 | 已实现 | `question_bank` + `QuestionOrganizer`，按 stem hash 去重 |
| 最新消息出题 | 已实现 | “最新的消息/新闻”路由到 `news_lab`，使用最新入库新闻 |
| ChatAgent 常驻 | 已实现 | ask/plan/chat/results 都经过 ChatAgent；失败回退本地文本 |
| ChatAgent 选择展示 | 已实现 | `ChatResponse` 返回 text + 选中的 artifacts/citations；主 Agent 只挂载选中的产物 |
| ChatAgent 等待时间 | 已实现 | 复杂回合 25s、普通聊天 12s、追问/计划 8s；可用 `LEARNING_AGENT_CHAT_TIMEOUT_MS` 覆盖 |
| JudgeAgent 分离 | 已实现 | `judge.ts` 负责 phase/scope/intent/decision/工具选择；AgentService 只做会话、调度、TurnRecord、记录 |
| 出题不足自动补 | 已实现 | QuestionAgent 最多 3 次续出，按 stem 去重合并；结果暴露 requested/actual/shortfall |
| 回答灵动度 | 已实现 | 复杂解释按“结论 → 知识点 → 证据 → 迁移结论 → 边界条件”生成；助手正文用 Markdown renderer |
| 卡片不替代回复 | 已实现 | 非题目集不自动打开右栏；v0.3 起 `case_study` 作为本轮主学习表面也自动打开，其余卡片仍只做附件 |
| 依据显示名称 | 已实现 | 显示“消费者/参照群体”，不显示 `kp_*` |
| 空态建议动态生成 | 已实现（v0.3） | `AgentService.suggestions()` 按 phase/scope/证据/产物/新闻生成标题、说明与 2–3 个入口；固定三条只做接口失败兜底 |

验证命令：`pnpm typecheck`、`pnpm --dir apps/desktop exec tsc --noEmit`、`pnpm build:desktop`、`pnpm test:agent`、`pnpm test:ui-flow`、`pnpm test:ui-queue` 均通过。

关键验证数据：

- `test:agent`：20 道题生成成功；`question_bank` 23 条；重复整理 `inserted=0 / skipped=20`；“最新的消息”路由到 `news_lab`；批量交卷 `1/2`。
- `test:ui-flow`：交卷、上下文、调研/BP/成长卡、新闻分析+出题、导出/预览全部通过。
- `test:ui-queue`：执行中第二条消息排队并顺序处理。

## 10. 参考

- `local://paste-1.md`：WorkBuddy 胖东来案例回答（结论先行、知识点拆解、边界条件）
- [Codex Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Codex Web search](https://learn.chatgpt.com/docs/web-search)
- [Anthropic: Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Cherry Studio Chat Attachments](https://github.com/CherryHQ/cherry-studio/blob/main/docs/references/ai/chat-attachments.md)
