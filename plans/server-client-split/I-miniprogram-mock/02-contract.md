# I · 小程序 UI 原型（纯 mock）· 契约

> 轮次：I · 小程序纯静态 mock 原型
> 文档角色：02-contract
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1（本文件只细化展示层契约，不新增方法、不改错误码、不碰 §6 排除项）
> 一句话：实现者照这份文档写 5 个静态页面与 5 份 fixture，验收者照这份文档逐字段、逐文案、逐导航路径判过。

## 1 契约总览

| 层 | 冻结口径（来自 master） | 本轮细化 |
|---|---|---|
| 方法面 | 冻结 §5 的 `student.current` / `news.list` / `news.get` / `questions.attempts` / `profile.get` 五个只读方法 | 每页绑定一个方法；方法名只出现在接缝标注里，原型不发 RPC 请求 |
| 返回结构 | 冻结 §5 顶层形状 + `packages/shared/src/index.ts` 的 zod schema | `fixtures/*.json` 逐字段类型、可空性、示例值（§3） |
| 排除项 | 冻结 §6：`files.reveal` / `files.preview` / `files.openDialog` / `settings.get` / `settings.set` 小程序 mock 一律不碰 | 5 页与脚本中不得出现这 5 个能力的入口（§6.2） |
| 三态 | 冻结文件未规定原型态；本轮自定 loading / error / empty 演示分支 | 切换参数、渲染分支、逐字文案（§4、§5） |
| 布局 | 冻结文件未规定；参照小程序设计指南 375 宽度惯例 [R1] | 宽度、点击区、换行、无横向滚动判据（§3.5） |
| 数据通道 | 冻结 §2 的 HTTP 传输与原型无关 | 纯静态读取本地 fixture；`file://` 双通道兜底（§5.3） |

**契约稳定性**：本文件写死的字段名、fixture 文件名、页面文件名、URL 参数名、中文文案，视为 I 轮 v1 口径。后续真机阶段允许把 loader 换成 HTTP 调用，但页面字段名与文案不得回改；新增展示字段时页面必须容忍未知字段（§6.1）。方法命名沿用冻结 §5 的点分写法，不另起 camelCase 别名 [R7]。

**页面与方法对应表**（与 `01-scope.md` §5 产物清单一致）：

| 页面 | 文件 | 冻结方法 | fixture | 现状依据 |
|---|---|---|---|---|
| 首页 | `pages/home.html` | `student.current` | `fixtures/student.json` | `apps/desktop/src/main/index.ts:209-212` |
| 新闻 | `pages/news.html` | `news.list` | `fixtures/news-list.json` | `apps/desktop/src/main/index.ts:251-256` |
| 新闻详情 | `pages/news-detail.html` | `news.get` | `fixtures/news-detail.json` | `apps/desktop/src/main/index.ts:274-282` |
| 问答 | `pages/ask.html` | `questions.attempts` | `fixtures/attempts.json` | `apps/desktop/src/main/index.ts:290-295` |
| 我的 | `pages/profile.html` | `profile.get` | `fixtures/profile.json` | `apps/desktop/src/main/index.ts:296-297` |

## 2 页面与组件契约（逐页）

> 组件命名沿用现状渲染层的习惯（卡片 `Card`、行 `Row`、标签 `Tag`、空态 `Empty`，见 `apps/desktop/src/renderer/src/ui.tsx:34`、`:155`、`:176`、`:216`）；原型用纯 HTML/CSS 复刻这些角色，不引入组件库。
> 每个组件块必须带接缝标注（格式见 §2.6），标注它将来替换成哪个方法的真实调用。
> 本版组件只表达信息结构与跳转关系，不追求高保真视觉，线框原型的取舍取向参照 [R8]。

### 2.1 首页 `pages/home.html`（`student.current`）

| 组件 | 绑定字段 | 展示规则 | 空值兜底 |
|---|---|---|---|
| 身份卡片 | `student.name`、`student.cohort`、`student.studentId` | 主行显示 `name`；副行显示 `cohort · studentId`；`cohort` 为空时副行只显示 `studentId` | `name` 缺失显示「学生」（对齐 `index.ts:211` 兜底）；整对象缺失走 §4 空态 |
| 导航入口列表 | — | 4 个可点行：新闻、问答、我的；另含「新闻详情」说明入口（从新闻列表进入） | — |
| 三态占位节点 | — | `[data-state="loading|error|empty|normal"]` 四个容器，脚本按当前态显隐 | — |

首页不出现「设置」「导出」「打开文件夹」入口；身份卡片不提供编辑按钮（原型只读）。

### 2.2 新闻列表 `pages/news.html`（`news.list`）

