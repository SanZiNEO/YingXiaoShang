# R06 课程知识库

> 状态：MVP（本轮）
> 依赖：[R03 工具层](R03-tools.md)、[R05 上下文按需获取](R05-context-on-demand.md)、[R17 本地数据](R17-local-data.md)
> 代码：`packages/knowledge/src/index.ts`、`packages/agent/src/tools/read-tools.ts`、`packages/db/src/index.ts`、`pipeline/ingest-resources.ts`、`pipeline/tag-content.ts`
> 上位原则：`../principles/single-agent.md`

## 1. 要什么（学生可见结果）

- 学生说「讲一下消费者」「这章有哪些概念」，营小商能给出定义、别名、教材例子、非例子，并能在需要时读到教材原文段落。
- 学生不用先选章节、不用翻目录、不用知道知识点编号；章节由对话推断，目录由系统给出但不占正文。
- 引用必须能回到教材原文；教材里确实没有原文的概念，营小商明说「只有定义」，不拿目录或常识补成原文。
- 学生看到的只有中文知识点名，不出现 `kp_*`、`cb_*`、tag、置信度。
- 课程扩展（加一章）只加数据，不改工具与提示词。

## 2. 落位（提示词 / 工具 / skill / 数据）

| 落位 | 内容 |
|---|---|
| 数据 | `data/normalized/` 的 `chapters.json`、`sections.json`、`knowledge_points.json`、`content_blocks.jsonl`、`knowledge_points.curated.json`；SQLite 六张表 |
| 工具 | `list_chapter_kps`、`read_kp`、`read_material`、`read_textbook`（`packages/agent/src/tools/read-tools.ts`） |
| 提示词 | `packages/agent/agents/mentor.md`「取材料」：目录不是原文、先取正文再讲、没取到就说资料不足 |
| 目录 | `packages/agent/src/team.ts` 的 `environment()`：名称 + 小节 + 一句话，不是材料 |

`packages/knowledge/src/index.ts` 另外注册了 `search_knowledge`、`get_knowledge_point`，属旧插件路径，不在单一智能体的九条工具清单内；收敛见 [R03](R03-tools.md)。

## 3. 行为（一轮里怎么发生）

1. 拼 system：身份 + 当前环境（章节、学情、本章知识点目录）。目录只含名称、小节、定义前 60 字。
2. 模型判断这句话要不要读正文：讲概念、讲案例、分析新闻之前必须读。
3. 模型调 `read_kp` / `read_material` / `read_textbook`。工具内部把中文名翻成内部 id，查 `content_tags` 找对应 `content_blocks`，把原文逐字返回，并写 `turn.reads` 与 `citations`。
4. 模型用工具返回的原文作答；目录不进 `citations`。
5. 同一材料本轮第二次读，工具返回「已经读过，内容完全相同」，不重复占上下文。

## 4. 契约（工具签名、数据结构、字段、命令）

### 4.1 知识点字段（`packages/shared/src/index.ts:36-53`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | `kp_*`，内部 id |
| `chapter_id` / `section_id` | string | 所属章、小节 |
| `name` / `name_en` | string | 中文名、英文名 |
| `definition` | string | 1–3 句，能判断「是不是」 |
| `keywords` / `aliases` | string[] | 检索词、同义说法 |
| `examples` / `non_examples` | string[] | 正例、反例 |
| `difficulty` | 1–4 | 默认 2 |
| `competencies` / `decisions` | string[] | 能力维度、决策类型 |
| `source` / `status` | string | 来源、draft/reviewed/published |
| `parent_id` | string? | 子知识点挂父级 |

### 4.2 内容块与受控 tag

