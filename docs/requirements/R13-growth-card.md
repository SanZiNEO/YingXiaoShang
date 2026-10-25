# R13 成长卡与能力评价

> 状态：MVP（本轮）
> 依赖：[R14 学情与记忆](R14-profile-memory.md)、[R09 出题与做题](R09-questions.md)、[R15 产物与导出](R15-artifacts.md)
> 代码：`packages/profile/src/index.ts`、`packages/agent/references/competency-rubric.md`、`apps/desktop/src/renderer/src/App.tsx`
> 上位原则：[`../principles/single-agent.md`](../principles/single-agent.md)

## 1. 要什么（学生可见结果）

- 学生问「我学得怎么样」「我有没有进步」，营小商先用一段人话回答：哪一维在动、凭什么、哪一维还不能下结论。要卡片时，右栏打开一张 HTML 成长卡。
- 评价对象是**四个能力维度**，不是题目对错、不是刷题数量、不是聊天时长：

  | 维度 | 一句话 |
  |---|---|
  | 问题建构 | 能不能定义真正的问题、边界、约束与利益相关者 |
  | 证据与假设 | 能不能区分事实、假设、观点，说明什么证据会推翻判断 |
  | 决策与取舍 | 能不能给出有条件的主张，比较替代方案，处理风险 |
  | 沟通与影响 | 能不能针对受众组织论证、回应质疑、推动行动 |

- 每个维度只有三种结论：**进步、停滞、证据不足**。证据不足时明说缺哪类证据、下一次怎么补，不硬给等级。
- 卡片上不出现总分、排名、正确率、L1–L4 编号、0–1 置信度。等级用中文词：起步 / 能套用 / 能情境化 / 能批判；证据用「独立任务 / 有过程记录 / 一次对话」描述。
- 这是形成性反馈：不记分、不进绩点、不做学生间比较。rubric 尚未由任课教师定稿，这一点必须写进卡片。

## 2. 落位（提示词 / 工具 / skill / 数据）

| 层 | 职责 |
|---|---|
| 提示词 | 识别「要复盘 / 要成长卡」；决定在聊天里讲还是产附件；规定卡片结构与不暴露项；只依据证据说话 |
| 工具 | **新增工具：`read_growth`**，按维度读当前水平与证据；`write_page` 写 HTML 成长卡 |
| skill / 手册 | `packages/agent/references/competency-rubric.md`：四维定义、四级表现、证据强度、反证要求、结论三选一 |
| 数据 | `competencies`（四维与四级描述）、`evidence`（学生原话与作答证据）、`growth_snapshots`（前测/后测快照）；由 `ProfileService.growthSummary()` 汇总 |

- 成长卡走**主循环**：模型读手册、按需读证据、自己写页面。不再使用 `ProfileService.generateGrowthCard()` 那条单独拼 system prompt 的调用路径（见 §7）。
- `read_growth` 按 [R03](R03-tools.md) 的加工具步骤只加一条 `ToolSpec`，不改调度与主循环。
- 代码只做统计与取数（等级加权中位、证据条数、前后测差值）；「这说明什么、下一步练什么」由模型按手册判断。统计规则写在这里，不为某个学生或某一章开特例。

## 3. 行为（一轮里怎么发生）

1. 学生说「我学得怎么样」「给我一张成长卡」。`StateProjector` 把阶段判为 `assessment`（[R14](R14-profile-memory.md)）。
2. 系统只给一行学情索引（阶段、证据条数、整理水位），不列四维明细；四维状态与证据由 `read_growth` 取。
3. 模型先调 `read_growth`：只是问一句 → 在聊天里讲完，结论先行，每维一句，最后给一个下一步；明确要卡片 → 再调 `write_page`。
4. 卡片固定顺序：总览结论（三选一）→ 四维各一段（当前水平、变化、支持证据、反例或待验证、下一步）→ 证据强度与 caveats。每维最多一个等级。
5. `write_page` 落库为 `type=page`、`format=html`、`content_json={title,html}`；右栏沙箱打开；导出即 HTML 原件。
6. 轮末由 [R14](R14-profile-memory.md) 的记录器写一次证据、摘要与快照；成长卡本身不重复写库。

