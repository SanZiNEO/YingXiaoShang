# R09 出题与做题

> 状态：MVP（本轮）
> 依赖：[R06 课程知识库](R06-knowledge.md)、[R07 新闻](R07-news.md)、[R08 新闻-知识点匹配](R08-matching.md)、[R14 学情与记忆](R14-profile-memory.md)、[R15 产物与导出](R15-artifacts.md)
> 代码：`packages/agent/src/tools/write-tools.ts`、`packages/agent/src/index.ts`、`packages/agent/src/subagents.ts`、`packages/questions/src/index.ts`、`packages/shared/src/index.ts`、`apps/desktop/src/renderer/src/renderers.tsx`
> 上位原则：`../principles/single-agent.md`

## 1. 要什么（学生可见结果）

- 学生说「给我出 3 道题」，右栏出现一份题目集：题干、选项（或作答框）、交卷按钮；交卷前不显示答案。
- 学生逐题作答、交卷，系统逐题判对错，显示「你的答案 / 参考答案 / 解析 / 对应知识点」。
- 题目必须挂在真实知识点上；解析要能回到教材或新闻原文，不能只有一句「因为定义如此」。
- 交卷失败不会把学生判成答错；已判过的题重试时不重复记分。
- 同一来源、同一题干的题不重复出现；学生看不到 `kp_*`、`q_*`、置信度、内部步骤。

## 2. 落位（提示词 / 工具 / skill / 数据）

| 落位 | 内容 |
|---|---|
| 工具 | `emit_question_set`（写产物，`write-tools.ts:121`）；`generate_questions`、`validate_question`、`export_questions`（题库侧，`packages/questions/src/index.ts:1308`、`:1346`、`:1367`） |
| 判据 | `packages/agent/references/question-playbook.md`：题源、题型、难度、解析要求 |
| 数据 | `questions`、`question_attempts`、`question_bank`、`artifacts(type=question_set)` |
| 提示词 | `mentor.md`「出题与批改」：按数量出题、答案折叠、逐题给对错与解析、单题不建立高等级结论 |

出题是唯一的结构化产物；其余产物是 HTML 页面，见 [R15](R15-artifacts.md)。`generate_questions`、`validate_question`、`export_questions` 由 questions 插件注册，不在单一智能体九条工具清单内；对话主路径是 `emit_question_set`，题库侧工具用于校验、补题与导出。

## 3. 行为（一轮里怎么发生）

1. 模型先取材料：知识点用 `read_kp` / `read_material`，新闻用 `search_news` → `read_news`；案例卡题源属后续，本轮用新闻 + 知识点组合。
2. 判断题源与数量（1–30，默认按学生要求；学生没说就给 2–3 道），选择题型与难度。
3. 调 `emit_question_set`，一次 3–5 道，可调 2–3 次；系统按题干合并去重，本轮结束落库为一份 `question_set` 产物。
4. 右栏渲染题目卡：学生点选项或写文字；全部作答后才可交卷。
5. 交卷：逐题判分 → 写 `question_attempts` → 生成能力证据候选 → 返回逐题反馈与总结。
6. 反馈进入下一轮判断：错题多则先补概念，全对则换情境验证。

## 4. 契约（工具签名、数据结构、字段、命令）

### 4.1 `emit_question_set`

| 参数 | 类型 | 说明 |
|---|---|---|
| `title` | string | 产物标题 |
| `content` | object | `{ intro, questions[] }` |
| `content.questions[]` | array | `{ id, type, stem, options, answer, explanation, kpIds, difficulty }` |
| `markdown` | string? | 可选导出稿 |
| `sourceRefs` | string[]? | 来源 id（新闻、知识点、教材块） |

题目字段约束：

- `type`：名词解释 / 填空 / 判断 / 单选 / 多选 / 简答 / 案例分析。
- `options`：只写选项文字，不带「A.」前缀；单选/多选 2–6 个。
- `answer`：单选恰好对应一个选项；多选对应多个；判断题写「正确/错误」。
- `explanation`：解析，必须能指回教材定义或新闻原文。
- `kpIds`：知识点**中文名**，工具内部翻成 `kp_*`（`write-tools.ts:9-21`、`:154`）。
- `difficulty`：1 基础 / 2 应用 / 3 挑战，非法值回落 2。

合并规则：同一轮多次写入按题干前 60 字去重，后写入的题依次编号 `q1…qn`（`write-tools.ts:79-89`）。

### 4.2 题目集内容（`packages/shared/src/index.ts:763-779`）

`{ intro, questions: [{ id, type, stem, options[], answer, explanation, kpIds[], difficulty }] }`，schema 版本 `QuestionSet@1`，落库格式 `docx`（导出用）。

### 4.3 题源与门槛