| 组件 | 绑定字段 | 展示规则 | 空值兜底 |
|---|---|---|---|
| 页头 | 数组长度 | 标题「新闻」+ 条数 `新闻（N）`，对齐 `apps/desktop/src/renderer/src/pages.tsx:282` | 条数为 0 时标题仍显示 `新闻（0）` |
| 新闻卡片行 | `article.id`、`article.title`、`article.source`、`article.published_at` | 首行 `title`；次行 `source · published_at`，日期截取前 10 位（`pages.tsx:289`）；整行可点 | `title` 缺失显示「无标题新闻」；`published_at` 缺失次行只显示 `source` |
| 跳转 | `article.id` | 点击行跳 `news-detail.html?articleId=<id>` | 无 `id` 的行不可点，置灰 |
| 空态区块 | 数组长度 | 长度 0 时显示 §4.2 空态文案 | — |

列表不展示 `summary`、`author`、`rights` 到首行；这些字段保留在 fixture 里供详情或后续使用。

### 2.3 新闻详情 `pages/news-detail.html`（`news.get`）

| 组件 | 绑定字段 | 展示规则 | 空值兜底 |
|---|---|---|---|
| 返回行 | — | 「← 返回新闻列表」链接到 `news.html` | — |
| 标签行 | `article.source`、`article.content_status` | 两个标签：来源标签、状态标签（`pages.tsx:302-303`）；`content_status` 取值限 `full / partial / unavailable` | 字段缺失不渲染对应标签，不留空标签框 |
| 原文链接行 | `article.url` | 渲染为文本链接样式；原型阶段不发起真实跳转，`href` 保留但标注为真机替换点 | `url` 为空整行不渲染 |
| 正文段 | `article.content` | `white-space: pre-wrap`，长文纵向滚动、横向换行（不照搬桌面端 `maxHeight:300` 的内部滚动） | `content` 为空显示 §4.2 详情空态 |
| 知识点匹配区 | `matches[]`：`kpName`、`tag_role`、`confidence`、`evidence_span`、`rationale` | 每条一张卡片：标题行 `kpName · tag_role`；置信度 `confidence` 转百分比取整；正文 `evidence_span`；附 `rationale` | 数组长度 0 显示「尚未匹配」（`pages.tsx:313` 逐字） |
| 思政匹配区 | `ideology[]`：`ideology_id`、`confidence`、`evidence_span`、`rationale` | 每条一行：`ideology_id` + 置信度 + 摘录 | 数组长度 0 时整区不渲染 |
| 未选中占位 | — | 无 `articleId` 参数或 fixture 无对应文章时，显示「选择一条新闻查看原文与匹配证据」（`pages.tsx:299` 逐字） | — |

### 2.4 问答 `pages/ask.html`（`questions.attempts`）

| 组件 | 绑定字段 | 展示规则 | 空值兜底 |
|---|---|---|---|
| 记录行 | `attempt.question_id`、`attempt.score`、`attempt.answer`、`attempt.created_at` | 行首对错标签：`score >= 0.99` 显示「答对」，否则显示「答错」（判据对齐 `apps/desktop/src/renderer/src/renderers.tsx:142`）；题干位显示 `question_id`；时间取 `created_at` 前 10 位 | `score` 缺失不打对错标签；`answer` 缺失显示「未作答」 |
| 展开区 | `attempt.answer`、`attempt.feedback_json` | 展开后显示「你的答案：…」；`feedback_json` 非空对象时摘录其中 `message` 文本，无文本则不展开 | 参考答案与解析在原型里不渲染：`questions.attempts` 返回结构不含题目正文（`packages/shared/src/index.ts:260-268`），该位置标注真机从题目集产物读取 |
| 空态区块 | 数组长度 | 长度 0 显示 §4.2 问答空态 | — |

问答页不提供「提交答案」「交卷」按钮；原型只读，写回通道 `/api/v1/answer`、`/api/v1/answer-set` 不在本页接线。

### 2.5 我的 `pages/profile.html`（`profile.get`）

| 组件 | 绑定字段 | 展示规则 | 空值兜底 |
|---|---|---|---|
| 页头 | `profile.name`、`profile.cohort` | 主行 `name`；副行 `cohort`；缺失时副行不渲染 | 整 `profile` 为 null 走 §4.2 档案空态 |
| 目标与约束区 | `profile.goals[]`、`profile.constraints[]`、`profile.preferences{}` | 目标逐条 `· …`；约束逐条「约束：…」；偏好按键值对列出（结构参照 `apps/desktop/src/renderer/src/App.tsx:335-339`） | 三个容器全空时显示「还没有记录目标与约束。」 |
| 能力维度网格 | `growth[]`：`competency.name`、`status`、`level`、`evidenceCount`、`latestEvidence.excerpt` | 每格：能力名 + 状态标签；等级大字；`证据 N 条`；有最新证据时引用摘录（参照 `App.tsx:366-377`） | `growth` 长度 0 显示「还没有形成能力快照。」（`App.tsx:363` 逐字） |
| 证据账本 | `evidence[]`：能力名（冗余自 `competencies` 回查）、`level`、`strength`、`review_status`、`excerpt`、`occurred_at` | 每行标签组：能力名、等级、证据强度、复核状态；正文 `excerpt`；右侧日期前 10 位（参照 `App.tsx:387-397`） | `evidence` 长度 0 显示「还没有学生能力证据。」（`App.tsx:386` 逐字） |