## 4. 契约（工具签名、数据结构、字段、命令）

**维度 id 与中文名**（`data/students/student_demo/competencies.yaml`）：

| id | 名称 |
|---|---|
| `problem_framing` | 问题建构 |
| `evidence_hypothesis` | 证据与假设 |
| `decision_tradeoff` | 决策与取舍 |
| `communication` | 沟通与影响 |

**等级与证据**：内部 `L1`–`L4` / `unknown`；学生面只出现「起步 / 能套用 / 能情境化 / 能批判 / 证据不足」。证据强度 `A` 独立任务、`B` 有过程记录、`C` 单次对话、`D` 参与度或自评。`D` 永不作为能力证据；只有一条 `C` 时不定位等级。同一题目集内同一维度的多条 `C` 级作答按**一次观察**计，不因题量累加成等级；跨题目集、跨情境的独立表现才累加。内部状态还有 `待验证`（有当前等级但缺前后测对比），学生面表述为「变化待验证」，不新增第四种结论。

**新增工具：`read_growth`**

```ts
read_growth({
  dimension?: string   // 维度中文名；省略则返回四维
  chapterId?: string   // 省略用当前章节
  limit?: number       // 证据条数，默认 12，上限 30
}) => {
  dimensions: Array<{
    name: string
    levelWord: '起步' | '能套用' | '能情境化' | '能批判' | '证据不足'
    status: '进步' | '停滞' | '证据不足' | '待验证'
    evidenceCount: number
    preLevelWord?: string
    postLevelWord?: string
    latestExcerpt?: string
  }>
  evidence: Array<{
    dimension: string
    levelWord: string
    strengthWord: '独立任务' | '有过程记录' | '一次对话'
    occurredAt: string
    excerpt: string
    rationale: string
  }>
  caveats: string[]    // rubric 未定稿、证据仅来自单次对话等
}
```

约束：过滤 demo 种子证据、`review_status=rejected` 与 `D` 级；`excerpt` 截到 120 字；没有可用证据时 `dimensions[].status` 全为「证据不足」，`evidence=[]`，不返回空等级。

**成长卡页面**：`write_page({ title, html })`。`html` 为内联样式的 `<section>` 片段，不写 `<script>`、不引外链、不重复 `<h1>`。卡片不得包含：总分、排名、正确率、`L1`–`L4`、`kp_*`、0–1 置信度。

**导出**：`artifacts.export(artifactId, 'html')` 对页面类产物返回原文件路径；不把 HTML 转成 Markdown 或 Word。

## 5. 边界（不做什么、失败怎么表现）

- 不做积分、排行榜、正确率、通关、徽章；不做学生间横向比较。
- 不做六维、申诉、教师校准、锚例与一致性检验（属 backlog）。
- 不把做题对错直接当维度结论：单次作答只产生一条 `C` 级线索，客观题正确只说明识别层面。
- 不把 AI 生成内容、出勤、字数、聊天时长、PPT 页数当能力证据；不把学生自报「我会了」当证据。
- 不编造证据或引用：`read_growth` 没有的原文，卡片里不许出现。
- 学生要求「打个分 / 排个名」：说明这是形成性反馈，给等级词与证据，不给分数与名次。
- 失败表现：模型不可用 → 一句人话说明，不产卡；证据抽取失败 → 该维写「证据不足」并保留提示；页面为空 → 右栏提示「这份成长卡暂时没有可展示的内容」，不落半成品。

## 6. 验收（场景 → 期望）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 新学生第一句就问「我学得怎么样」 | 四维全部「证据不足」；说明缺哪类证据、下一次可以怎么补；不出现分数、排名、`L1`–`L4` |
| 2 | 只有一条 `C` 级证据 | 该维仍为「证据不足」；说明「一次对话不足以定位，需要再一次独立表现」 |
| 3 | 某维有 3 条 `B` 级证据，其中一条被驳回 | 结论只用剩余 2 条；卡片列出原文摘录与日期；能对应回原对话 |
| 4 | 「给我一张成长卡」 | 右栏打开页面标签；HTML 在沙箱渲染；无 `##`、无裸 JSON；可全屏、可导出 `.html` |
| 5 | 同一题目集 10 道选择题全对，但没有推理原话 | 按一次观察计，四维不因题量或正确率升级；最多出现「一次对话」级线索，并标注证据不足 |
| 6 | 「给我打个分 / 排个名」 | 说明不记分、不排名；给出等级词与支持证据，不出现积分或名次 |