| 题源 | 取什么 | 门槛 |
|---|---|---|
| 知识点 | 定义、关键词、例子、反例 | 知识点必须存在 |
| 新闻 | 标题、来源、时间、链接、摘要、正文前 8000 字 | 匹配必须是 `reviewed/adjudicated/published` + `verified/gold`（`packages/questions/src/index.ts:196-201`、`:1055-1075`） |
| 自定义文本 | 学生给的文本 | 必须同时给至少一个知识点 |
| 教学资源 | 教学指南或已有题目 | 章节知识点或原题知识点存在 |
| 案例卡 | 事实、约束、决策问题 | 属后续，见 §8 |

### 4.4 做题壳与判分

交卷入参：`{ studentId, sessionId, artifactId, answers: [{ questionId, answer }], chapterId? }`。
交卷出参：`{ turnId, text, results[], ledger, warnings, status }`，`status` 为 `completed` / `partial` / `failed`。

判分规则（`packages/agent/src/text.ts:127-181`）：

| 题型 | 规则 |
|---|---|
| 单选 | 选项索引完全相同才算对，1 / 0 |
| 多选 | 集合完全相同算对；部分命中算 partial，分数 = 命中数 / 正确数 |
| 判断 | 正确/错误、对/错、true/false 归一后比较 |
| 其他 | 与参考答案做字二元相似度：≥0.28 算对，≥0.12 算 partial |

拒绝条件（`packages/agent/src/index.ts:656-690`）：答卷为空、格式无效、全空、同一题重复、题目不属于该集、题目数据缺失——一律整单不写库，并说明原因。

### 4.5 作答写证据

每题交卷后写一条 `question_attempts`（答案、反馈 JSON、分数），并生成能力证据候选：

- `level`：客观题正确只记 L1；非客观题正确且分数 ≥0.6 才记 L2。
- `strength`：固定 C（单题不足以下高等级结论）。
- `confidence`：客观题正确 0.45、非客观题正确 0.5、partial 0.4、错误 0.3。
- `rationale` 说明为什么这条证据只能算线索。
- 证据由 `RecorderAgent` 落 `evidence` 表并挂到题目集产物（`packages/agent/src/recorder.ts:161-165`）。

### 4.6 去重与导出

- 题目 id：`q_` + `stableId(sourceType:sourceId:stem)`（`packages/questions/src/index.ts:218-224`）；同源同题干稳定同 id。
- 题干归一：去首尾空白、压缩空白（`:226-228`）。
- 同源已有题干集合参与校验（`:1234-1240`）；`question_bank` 以 `stem_hash` 唯一去重（`packages/db/src/index.ts:386-400`）。
- 导出：`export_questions` 支持 `json`、`csv`（UTF-8 BOM）、`docx`，写到 `LEARNING_AGENT_HOME/exports/questions-<timestamp>.*`（`packages/questions/src/index.ts:968-1048`）。

## 5. 边界（不做什么、失败怎么表现）

- 不出没有知识点的题；不出未审核新闻匹配的题；不凭常识编知识点。
- 交卷前不展示答案与解析；解析不写「略」「见教材」。
- 一道选择题、一条 C 级证据不建立高等级能力结论。
- 空卷、重复题、跨集题：拒绝并说明，不写半份记录。
- 部分题判分失败：`status=partial`，已判题不重判，未判题可重试；反馈不可用时明确说「没有算成你答错」。
- 题目数据缺失：交卷失败并说明「题目数据缺失」，不猜答案。
- 学生看不到内部 id、难度枚举、证据等级、工具名。

## 6. 验收（场景 → 期望）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 「给我出 3 道消费者情境题」 | 右栏出现一份 `question_set`，3 题，题干/选项/作答框可交互；交卷前无答案 |
| 2 | 学生逐题作答后交卷 | 逐题显示对错、你的答案、参考答案、解析、知识点中文名；顶部给「已交卷：x/y 题正确」 |
| 3 | 错题解析 | 解析能指回教材原文或新闻证据句；引用 locator 可定位（当前解析仅模型文本，见 §7） |
| 4 | 新闻匹配未审核时要求出题 | 拒绝出题并说明「匹配仍是自动候选（未审核）」，建议先审核或改用知识点 |
| 5 | 同一来源重复出同一题干 | 第二次不写入；题目集内多次 `emit_question_set` 也不出现重复题干 |
| 6 | 交卷时反馈服务不可用 | `status=failed/partial`；回复明确「没有算成你答错」；重试只重判未判题，已判题不重复记分 |
| 7 | 交卷后看证据 | 每题一条 attempt；证据为 L1（客观题）或 L2（非客观题且 ≥0.6），strength C，置信度 0.3–0.5 |
| 8 | 导出题目 | `export_questions` 生成 json / csv（带 BOM）/ docx，路径在 `LEARNING_AGENT_HOME/exports/` |

## 7. 现状与差距（代码事实）