- 内容块：`id`、`chapter_id`、`section_id`、`block_type`（paragraph/table/figure/exercise/case_fragment）、`text`、`page?`、`source`、`rights`。
- tag 类型固定四个命名空间：`knowledge_point`、`competency`、`decision`、`context`（`packages/shared/src/index.ts:20`）。
- tag 角色固定三种：`core` / `example` / `mention`，权重 1 / 0.7 / 0.3（`packages/shared/src/index.ts:9-18`）。
- 每条 tag 必须带 `confidence`、`method`（rule/llm/human/hybrid）、`evidence_span`（块内逐字片段）、`review_status`、`evidence_level`（auto/verified/gold）、`version`、`reviewer_id`、`reviewed_at`。

### 4.3 读工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `list_chapter_kps` | `chapterId?` | 本章全部知识点：中文名 + 小节 + 定义 |
| `read_kp` | `name`（中文名或 id，必填） | 定义、别名、关键词、例子、非例子、章节、小节、难度 |
| `read_material` | `kps` 1–4 个、`query?`、`limit?`（每点 1–4 段，默认 2） | 每个点的定义 + 教材原文段落，整段上限 12000 字符 |
| `read_textbook` | `kps?` / `kp?`、`query?`、`limit?`（每点 1–6 段，默认 3） | 逐字原文 + 出处；没有原文的点会单独说明 |

除 `list_chapter_kps` 可显式指定 `chapterId` 外，其余读工具只读当前章节；返回内容进对话历史，不写回 system。

### 4.4 生成与质量命令

```bash
pnpm run pipeline:resources    # 教材资源 -> data/normalized
pnpm run db:seed               # data/normalized -> 本地 SQLite
pnpm run pipeline:content-tags # 规则/LLM 给教材块打 tag，draft + auto
pnpm run pipeline:quality      # 覆盖率、span 合法性、重复名等体检
pnpm run pipeline:review       # list / accept / reject / import / versions
```

`knowledge_points.curated.json` 是覆盖层：同 id 替换管线结果，新 id 追加（`pipeline/ingest-resources.ts:118-122`、`pipeline/seed-db.ts:60-65`）。用于补短定义、拆子知识点、修占位符。

## 5. 边界（不做什么、失败怎么表现）

- 不预取正文，不在 system 放定义之外的教材内容；目录不能当引用。
- 不做向量检索、不做跨章全文搜索、不引入 MCP resources。
- 章节没有知识点：`list_chapter_kps` 返回「章节 chXX 没有知识点记录」。
- 知识点名找不到：`read_kp` 返回「当前章节里没有找到知识点」，并建议先调 `list_chapter_kps`。
- 教材没有该点的原文：明确说「只有定义，不要再检索」，不伪造原文。
- 定义本身残缺（见 §7 ch07）：只能按已有内容讲，讲不到机制层时说明材料不足，不自行补写教材。
- 教材与新闻的版权按校内使用处理；原文只在本地库，导出与引用只给短引和出处。

## 6. 验收（场景 → 期望）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 「用第 4 章讲一下消费者」 | 先调 `read_kp` 或 `read_material`；回复中的定义、例子来自工具返回；`trace.reads.kps` 只含真正读过的点；目录内容没有出现在引用里 |
| 2 | 「这章有哪些概念」 | `list_chapter_kps` 返回本章全部知识点（ch04 合并 curated 后 52 条，其中 2 条来自 curated）；只给名称、小节、定义，不含原文 |
| 3 | 「第 7 章目标市场选择战略有哪几种战略」 | 能读到 curated 拆出的子知识点（无差异/差异化/集中化）；父点定义保持 1–3 句；引用 locator 指向具体 `cb_*` |
| 4 | 「给我第 7 章市场定位的依据的原文」 | 教材没有该段时明确回答「只有定义，没有原文段落」，不编造段落，不把目录当原文 |
| 5 | 连续两轮追问同一概念 | 第二轮工具返回「本轮已读过，内容完全相同」，不重复塞入同一段原文 |
| 6 | 新增一章数据后重建 | 只增加 `data/normalized/` 数据并重跑 `db:seed`，目录出现新章知识点；工具与提示词不变（当前需改代码，见 §7） |

## 7. 现状与差距（代码事实）