`competencies[]` 在本页仅用于把 `evidence.competency_id` 回查成能力名；回查不到时标签显示「能力维度」（对齐 `App.tsx:389` 兜底）。

### 2.6 接缝标注格式

**选定方案：`data-*` 属性为主，不依赖 HTML 注释。**

- 理由一：可检索、可统计。验收时用 `document.querySelectorAll('[data-mock-source]')` 即可数出所有接缝；HTML 注释在后续压缩或转写到小程序框架时容易被丢弃，`data-*` 会随 DOM 保留。
- 理由二：属性值是机器可读的键值对，方法名、fixture 名、替换通道可以分开写，避免注释散文里出现方法名拼写漂移。
- 注释只在需要一句 prose 说明时补充，不作为标注的唯一载体。

标注属性清单：

| 属性 | 取值 | 出现位置 | 含义 |
|---|---|---|---|
| `data-mock-source` | 冻结方法名，如 `news.list` | 每个读数据的组件块 | 真机阶段此块替换为该方法的真实调用结果 |
| `data-fixture` | fixture 文件名，如 `news-list.json` | 页面根节点 | 当前数据来自哪份本地 JSON |
| `data-replace` | `transport` / `navigation` / `data-field` | 具体接缝元素 | 替换类型：换传输层 / 换路由 / 补真实字段 |
| `data-excluded` | `true` | `index.html` 排除说明区 | 标记本节列出的是 §6 排除能力，不是遗漏入口 |

示例（新闻卡片行）：

```html
<article class="row" data-mock-source="news.list" data-replace="data-field"
         data-article-id="news-001">
  <div class="row-title">…</div>
  <div class="row-sub">36kr · 2026-11-19</div>
</article>
```

## 3 数据结构（fixtures schema 逐字段）

> 通用规则：JSON 为 UTF-8、无注释、无尾逗号；字符串中文不转义；日期为 ISO-8601 字符串；`null` 只允许在「可空」列标「是」的字段出现，其余缺省给空串或空数组。类型口径对齐 `packages/shared/src/index.ts` 的 zod schema；原型 fixture 是 schema 的样例子集，已出现的字段名不得改写 [R6]。

### 3.1 `fixtures/student.json` — `student.current`

顶层为对象（非数组），来源 `apps/desktop/src/main/index.ts:209-212`。

| 字段 | 类型 | 可空 | 示例值 | 说明 |
|---|---|---|---|---|
| `studentId` | string | 否 | `"20230001"` | 学号；原型不做登录，直接展示 |
| `name` | string | 否（缺省兜底 `"学生"`） | `"张三"` | 姓名；空串时页面兜底为「学生」 |
| `cohort` | string | 是（缺省 `""`） | `"2023"` | 届别；空串时副行省略 |

示例：

```json
{ "studentId": "20230001", "name": "张三", "cohort": "2023" }
```

### 3.2 `fixtures/news-list.json` — `news.list`

顶层为 `NewsArticle[]`，元素 schema 来源 `packages/shared/src/index.ts:124-137`。

| 字段 | 类型 | 可空 | 示例值 | 说明 |
|---|---|---|---|---|
| `id` | string | 否 | `"news-001"` | 文章唯一键；详情页 `articleId` 取它 |
| `source` | string | 否 | `"36kr"` | 来源标签 |
| `source_id` | string | 否（缺省 `""`） | `"sr-8841"` | 侧车源内编号；列表页不展示 |
| `title` | string | 否 | `"秋日消费市场观察：理性下单回暖"` | 卡片首行 |
| `url` | string | 否（缺省 `""`） | `""` | 详情页原文链接；原型不真实跳转，真机填入文章原文地址 |
| `author` | string | 是（缺省 `""`） | `"本报记者"` | 列表页不展示，字段保留 |
| `published_at` | string | 否 | `"2026-11-19T08:30:00.000Z"` | ISO 时间；展示截前 10 位 |
| `summary` | string | 是（缺省 `""`） | `"摘要一句话"` | 列表页不展示，字段保留 |
| `content` | string | 否 | `"正文段落…"` | 详情页正文；列表 fixture 可放截断样例 |
| `content_status` | enum `full` / `partial` / `unavailable` | 否 | `"full"` | 状态标签取值受限 |
| `rights` | string | 是（缺省 `""`） | `"转载需授权"` | 保留字段，原型不展示 |
| `fetched_at` | string | 否 | `"2026-11-19T09:02:11.000Z"` | 入库时间；保留字段 |

数组至少放 3 条正常样例，其中 1 条 `content_status` 为 `partial`；另含 1 条超长标题或长摘录用于换行验证（§7 MT-I-07）。