- 写入工具：`emit_question_set` 在 `packages/agent/src/tools/write-tools.ts:121-159`；产物规格 `QUESTION_SET` 在 `:47-94`（`docx`、`QuestionSet@1`）；中文名转 id 在 `:9-21`。
- 内容 schema：`QuestionSetContentSchema` 在 `packages/shared/src/index.ts:763-779`。
- 做题壳：`QuestionSetRenderer` 在 `apps/desktop/src/renderer/src/renderers.tsx:97-260`；交卷按钮在全部作答前禁用（`:201-229`）；交卷结果处理在 `apps/desktop/src/renderer/src/App.tsx:975-987`。
- 交卷入口：`answerQuestionSet` 在 `packages/agent/src/index.ts:656-690`；`submitAnswerSet` 在 `:701-900`；IPC 在 `apps/desktop/src/main/index.ts:453-460`。
- 判分：`FeedbackAgent.run` 在 `packages/agent/src/subagents.ts:248-385`；`scoreAnswer` 在 `packages/agent/src/text.ts:127-181`；写 attempt 在 `subagents.ts:279-285`，表在 `packages/db/src/index.ts:187-191`。
- 题库侧：`generate_questions` / `validate_question` / `export_questions` 在 `packages/questions/src/index.ts:1308`、`:1346`、`:1367`；`generate()` 在 `:887-966`，离线兜底 `offlineQuestions` 在 `:840-885`；题目校验规则在 `:298-424`。
- 关键差距（阻塞验收 1–2）：`emit_question_set` 只写 `artifacts.content_json`，不写 `questions` 表；而 `answerQuestionSet` 要求 `db.getQuestion(questionId)` 存在（`packages/agent/src/index.ts:684-686`），`FeedbackAgent` 也按 id 查题（`subagents.ts:276`）。因此模型直接出的题目前无法交卷判分。修复方向：产物落库时把题目写入 `questions`（`source_type='kp'/'news'`，`id` 用稳定 hash），或判分时从 `content_json` 取题并补写题库。
- 解析引用差距：`FeedbackAgent` 的 citations 只取知识点定义（`subagents.ts:350-358`），新闻来源的题不会引用新闻原文；错题解析目前没有原文定位。
- 去重差距：`question_bank` 只被旧路径 `packages/agent/src/question-organizer.ts:35-45` 使用；单一智能体路径靠 `questions.id` 与 `existingStems` 去重，题库去重未接入。
- 知识点绑定差距：`resolveKpIds` 对认不出的中文名静默丢弃（`write-tools.ts:9-21`），不会报错；模型写错知识点名时会生成 `kpIds=[]` 的题，违反「每题必须绑定知识点」。修复：未识别名称回错给模型，或拒绝该题。
- 难度约束差距：`emit_question_set` 只把非法难度回落 2，不封顶 3（`write-tools.ts:57-62`）；模型给 4 会原样落库，`QuestionSetContentSchema` 也不校验范围（`packages/shared/src/index.ts:763-779`），与工具说明的 1–3 不一致。
- 选项与答案校验差距：`emit_question_set` 不检查选项数、选项是否重复、答案是否对应某个选项；这些规则只在 `validateQuestion`（`packages/questions/src/index.ts:298-424`）与 `scoreAnswer` 里，产物通道目前不调用它们。
- 旧路径：`packages/agent/src/news-lab.ts:404-426` 仍构造 `question_set` 产物；属旧多角色管线，收敛见 [R01](R01-single-agent.md)。
- 待核对：`data/normalized/questions.json` 现有 456 道种子题；本地库实际题数、attempt 数、证据条数以 `pipeline:quality` 与运行库为准。

## 8. MVP 范围与后续

**MVP 做到哪**

- 学生要题 → 一份 `question_set` → 可作答 → 可交卷 → 逐题解析 → 作答写 attempt 与证据。
- 题目必须绑定知识点；新闻题源必须已审核；未审核明确拒绝。
- 单选/多选/判断按规则判分；填空/名词解释/简答/案例分析按字面相似度判分并标 partial。
- 交卷失败可重试，已判题不重复记分；空卷与跨集题拒绝。
- 导出 json / csv / docx。

**后续**

- 修掉「模型出题不落 `questions` 表」的断链，让做题壳与题库共用同一份题。
- 解析与反馈引用题源原文（新闻 `evidence_span`、教材 `content_block`），错题可一键回看依据。
- 题库去重接入 `question_bank`；同一知识点控制出题频次，避免反复出同型题。
- 案例卡题源：按案例卡 schema 出决策备忘录、投资委员会、危机响应等情景题，配 rubric 与锚例。
- 主观题判分从字面相似度升级为按要点/rubric 判分，并保留人工复核入口。

**不做**

- 不做刷题器、不做题海、不做排名。
- 不做自动组卷与考试系统；不做教师端批改台。
- 不把 AI 产物当学生证据；不因一次全对给高等级结论。
- 不为某道题、某个知识点写判分特例。