## 7. 现状与差距（代码事实，路径 + 行号）

| 现状 | 位置 | 差距 |
|---|---|---|
| 四维与四级描述已落库种子，注明 rubric 需由任课教师与评价研究人员定稿 | `data/students/student_demo/competencies.yaml:5-60`、`pipeline/seed-student.ts:42-43,92-93` | 口径齐；rubric 仍未定稿，卡片必须带 caveat |
| `isAbilityEvidence` 排除合成证据、已驳回、`D` 级 | `packages/profile/src/index.ts:63-66` | 符合 |
| `weightedLevel` 对「只有一条 C」返回 `unknown`，按强度加权取中位 | `packages/profile/src/index.ts:69-99` | 符合「证据不足不给等级」 |
| `growthSummary` 输出等级、置信度、证据数、进步/停滞/证据不足/待验证、前后测 | `packages/profile/src/index.ts:382-428` | 置信度是内部值，学生面不得直接显示 |
| 前测/后测快照写入 `growth_snapshots`，仅在等级变化时新增 | `packages/profile/src/index.ts:331-379` | 符合「不重复写」 |
| 学习档案用中文等级词展示四维与证据账本，可认可/驳回 | `apps/desktop/src/renderer/src/App.tsx:74-80,384-425` | 仍显示「证据 N 条」；未展示卡片入口 |
| 作答证据按对错直接给 `L1`/`L2`，强度固定 `C`；同集多条会逐条累加 | `packages/agent/src/subagents.ts:330-345`、`packages/profile/src/index.ts:69-99` | 与「正确率不是能力证据」冲突；客观题应只记线索，同集多条按一次观察计 |
| `write_page` 已是唯一页面通道，HTML 直接落 `.html`，导出返回原件 | `packages/agent/src/tools/write-tools.ts:96-145`、`packages/artifacts/src/index.ts:121-124,171-176` | 符合 |
| 主循环没有读能力证据的工具；`read-tools.ts` 只有知识点、教材、手册、新闻 | `packages/agent/src/tools/read-tools.ts:19-380` | 待新增 `read_growth` |
| `generateGrowthCard` 仍单独调模型、单独拼 system prompt；只被旧管线调用（`packages/skills/src/index.ts:476`），桌面主路径无调用方 | `packages/profile/src/index.ts:455-487` | 违反 R01，应删除；成长卡改走主循环 |
| 对话轮写 `record_json: {}`，记录器不消费，聊天证据不落库 | `packages/agent/src/index.ts:499-502`、`packages/agent/src/recorder.ts:132-137` | 真实对话里会长期「证据不足」，需按 [R14](R14-profile-memory.md) 修 |
| 历史 `growth_card` 仍有专用渲染分支 | `apps/desktop/src/renderer/src/renderers.tsx:695-740,748-765` | 只服务旧产物；新卡一律 `page`，不再新增结构化分支 |

## 8. MVP 范围与后续

**MVP 做到哪**：四维；四级中文词；形成性反馈；证据强度与「证据不足」；前测/后测快照；`read_growth` 读证据；HTML 成长卡；右栏打开与导出；学习档案里可查证据、可认可/驳回。

**后续留什么**：rubric 教师定稿与锚例；六维（洞察、策略、品牌、数据、伦理等）；口头答辩与跨情境迁移任务；证据强度统计与置信度区间；学生申诉；教师抽样复核与一致性检验；成长卡按时间段对比。

**明确不做**：积分、排行榜、正确率、自动高利害评分、跨学生比较、家长端、把聊天活跃度当能力指标。
