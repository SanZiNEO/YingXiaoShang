# R10 案例精讲

> 状态：MVP（本轮）
> 依赖：[R04](R04-skills.md)、[R06](R06-knowledge.md)、[R07](R07-news.md)、[R15](R15-artifacts.md)
> 代码：`packages/agent/src/case-coach.ts`、`packages/agent/src/case-library.ts`、`packages/agent/skills/case-coach/SKILL.md`、`packages/agent/references/case-playbook.md`
> 上位原则：`../principles/single-agent.md`

## 1. 要什么（学生可见结果）

学生说「拿个案例讲给我听」「这条新闻该用什么知识分析」「把 XX 精讲一下」时，得到一份能看懂、能核对的讲解：

- **定义先行**：这个概念是什么、不是什么、怎么判断一段内容在讲它。
- **案例对应**：案例的哪一部分对应定义的哪一部分，一句一处。
- **逐条原文证据**：每条都带引文、来源标识、来源标题；找不到原文就写「缺少可引用的原文证据」。
- **案例对话至少 2 个来回**：学生先问、营小商回应，每个来回只推进一步。
- **收束**：一条可迁移结论、一条「什么条件下不成立」、**一个**检查问题。

学生没明确要附件时，这套结构在聊天里讲完，不进右栏。学生要一份能带走的，产出一份 HTML 页面（`page`）。**无来源的断言不合格**；学生追问「那学习呢」时**只展开被追问的那一点**，不重讲全篇。

## 2. 落位（提示词 / 工具 / skill / 数据）

| 层 | 放什么 | 位置 |
|---|---|---|
| 提示词 | 什么时候讲、什么时候产附件、追问只展开、不替学生下结论 | `packages/agent/agents/mentor.md:92-98`（案例精讲）、`:124-133`（产物怎么出） |
| skill | 判据：11 项自查，任一项不过就不交付 | `packages/agent/skills/case-coach/SKILL.md` 第五节 |
| 手册 | 六步做法与边界 | `packages/agent/references/case-playbook.md`；页面硬约束见 `references/artifact-schemas.md` 第 2 节 |
| 工具 | 取材料 + 写页面 | `read_material`、`read_textbook`、`search_news`、`read_news`、`read_reference`、`write_page` |
| 数据 | 教材案例片段与标签、新闻与匹配 | `content_blocks`（`block_type='case_fragment'`）、`content_tags`、`news_articles`、`case_matches` |

**不需要新增工具**：精讲是「读材料 → 判断 → 写页面」，现有 9 个工具够用。**不新增产物类型**：精讲就是 `page`，不回到 `case_study` 结构化。

## 3. 行为（一轮里怎么发生）

1. **判类型**：概念解释 / 案例精讲 / 新闻分析。三者结构同构，深度不同。
2. **判要不要附件**：学生明确说「给我一份/做成附件/精讲」才写；只说「为什么」就在聊天里讲。
3. **取材料**：先 `read_reference('case-playbook')` 确认做法；再 `read_material`（1–4 个知识点，含教材原文）或 `search_news` → `read_news` 取新闻正文。教材原文与新闻原文**分别标注来源类型**。
4. **写定义**：回答三问；定义写不清就不往下走。
5. **写对应与证据**：逐条映射、逐条标来源；引文必须是工具返回的逐字片段。
6. **写对话**：学生先问，至少 2 个来回。
7. **收束**：`takeaway` + `boundary` + 一个 `checkQuestion`。
8. **落页面**：内容长就分 2–3 次 `write_page`，每次一段 `<section>`。
9. **回复**：只说判断、关键取舍、证据缺口、下一步，不抄正文。

## 4. 契约

### 4.1 页面骨架（`write_page` 的 `html`，按此顺序）

| 小节（`<h2>`） | 必须写清 |
|---|---|
| 一句话结论 | 这是什么现象、卡在哪 |
| 定义 | 是什么 / 不是什么 / 怎么判断，≤160 字 |
| 案例对应 | 「案例的哪一部分 → 定义的哪一部分」，一句一处 |
| 原文证据 | 每条一个引用块 + 一行来源；事实与「教学假设」分开标 |
| 案例对话 | 学生与营小商交替，≥2 个来回，每轮只推进一步 |
| 换个情境还成立吗 | 1–2 条迁移结论 |
| 什么时候不成立 | 具体到条件，不重复定义 |
| 想一想 | **一个**检查问题 |

### 4.2 证据三字段

页面上每条证据必须能还原成 `{ quote, sourceId, sourceTitle }`：

- `quote`：逐字原文，不做二次概括后仍标「原文」；只能概括时标「转述」并说明结论强度受限。
- `sourceTitle`：教材章节名 / 媒体名 + 报道日期，学生看到的是这一项。
- `sourceId`：进 `write_page` 的 `sourceRefs`，右栏「依据」用它回原文。
- 正文里**不写** `kp_*`、`src_*` 这类内部 id，只写中文名。

### 4.3 教材案例与新闻案例的区别

| | 教材案例 | 新闻案例 |
|---|---|---|
| 材料来源 | `content_blocks` 的 `case_fragment` + `content_tags` 标签召回 | `news_articles` 正文，`case_matches` 提供知识点匹配 |
| 证据强度 | 教材原文，可逐字引用 | 只有**已人工审校**的匹配才能当教学证据 |
| 未审校时 | — | 只作展示材料，**不作教学映射、不作出题锚点** |
| 必填元信息 | 章节 + 段落定位 | 媒体名 + 报道日期 + 链接 |
| 缺日期/缺正文 | 标「资料不足」 | 标「资料不足」，不进题库 |