### 3.3 `fixtures/news-detail.json` — `news.get`

顶层为对象 `{ article, matches, ideology }`，来源 `apps/desktop/src/main/index.ts:274-282` 与 `apps/desktop/src/renderer/src/model.ts:95-99`。

| 字段 | 类型 | 可空 | 示例值 | 说明 |
|---|---|---|---|---|
| `article` | `NewsArticle` 对象 | 否 | 同 §3.2 单元素 | 与列表项同构；详情页主数据 |
| `matches` | `Match[]` | 否（缺省 `[]`） | 见下 | 知识点匹配 |
| `ideology` | `IdeologyMatch[]` | 否（缺省 `[]`） | 见下 | 思政匹配 |

`matches[]` 元素：

| 字段 | 类型 | 可空 | 示例值 | 说明 |
|---|---|---|---|---|
| `kp_id` | string | 否 | `"kp_consumer_market"` | 知识点键 |
| `kpName` | string | 是（缺省 `""`） | `"消费者市场"` | 展示名；缺失时回退 `kp_id` |
| `confidence` | number | 否 | `0.82` | 区间 0..1；展示为百分比取整 |
| `tag_role` | string | 否 | `"例证"` | 角色标签 |
| `evidence_span` | string | 否 | `"消费者在促销季更看重性价比…"` | 摘录正文 |
| `rationale` | string | 否（缺省 `""`） | `"题干与定义在诉求维度重合"` | 匹配理由 |

`ideology[]` 元素：

| 字段 | 类型 | 可空 | 示例值 | 说明 |
|---|---|---|---|---|
| `ideology_id` | string | 否 | `"ideology_common_prosperity"` | 思政点键 |
| `confidence` | number | 否 | `0.71` | 区间 0..1 |
| `evidence_span` | string | 否 | `"材料体现了共同富裕导向…"` | 摘录 |
| `rationale` | string | 否（缺省 `""`） | `"表述与要点一致"` | 理由 |

### 3.4 `fixtures/attempts.json` — `questions.attempts`

顶层为 `QuestionAttempt[]`，schema 来源 `packages/shared/src/index.ts:260-268`。

| 字段 | 类型 | 可空 | 示例值 | 说明 |
|---|---|---|---|---|
| `id` | string | 否 | `"att-001"` | 记录键 |
| `question_id` | string | 否 | `"q-001"` | 对应题目；原型题干位展示它 |
| `student_id` | string | 否 | `"20230001"` | 归属学号；列表页不展示 |
| `answer` | string | 否（缺省 `""`） | `"因为价格敏感度提升…"` | 学生答案 |
| `feedback_json` | object | 否（缺省 `{}`） | `{ "message": "抓住了价格因素" }` | 反馈对象；页面只摘 `message` 文本 |
| `score` | number | 否 | `1` | 区间 0..1；`>=0.99` 判答对 |
| `created_at` | string | 否 | `"2026-11-18T20:11:03.000Z"` | 作答时间；展示截前 10 位 |

数组至少放 2 条：1 条 `score` 为 `1`（答对）、1 条 `score` 为 `0.4`（答错）。

### 3.5 `fixtures/profile.json` — `profile.get`

顶层为 `ProfileData`，形状来源 `apps/desktop/src/renderer/src/model.ts:73-79`。

| 字段 | 类型 | 可空 | 示例值 | 说明 |
|---|---|---|---|---|
| `profile` | `StudentProfile` 对象 \| null | 是 | 见下 | 为 `null` 时页头与目标约束区走空态 |
| `competencies` | `Competency[]` | 否（缺省 `[]`） | 见下 | 证据回查字典 |
| `plan` | `LearningPlanItem[]` | 否（缺省 `[]`） | `[]` | 计划项；原型本版不渲染，字段保留 |
| `evidence` | `Evidence[]` | 否（缺省 `[]`） | 见下 | 证据账本 |
| `growth` | `GrowthItem[]` | 否（缺省 `[]`） | 见下 | 能力维度网格 |

`profile`（`StudentProfile`，schema 来源 `packages/shared/src/index.ts:333-344`）：

| 字段 | 类型 | 可空 | 示例值 |
|---|---|---|---|
| `id` | string | 否 | `"stu-20230001"` |
| `name` | string | 否 | `"张三"` |
| `cohort` | string | 是（缺省 `""`） | `"2023"` |
| `background` | object | 否（缺省 `{}`） | `{}` |
| `goals` | string[] | 否（缺省 `[]`） | ["能区分四种市场细分变量"] |
| `preferences` | object | 否（缺省 `{}`） | `{ "pace": "循序渐进" }` |
| `constraints` | string[] | 否（缺省 `[]`） | ["案例需要贴近日常消费"] |
| `self_assessment` | object | 否（缺省 `{}`） | `{ "consumer_market": "L2" }` |
| `created_at` | string | 是（缺省 `""`） | `"2026-09-01T10:00:00.000Z"` |
| `updated_at` | string | 是（缺省 `""`） | `"2026-11-18T20:11:03.000Z"` |