- 数据规模：`data/normalized/chapters.json` 13 章；`knowledge_points.json` 253 条；`content_blocks.jsonl` 744 块；`knowledge_points.curated.json` 32 条（16 条子知识点，合并后 271 条，ch04 52 条、ch07 31 条）。
- 章节表与目录：`packages/db/src/index.ts:101-110`（knowledge_points）、`:112-116`（content_blocks）、`:118-128`（content_tags）；`listKpsByChapter` 在 `:1807-1811`，按 `section_id, name` 排序。
- 目录生成：`packages/agent/src/team.ts:84-109`，定义截 60 字（`:93`），目录标题写明「只用于选材料，不是原文」（`:105-106`）。
- 读工具：`packages/agent/src/tools/read-tools.ts:20`、`:39`、`:74`、`:187`；`read_material` 整体截断 12000 字符（同文件 `:288`）。
- 打标：`pipeline/tag-content.ts:56-63` 默认规则打标，`--llm` 才用模型；结果一律 `review_status=draft`、`evidence_level=auto`。规则只生成 knowledge_point/competency/decision/context 四类，且每块最多 3 条（`pipeline/lib/tags.ts:164-176` 规则路径、`:389` 模型路径）。
- 体检门槛：`pipeline/data-quality.ts:322-329` 检查重复名、span 合法、自动覆盖率 ≥95%、每块 1–3 tag、无 mock、无 auto 冒充 gold、引用可追溯；`precision_at_5` 与双人一致率只在传入 `--judgments` / `--annotations` 时计算（`:414-415`），不参与阻断。
- ch07 体检结论：13 条官方知识点中 3 条只入库第一小点、2 条源文档正文缺失、1 条把文档标题当知识点；15 条 `competencies` 全空、`difficulty` 全为默认 2。根因是 `pipeline/lib/knowledge.ts:227-235` 的 `pickDefinition()` 用 `.find()` 只取第一段。curated 层共 32 条（ch04 2 条、ch07 30 条，其中 16 条子知识点）：改短 4 条父点定义、补写 3 条单点、给 14 条补能力标签。
- 章节可配置性：`packages/shared/src/constants.ts:1-15` 写死 1–13 章标题；`pipeline/ingest-resources.ts:81` 写死 `length: 13`。新增第 14 章目前要改代码，不满足「只加数据」。
- 旧插件工具：`packages/knowledge/src/index.ts:70-118` 仍注册 `search_knowledge`、`get_knowledge_point`，未接入单一智能体清单；`search_knowledge` 按 `query` 直接做 LIKE 检索，与读工具的领域化接口不同。
- 待核对：本地库中 ch04 的实际知识点数、tag 覆盖率以 `pnpm run pipeline:quality` 输出为准；本文引用的是 `data/normalized/` 文件计数。

## 8. MVP 范围与后续

**MVP 做到哪**

- 13 章数据入库，ch04 为验收章、ch07 为第二批；四张读工具可用；目录只给名称与一句话；curated 覆盖层生效；体检脚本能跑出覆盖率与 span 合法性。
- ch07 的 5 条不可用知识点按 curated 方案补齐后，允许作为讲解与出题依据；未补齐的章节如实说明材料不足。

**后续**

- 章节改为数据驱动：`chapters.json` 是唯一章表，`CHAPTER_TITLES` 与 `length: 13` 退场。
- `definition` 与完整正文拆字段（`body` / `details`），或按 `parent_id` 继续拆子点，避免长定义破坏卡片展示。
- tag 人工审核闭环：`pipeline:review accept` 产出 verified/gold，并把覆盖率、一致率、precision@5 纳入阻断门槛。
- 定义完整性检查（占位符、长度异常、competencies 为空）进 `data-quality`。

**不做**

- 不做向量库、全文搜索引擎、跨课程知识图谱。
- 不做自动预取、不做「本轮已读」式假已读。
- 不做教师端标注界面；标注仍走 CLI 与 JSON 导入。
- 不把教材正文放进 system，也不把目录当引用来源。