## 5. 边界（不做什么、失败怎么表现）

- **不编造**：不虚构案例细节、数据、引文、报道时间；宁可写「资料不足」。
- **不替学生下结论**：给定义、给证据、给反例，不写「你应该/建议你」。
- **不越界评价**：水平判断属 [R13](R13-growth-card.md)，本需求只给材料与证据候选。
- **不扩写**：一个概念不自动扩写邻近章节；追问只展开被问的点。
- **不产结构化案例**：不写 `case_study` 类型、不配专属渲染器。
- **失败表现**：知识点库里查不到 → 说明缺哪条，不即兴造概念；引文核不上 → 删掉该条证据或降级为「转述」，不留半条；页面校验失败 → 本轮不产附件，回复里说「可以让我重做一次」。

## 6. 验收（场景 → 期望）

1. **「拿胖东来讲讲购买角色」** → 右栏出现一份页面，含定义、案例对应、逐条带来源的证据、≥2 个来回的对话、一个检查问题；正文无一条无来源断言。
2. **精讲后追问「那学习呢」** → 只展开「学习」，不重讲全篇，不新增产物，回复长度明显短于首次。
3. **「这条新闻用什么知识分析」+ 新闻缺日期** → 明说资料不足，只作展示材料；不生成教学映射，不写成「已审校」。
4. **学生说「直接告诉我答案」** → 给定义、给证据、给反例，把结论留白；页面里不出现「你应该」。
5. **教材案例请求**（「教材里那个案例讲讲」）→ 引文逐字来自 `read_textbook` 返回，`sourceTitle` 为章节名，学生能点「依据」回原文。
6. **只要解释不要附件**（「购后失调是什么」）→ 只在聊天里讲，右栏不新增标签。

## 7. 现状与差距（代码事实）

- **现行路径已通**：`write_page` 是唯一的页面写入工具（`packages/agent/src/tools/write-tools.ts:97`），产物类型 `page`、格式 `html`；提示词里已写死「精讲案例写成 `write_page`」（`packages/agent/agents/mentor.md:130`）。
- **判据未接线**：`packages/agent/skills/case-coach/SKILL.md` 存在，但 `packages/agent/src` 里没有 skill 加载器；落库时 `skillId` 固定为 `'agent'`（`packages/agent/src/artifacts.ts:115`），`templateId` 直接取产物类型（`:116`）。skill 目前只是规范先行（见 `packages/agent/skills/README.md` 末节）。
- **旧管线仍在仓库**：`packages/agent/src/case-coach.ts:585` 的 `CaseCoachAgent` 没有任何调用方（`packages/agent/src` 内仅本文件定义），是死代码。
- **业务判断写进了代码**（违反原则第 2 条）：`case-coach.ts:606` 用正则识别「胖东来/永辉/步步高/商超/超市」；`case-library.ts:64` 写死 `SUPERMARKET_META`（三家商超案例）；`case-library.ts:164` 的 `partWantsLoyalty` 用正则判学生意图；`case-coach.ts:312` 的 `dialogueForKp` 用代码拼出固定对话。
- **证据校验只在离线**：`case-library.ts` 的 `locateQuote` 做逐字校验，`tools/verify-case-quotes.py` 校验 `docs/cases/*.md` 的引文，但只被自己的说明引用，未进 `package.json` / `scripts`，运行时没有对应工具（待核对：是否有 CI 调用）。
- **历史结构化分支仍在**：`case_study` / `case_analysis` 的渲染分支留在 `apps/desktop/src/renderer/src/renderers.tsx:757`、`:755`，只为库里的历史产物服务；`CaseStudyContentSchema`（`packages/shared/src/index.ts:856`）里的对话角色枚举（`:883`）也只服务历史产物。
- **新闻侧材料可用**：`news_articles`（`packages/db/src/index.ts:140`）、`case_matches`（`:157`）已在库里；未审校匹配的闸门在 `case-library.ts` 的 `evidenceForPart`（只有已审校映射才转成教学证据）。

## 8. MVP 范围与后续

**MVP 做到哪**

- 精讲统一走 `write_page`；页面八小节结构写进提示词与 `artifact-schemas`。
- 证据三字段（`quote` / `sourceId` / `sourceTitle`）+ 事实与「教学假设」分离。
- 对话 ≥2 个来回、一个检查问题；追问只展开被问点。
- 教材案例与新闻案例的元信息、审校闸门按第 4.3 节区分。

- `case-coach` 判据通过 [R04](R04-skills.md) 的 `read_skill` 进入一轮，而不是只做文档。

**后续**

- 运行时引文校验：**新增工具：`verify_quote(sourceId: string, quote: string)`**（返回是否逐字命中与段落定位），把离线脚本的能力搬进对话。
- 案例卡检索：**新增工具：`search_case_cards(query: string, chapterId: string)`**（按标签召回教材案例片段），替代正则挑案例。

**明确不做**

- 不做 `case_study` / `case_analysis` 新产物，不为精讲配渲染器或模板。
- 不做按品牌、按新闻写的分支。
- 不做自动评分与水平判断（属 [R13](R13-growth-card.md)）。