`competencies[]` 元素（schema 来源 `packages/shared/src/index.ts:324-331`）：`id` string 否 `"cpt-market"`；`name` string 否 `"消费者市场"`；`definition` string 否 `""`；`levels` array 否（4 项 `L1..L4` 描述）；`observable` string[] 否（缺省 `[]`）；`version` string 否（缺省 `"v0.1"`）。

`evidence[]` 元素（schema 来源 `packages/shared/src/index.ts:346-375`）：

| 字段 | 类型 | 可空 | 示例值 |
|---|---|---|---|
| `id` | string | 否 | `"ev-001"` |
| `student_id` | string | 否 | `"20230001"` |
| `competency_id` | string | 否 | `"cpt-market"` |
| `level` | enum `L1`/`L2`/`L3`/`L4` | 否 | `"L2"` |
| `strength` | enum `A`/`B`/`C`/`D` | 否 | `"B"` |
| `evidence_type` | enum（`explanation`/`decision`/`hypothesis`/`evidence_use`/`tradeoff`/`communication`/`reflection`/`artifact`） | 否 | `"explanation"` |
| `source_type` | enum（`chat`/`question`/`news`/`research`/`bp`/`reflection`/`teacher`） | 否 | `"question"` |
| `source_id` | string | 是（缺省 `""`） | `"q-001"` |
| `chapter_id` | string | 是（缺省 `""`） | `"ch04"` |
| `session_id` | string | 是（缺省 `""`） | `""` |
| `excerpt` | string | 否 | `"他把价格敏感度与细分变量对应起来。"` |
| `rationale` | string | 是（缺省 `""`） | `"作答中引用了教材定义"` |
| `confidence` | number | 否 | `0.78` |
| `method` | enum `rule`/`llm`/`human`/`hybrid` | 否 | `"llm"` |
| `review_status` | enum `draft`/`reviewed`/`rejected` | 否 | `"reviewed"` |
| `review_note` | string | 是（缺省 `""`） | `""` |
| `occurred_at` | string | 否 | `"2026-11-18T20:11:03.000Z"` |
| `created_at` | string | 是（缺省 `""`） | `"2026-11-18T20:11:03.000Z"` |
| `metadata` | object | 否（缺省 `{}`） | `{}` |

`growth[]` 元素（形状来源 `apps/desktop/src/renderer/src/model.ts:62-71`）：

| 字段 | 类型 | 可空 | 示例值 |
|---|---|---|---|
| `competency` | `Competency` 对象 | 否 | 同上述字典元素 |
| `level` | string | 否 | `"L2"` |
| `confidence` | number | 否 | `0.72` |
| `evidenceCount` | number | 否 | `3` |
| `status` | enum `进步`/`停滞`/`证据不足`/`待验证` | 否 | `"进步"` |
| `preLevel` | string | 是 | `"L1"` |
| `postLevel` | string | 是 | `"L2"` |
| `latestEvidence` | `Evidence` 对象 \| null | 是 | 同上述证据元素 |

### 3.6 布局契约

| 约束 | 规则 | 判据 / 写法 |
|---|---|---|
| 视口宽度 | 原型容器 `max-width: 375px`，居中；页面背景铺满，内容不超出 375 | 375px 设备宽度下 `document.documentElement.scrollWidth <= 375`；宽度规则只写在 `styles/app.css`，页面不内联固定像素宽度 |
| 点击区 | 按钮、可点行、标签链接的最小可点区域 `min-height: 44px`、`min-width: 44px`；行内文字不压到边界 | 对齐小程序触控建议 [R1]；不足 44px 的纯文字链接补 `padding` 撑出点击区 |
| 图片/媒体 | 原型本版无位图；预留 `img { max-width: 100%; height: auto; }` | 防止后续补图撑破卡片 |
| 文本换行 | 所有文本容器 `max-width: 100%`；长英文串 / 长 URL 用 `overflow-wrap: anywhere`；flex/grid 子项 `min-width: 0` | 换行规则参照响应式布局基线 [R2]；禁止对正文用 `white-space: nowrap` |
| 横向滚动 | 页面根节点不允许横向滚动；卡片内部不设横向 `overflow-x: auto` | 无横向滚动判据：逐页 375px 下 `scrollWidth === clientWidth`；纵向允许 `overflow-y: auto` |
| 动效 | 过渡动画时长不超过 200ms；`@media (prefers-reduced-motion: reduce)` 下关闭过渡与骨架动画 [R3] | 原型不做轮播、不做弹层动画 |
| 字体 | 系统字体栈；字号层级：页头 17px、卡片标题 14px、正文 13px、辅助说明 11px | 具体像素值以真机视觉稿为准；本版只定层级，不写死字重对比之外的装饰 |

