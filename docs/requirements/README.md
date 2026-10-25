# 营小商 · 需求文档

> **一个需求一份文档。** 设计原则见 [`../principles/single-agent.md`](../principles/single-agent.md)，
> MVP 口径见 [`../mvp/mvp-v3.md`](../mvp/mvp-v3.md)。
> 本目录取代 `docs/90-archive/00-mvp-v2/` 下的旧文档；旧文档只用于追溯，不作为实现依据。

## 1. 怎么读

1. 先读原则：一个智能体；功能只落位到提示词 / 工具 / skill；上下文由模型按需取。
2. 再读 MVP：这一轮到底交付哪些需求、怎么验收。
3. 最后按编号读需求。每份固定八节：**要什么 / 落位 / 行为 / 契约 / 边界 / 验收 / 现状与差距 / MVP 范围与后续**。

需求之间只通过编号和契约互相引用，不复制对方内容。冲突时以原则为准，其次以 MVP 为准，再次以需求文档为准。

## 2. 需求表

| 编号 | 需求 | 状态 | 依赖 | 现状入口 |
|---|---|---|---|---|
| [R01](R01-single-agent.md) | 单一智能体 | MVP | — | `packages/agent/src/index.ts`、`tool-loop.ts` |
| [R02](R02-prompt.md) | 提示词装配 | MVP | R01 | `packages/agent/src/prompts.ts`、`agents/mentor.md` |
| [R03](R03-tools.md) | 工具层 | MVP | R01 | `packages/agent/src/tools/` |
| [R04](R04-skills.md) | Skill 与手册 | MVP | R02 | `packages/agent/skills/`、`references/` |
| [R05](R05-context-on-demand.md) | 上下文按需获取 | MVP | R02、R03 | `packages/agent/src/index.ts` 的 `environment()` |
| [R06](R06-knowledge.md) | 课程知识库 | MVP | R03、R05、R17 | `packages/knowledge/src`、`pipeline/` |
| [R07](R07-news.md) | 新闻 | MVP | R03、R05、R17 | `packages/news/src` |
| [R08](R08-matching.md) | 新闻-知识点匹配 | MVP | R06、R07 | `packages/matcher/src` |
| [R09](R09-questions.md) | 出题与做题 | MVP | R06、R07、R08、R14、R15 | `packages/questions/src` |
| [R10](R10-case-lesson.md) | 案例精讲 | MVP | R04、R06、R07、R15 | `packages/agent/src/case-coach.ts` |
| [R11](R11-research.md) | 调研设计 | MVP | R04、R05、R15 | `packages/research/src` |
| [R12](R12-bp.md) | 商业计划书 | MVP | R04、R05、R15 | `packages/bp/src` |
| [R13](R13-growth-card.md) | 成长卡与能力评价 | MVP | R09、R14、R15 | `packages/profile/src` |
| [R14](R14-profile-memory.md) | 学情与记忆 | MVP | R01、R05、R17 | `packages/agent/src/state.ts`、`recorder.ts` |
| [R15](R15-artifacts.md) | 产物与导出 | MVP | R03、R17 | `packages/artifacts/src`、`packages/export/src` |
| [R16](R16-conversation-ui.md) | 对话与三栏界面 | MVP | R13、R14、R15、R18、R19 | `apps/desktop/src/renderer/src/` |
| [R17](R17-local-data.md) | 本地数据 | MVP | —（被 R06 / R14 / R15 使用） | `packages/db/src`、`packages/fs-app/src` |
| [R18](R18-model-runtime.md) | 模型运行时 | MVP | R01、R17 | `apps/desktop/src/main/llm.ts` |
| [R19](R19-brand-copy.md) | 品牌与文案 | MVP | —（横切所有上屏文案） | `packages/shared/src/brand.ts`、`apps/desktop` |
| [R20](R20-run-verify.md) | 运行与验收 | MVP | R01–R19 | `package.json`、`scripts/`、`apps/desktop` |

「依赖」是阅读与契约顺序，不是构建顺序；数据层被多处使用，按各文档第 4 节的契约取用即可。

未立项的需求（多租户、六维评价、案例卡库、云部署等）见 [`backlog.md`](backlog.md)，不混进 MVP。

## 3. 状态怎么用

| 状态 | 含义 |
|---|---|
| **MVP** | 本轮要交付；文档里的「验收」就是验收口径 |
| **后续** | 方向已定但不排期；写清触发条件 |
| **不做** | 明确排除，任何实现提案先推翻这一条 |

一份需求可以整体 MVP，也可以部分 MVP：具体在每份文档第 8 节写清「MVP 做到哪 / 后续留什么 / 明确不做」。

## 4. 变更规则

- **新增需求**：加一个 `Rnn-*.md`，更新本表；不要在别人的文档里长出一节新功能。
- **改原则**：先改 `docs/principles/single-agent.md`，再逐个检查受影响的需求；原则没改就改需求，视为跑偏。
- **改契约**：工具签名、数据结构、表字段属于契约；改之前先看谁依赖它（本表「依赖」列 + 文档内引用）。
- **代码分支不是需求**：需求文档写「要什么」和「怎么验收」，不写「在哪个 if 里判断」。实现细节留在代码与提交里。
- **一个能力只落一个位**：同一件事不要既写提示词又写代码分支；确实需要组合时，在「落位」一节写清各层职责。

## 5. 与旧文档的关系

`docs/90-archive/00-mvp-v2/` 保存 2026-10-25 之前的 MVP、长远设计与单点方案，仅供追溯。
其中仍然有效的结论已经拆进本目录；**不要用旧文档反驳本目录**。