## 4 错误与消息

### 4.1 错误态（`?state=error`）

错误态是**前端演示分支**，不对应任何真实服务端错误码；面板上不得出现指向后端的措辞（如「服务端异常」「接口返回」）。

| 元素 | 文案（逐字） | 行为 |
|---|---|---|
| 错误标题 | `暂时没拿到这条数据。` | 整页错误面板主标题 |
| 错误说明 | `原型演示错误态：当前没有连接真实服务端，以下内容是占位。` | 标题下方灰色说明 |
| 主按钮 | `重试` | 链接到当前页面去掉 `state` 参数的地址；原型内不发请求、不延时 |
| 次按钮 | `返回首页` | 链接到 `../index.html` |

错误面板不展示堆栈、不展示英文方法名、不展示 `error.code`；方法名只出现在 `data-mock-source` 属性里。

### 4.2 空态（`?state=empty` 或正常态数据为空）

| 页面 / 区块 | 文案（逐字） | 来源 |
|---|---|---|
| 首页身份区 | `暂无学生信息。` | 本轮新增原型文案 |
| 新闻列表 | `暂无新闻，Python 采集服务会在后台自动入库` | `apps/desktop/src/renderer/src/pages.tsx:283` 现状逐字沿用 |
| 新闻详情（未选中） | `选择一条新闻查看原文与匹配证据` | `apps/desktop/src/renderer/src/pages.tsx:299` 逐字沿用 |
| 详情知识点匹配区 | `尚未匹配` | `apps/desktop/src/renderer/src/pages.tsx:313` 逐字沿用 |
| 问答记录 | `还没有作答记录，去完成一道题后再来看。` | 本轮新增原型文案 |
| 我的 · 目标约束 | `还没有记录目标与约束。` | 本轮新增原型文案 |
| 我的 · 能力维度 | `还没有形成能力快照。` | `apps/desktop/src/renderer/src/App.tsx:363` 逐字沿用 |
| 我的 · 证据账本 | `还没有学生能力证据。` | `apps/desktop/src/renderer/src/App.tsx:386` 逐字沿用 |

空态布局：灰色居中文本，上下 24px 内边距（对齐 `apps/desktop/src/renderer/src/ui.tsx:176-180` 的 `Empty` 角色）；除文案外可带一个返回动作链接，不留干巴巴的单句占位。

### 4.3 加载态（`?state=loading`）

| 元素 | 规则 |
|---|---|
| 骨架块 | 按页面区块渲染灰色占位条（页头 1 条、列表行 3 条、卡片段 2 条）；不复制真实 fixture 文本 |
| 辅助文本 | 屏幕可读文本 `加载中（原型演示态）`；不写「正在连接服务器」「请求接口中」 |
| 延时 | 不设 `setTimeout` 模拟等待；骨架由渲染分支静态呈现 |

### 4.4 文案口径

所有学生可见文案使用中文；标识符、方法名、字段名、枚举值保持英文原样。原型不暴露内部枚举（`draft/reviewed` 等在证据标签上转成中文「待复核 / 已认可 / 已驳回」，参照 `App.tsx:392-394` 的现状转译）。空态与错误面板里的可点动作同样满足 §3.6 的 44px 点击区要求，触控尺寸对齐小程序设计指南 [R1]。

## 5 事件与序列

### 5.1 页面加载序列（文字版时序）

```text
t0  浏览器打开 pages/<page>.html（file:// 或静态服务器）
t1  scripts/app.js 启动：解析 location.search 中的 state 与 articleId
t2  按页面配置取 fixture 名 → 加载通道（§5.3）读取 JSON
t3  按 state 选渲染分支：
      loading → 骨架节点显隐，结束
      error   → 错误面板显隐，结束
      empty   → 以空集合渲染空态分支
      缺省 normal → 渲染正常态数据
t4  绑定导航：<a> 链接原样保留；「重试」按钮拼出去掉 state 的 URL
t5  控制台输出 fixture 来源标记：fixture-source: fetch | inline-fallback
```

序列硬规则：

1. `state` 取值仅认 `loading` / `error` / `empty`；其他值（含缺省、乱码、大小写不一致）一律按 `normal` 处理，不报错。
2. 一次渲染只出现一个分支容器；三态容器互斥显隐，不叠加。
3. 加载失败（`fetch` 抛错且内联兜底也缺失）走 error 分支，文案用 §4.1，不抛未捕获异常到控制台。
4. 不发任何 `http(s)` 请求：脚本里不出现 `fetch('http…')`、`XMLHttpRequest`、`WebSocket`、`EventSource`；`<img>`/`<link>` 不引外网资源。

### 5.2 导航契约

| 起点 | 终点 | 路径 | 参数 |
|---|---|---|---|
| `index.html` | 首页 | `pages/home.html` | — |
| `index.html` | 新闻列表 | `pages/news.html` | — |
| `index.html` | 新闻详情 | `pages/news-detail.html` | 演示链接可带 `articleId=news-001` |
| `index.html` | 问答 | `pages/ask.html` | — |
| `index.html` | 我的 | `pages/profile.html` | — |
| `news.html` | 新闻详情 | `news-detail.html?articleId=<id>` | `articleId` 取卡片 `id` |
| `news-detail.html` | 新闻列表 | `news.html` | — |
| 各内页 | 首页 | `../index.html` | — |
| 各内页 | 同页正常态 | 当前路径去掉 `state` 参数 | — |

- 链接全部用相对路径；`index.html` 在根，内页在 `pages/`，回根目录用 `../`。
- 新闻详情无底部 tab 切换，只保留「返回新闻列表」；其余内页底部导航含 首页 / 新闻 / 问答 / 我的 四项。
- 原型不做前端路由、不做历史栈管理；浏览器后退键按原生行为工作。
- 全部导航由相对路径 `<a>` 链接承担，不依赖脚本路由库；这种单文件可跳转的静态结构参照纯 HTML 原型的组织方式 [R5]。

### 5.3 数据加载通道（`file://` 兜底）

```text
loadFixture(name):
  1. 尝试 fetch('../fixtures/<name>.json')
     - 200 且 JSON 可解析 → 使用返回对象，标记 fixture-source: fetch
  2. fetch 抛错（file:// 同源限制 / 网络不可达）→ 读取页面内
     <script type="application/json" data-fixture="<name>"> 的内联副本
     → 标记 fixture-source: inline-fallback
  3. 内联副本缺失 → 进入 error 分支（§5.1 规则 3）
```

- 内联副本与 JSON 文件内容必须逐字一致；JSON 是唯一编辑源，改数据先改 JSON 再同步内联块。
- 脚本为经典 `script`（非 `type="module"`）：`file://` 下 ES Module 会被 CORS 拦截，原型不得依赖模块加载。
- 双通道设计是对 `file://` 限制的兜底，不是两套数据源；验收时两种通道各验一次（§7 MT-I-08）。

## 6 兼容与排除

### 6.1 字段与版本兼容

- 页面渲染只取 §3 列出的字段；fixture 里多出的未知字段忽略不报错。
- 必需字段缺失时按 §2 各组件的兜底规则降级，不渲染 `undefined` / `null` 字面量到界面。
- 后续真机阶段把 loader 换成 HTTP 调用时，响应信封需解包到 `result` 再喂给同一渲染函数；原型页面不感知信封（对齐冻结 §4.1 的 `ok/result/error` 形状，但本版不实现解包逻辑）。
- 本版不做 schema 版本号字段；若真机返回结构调整，先改冻结契约再同步 fixture 与页面标注。
- 方法名、参数名、结果字段名与冻结 §5 保持同一份命名，原型不自造别名；信封解包预留的形状对齐 RPC 风格的 `method/result` 分工 [R7]。

### 6.2 §6 排除能力（硬禁区）

冻结 §6 明确排除、小程序 mock 一律不碰的 5 个能力，原型 5 页与脚本中**不得出现入口、按钮、菜单项或可触发调用**：

| 排除方法 | 桌面端现状 | 原型处理 |
|---|---|---|
| `files.reveal` | `apps/desktop/src/main/index.ts:370-372`（`shell.showItemInFolder`） | 无「打开所在文件夹」入口 |
| `files.preview` | `apps/desktop/src/main/index.ts:373-374`（`previewFile`） | 无本地文件预览入口；新闻外链仅文本展示 |
| `files.openDialog` | `apps/desktop/src/main/index.ts:375-389`（`dialog.showOpenDialog`） | 无「上传 / 选择文件」对话框入口 |
| `settings.get` | `apps/desktop/src/main/index.ts:537`（`settings.readPublic`） | 无设置页、无 Key 读取展示 |
| `settings.set` | `apps/desktop/src/main/index.ts:538`（`settings.write`） | 无 Key 填写 / 保存 / 清除入口 |

`index.html` 排除说明区可用 `data-excluded="true"` 列出这 5 项「不在原型范围」；该说明是边界声明，不是功能入口。交付前检索关键词 `reveal`、`preview`、`openDialog`、`settings`、`apiKey`、`openFile`、`showItemInFolder`，除排除说明与标注属性外不得命中可点击元素。

### 6.3 浏览器与环境兼容

- 脚本语法限于 ES2017 及以下；不使用顶层 `await`、可选链之外的新语法特性（可选链按目标浏览器实测决定是否保留）。
- 不依赖 `localStorage` / `sessionStorage` / Cookie；刷新后状态只由 URL 参数决定。
- 不引入任何第三方 CSS / JS 框架或字体文件；样式表与脚本均为本地相对路径。

## 7 自测映射（契约测试对照）

> 本轮自测编号 `MT-I-xx`；E 轮契约测试面向真机服务端，不覆盖本静态原型。每条自测对应一个契约点，可在验收文档里复跑。

| 编号 | 契约点 | 操作步骤 | 期望结果 | 失败判据 |
|---|---|---|---|---|
| MT-I-01 | §5.2 导航 | 从 `index.html` 逐个进入 5 页，再逐页返回根目录 | 5 条入站路径与返回路径全部可达；无 404、无死链 | 任一链接落空路径或跳错文件 |
| MT-I-02 | §3.6 无横向滚动 | DevTools 375px 逐页检查 `scrollWidth` 与 `clientWidth` | 每页 `scrollWidth <= 375`，无横向滚动条 | 任一页 `scrollWidth > 375` |
| MT-I-03 | §5.1 规则 4 无网络请求 | 断网后打开全部 5 页；观察 Network 面板 | 无 `http(s)` 请求发出；正常态数据可渲染 | 出现外部请求，或断网后页面空白 |
| MT-I-04 | §4 三态切换 | 每页依次带 `?state=loading`、`error`、`empty` 刷新，再去掉参数 | 骨架 / 错误面板 / 空态 / 正常态四分支各自正确显隐；非法参数回正常态 | 两态叠加、文案错页、非法值进错误分支 |
| MT-I-05 | §3 schema 键位 | 逐份 fixture 对照 §3 表格核对字段名、类型、可空性 | 已列字段齐全；枚举值在允许集合内；无 `undefined` 字面量 | 缺字段、类型错、枚举越界 |
| MT-I-06 | §6.2 排除项 | 对 `pages/`、`scripts/`、`index.html` 做关键词检索 | 除排除说明外无可点击入口；无对应调用代码 | 出现设置 / 文件预览 / 打开文件夹按钮或处理器 |
| MT-I-07 | §3.6 长串换行 | 打开含超长标题、长英文词、长摘录的样例卡片 | 文本在卡片内换行，卡片边界不被顶破 | 出现溢出、横向滚动或文字裁切 |
| MT-I-08 | §5.3 加载通道 | 分别经静态服务器与 `file://` 打开页面，查看 `fixture-source` 标记 | 两种通道均可渲染；`file://` 下命中内联兜底时标记为 `inline-fallback` | `file://` 下正常态空白且无兜底 |
| MT-I-09 | §2.6 接缝标注 | `querySelectorAll('[data-mock-source]')` 逐页清点 | 5 页均有标注；属性值与 §1 方法对应表一致 | 缺标注、方法名拼写与冻结表不符 |
| MT-I-10 | §4.2 空态文案 | 空态下逐字比对 §4.2 表格 | 页面文案与表格逐字一致（含标点） | 文案被改写、漏字或换成英文 |

静态原型的组织与「数据文件独立于视图」的划分参照 mock 数据实践 [R4]；纯 HTML 原型的单文件可打开性参照静态原型结构 [R5]；fixture 字段成图方式参照测试数据对象图组织 [R6]；方法命名与冻结 RPC 口径保持一致 [R7]；原型阶段以结构表达为先、不追求高保真视觉 [R8]。

## 参考

- [R1] 微信小程序设计指南 — https://developers.weixin.qq.com/miniprogram/design/ — 支撑 §3.6 点击区 44px 与 375 宽度惯例 — 借鉴尺寸与触控建议；不引入小程序框架与构建链。
- [R2] MDN 响应式设计 — https://developer.mozilla.org/en-US/docs/Learn/CSS/CSS_layout/Responsive_Design — 支撑 §3.6 换行与 `min-width:0` 规则 — 采用 `max-width:100%` 与 `overflow-wrap`；不做多断点自适应。
- [R3] MDN `prefers-reduced-motion` — https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion — 支撑 §3.6 动效降级与 §4.3 骨架规则 — 采用减动效媒体查询；不做复杂动画。
- [R4] typicode/json-server — https://github.com/typicode/json-server — 支撑 §7 自测映射与 §3 数据/视图分离 — 借鉴 JSON 独立成文件；不引入需要起进程的 mock 服务。
- [R5] plannotator/effective-html — https://github.com/plannotator/effective-html — 支撑 §5.3 纯静态 HTML 可打开性与目录结构 — 借鉴本地相对路径组织；不照搬其代理脚本。
- [R6] FactoryBoy/factory_boy — https://github.com/FactoryBoy/factory_boy — 支撑 §3 schema 逐字段成图与可空性口径 — 借鉴对象图字段完整度；不引入 Python 生成库。
- [R7] JSON-RPC 2.0 规范 — https://www.jsonrpc.org/specification — 支撑 §1 方法命名与 §6.1 信封解包预留 — 借鉴 `method`/`result` 命名；不照搬 batch 与错误码体系。
- [R8] rough-stuff/wired-elements — https://github.com/rough-stuff/wired-elements — 支撑 §7「原型优先表达结构」的取向 — 借鉴线框原型定位；不引入 Web Components 运行时。
