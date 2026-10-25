# R08 新闻-知识点匹配

> 状态：MVP（本轮）
> 依赖：[R06 课程知识库](R06-knowledge.md)、[R07 新闻](R07-news.md)
> 代码：`packages/matcher/src/index.ts`、`packages/shared/src/index.ts`、`packages/db/src/index.ts`、`pipeline/review-tags.ts`、`pipeline/data-quality.ts`
> 上位原则：`../principles/single-agent.md`

## 1. 要什么（学生可见结果）

- 学生问「这条新闻体现了哪些消费者行为知识点」，营小商能给出候选知识点，并指出新闻里的哪一句支持它。
- 每条匹配都有原文证据句；找不到原文句子的匹配不出现。
- 匹配是候选，不是结论：营小商可以拿它组织讲解和追问，但不能把自动候选当既定事实，更不能拿未审核候选当出题依据。
- 学生看不到置信度、方法名、审核状态；只看到「这条新闻在讲什么、对应哪个概念、依据是哪句」。

## 2. 落位（提示词 / 工具 / skill / 数据）

| 落位 | 内容 |
|---|---|
| 工具 | `match_news`（`packages/matcher/src/index.ts:682`）；读侧通过 `read_news` 后的正文 + 知识点材料完成分析 |
| 数据 | `case_matches`、`news_tags`、`ideology_tags` 三张表；`content_tags` 提供教材侧召回 |
| 判据 | tag 角色权重（core 1 / example 0.7 / mention 0.3）、证据等级（auto / verified / gold）、审核状态（draft / reviewed / adjudicated / published / rejected） |
| 提示词 | 匹配结果只作为候选；引用必须来自新闻原文；未审核不作出题依据 |

`match_news` 当前由 matcher 插件注册，不在单一智能体九条工具清单内。对话里模型也可以直接用 `read_news` 的原文 + `read_kp` 的定义完成匹配；候选入库与质量门槛由后台 matcher 负责。若要让模型显式取候选，按 [R03](R03-tools.md)「加一个工具」的步骤加一条 `read` 声明（见 §8）。

## 3. 行为（一轮里怎么发生）

1. 取文章。正文 <300 字直接返回空候选，并标注「内容不足」。
2. 确定性召回（无模型、无网络）：
   - 教材 tag 倒排：`content_tags` 里 `knowledge_point` 且未 rejected 的行，按 `tag_role × confidence` 加权；
   - 字二元词法补充：知识点名称、别名、关键词、例子、定义与新闻正文做余弦；
   - 排序：`0.5 × 标签分 + 0.25 × 词法分 + 0.15 × 角色权重 + 0.1 × 来源质量 × 长度因子`；
   - 多样性与阈值：同小节最多 2 条，每多一条分数衰减 15%，低于 0.18 丢弃。
3. LLM 打标（有 key 时）：把正文前 6000 字和候选知识点交给模型，要求只通过 `emit_matches` 返回；证据必须是原文连续片段。
4. 证据校验：`kp_id` 必须在候选集合内、`tag_role` 合法、`confidence` 在 0–1、`evidence_span` 必须能在正文里逐字定位；任一不满足就丢弃。丢弃过就带提醒重试一次；仍不合法则用确定性结果。
5. 落库：先清掉本次作用域的 `draft` 行（带章节则只清该章），再写新候选；人工审核过的行（含 rejected）不被覆盖。
6. 展示：`MatchCandidate` 带中文知识点名、角色中文标签、证据句；审核状态与方法只留在库里。

## 4. 契约（工具签名、数据结构、字段、命令）

### 4.1 匹配记录（`packages/shared/src/index.ts:139-155`）

| 字段 | 说明 |
|---|---|
| `article_id` / `kp_id` | 新闻与知识点 |
| `score` / `confidence` | 0–1，当前同值 |
| `tag_role` | `core` / `example` / `mention` |
| `evidence_span` | 新闻原文连续片段，必须能定位 |
| `evidence_start` / `evidence_end` | 片段在正文中的偏移 |
| `rationale` | 规则分项或模型理由 |
| `method` | `rule` / `llm` / `hybrid` |
| `review_status` | `draft` / `reviewed` / `adjudicated` / `published` / `rejected` |
| `evidence_level` | `auto` / `verified` / `gold` |
| `version` / `reviewer_id` / `reviewed_at` | 审核溯源 |

### 4.2 候选视图（`MatchCandidate`）

`articleId`、`kpId`、`kpName`、`tagRole`、`roleLabel`（核心/例证/提及）、`confidence`、`evidenceSpan`、`evidenceStart`、`evidenceEnd`、`rationale`、`method`、`reviewStatus`、`evidenceLevel`、`version`。

### 4.3 工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `match_news` | `article_id`（必填）、`top_k?`（1–10，默认 3） | `{ matches, ideology, diagnostics }`；`diagnostics` 只给程序看 |

`diagnostics` 字段：`stages`、`degraded`、`vector`、`semantic`、`notes`、`candidates`、`llm`。当前 `degraded` 恒为 true、`semantic` 恒为 false，表示只做了词法级匹配。

### 4.4 审核命令

```bash
pnpm run pipeline:review -- list   --kind match --chapter ch04 --status draft
pnpm run pipeline:review -- accept --kind match --article <id> --kp <kp_id> \
  --reviewer <id> --level verified
pnpm run pipeline:review -- reject --kind match --article <id> --kp <kp_id> --reviewer <id>
```

- `--reviewer` 必填，CLI 不伪造审核人。
- `accept` 写 `review_status=reviewed`，`evidence_level` 取 `--level`（默认 `verified`）。
- `reject` 写 `rejected` + `auto`，此后重新召回也不会覆盖。

### 4.5 准确率口径

- `precision@5`：对每条查询取前 5 条，命中人工判为相关的结果数 / 5，再对查询取平均（`pipeline/data-quality.ts:164-250`）。
- 双人标注一致率：按块计算 tag 集合的成对 Jaccard 均值（`pipeline/data-quality.ts:252-315`）。
- 上线门槛：`precision@5 ≥ 0.8`、双人一致率 ≥ 0.75；不达标不上线。

## 5. 边界（不做什么、失败怎么表现）

- 不把匹配当结论；不把 `auto` 当 `verified`；不把 `draft` 当已审核。
- 无证据不匹配：定位不到原文片段的候选直接丢弃，不降级成「大概相关」。
- 不做语义向量检索：当前只有标签倒排 + 字二元词法，`semantic=false` 必须在内部可见。
- 模型不可用（无 key、超时、5xx）：回落到确定性召回，`notes` 记录原因；不把英文堆栈给学生。
- 正文 <300 字：返回空候选 + 说明，不猜。
- 章节作用域：带 `chapterId` 的刷新只清该章 draft，不影响其他章与人工行。
- 学生看不到 `method`、`confidence`、`reviewStatus`、`evidenceLevel`。

## 6. 验收（场景 → 期望）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 给一条新闻跑匹配 | 返回 ≤3 条候选；每条 `evidence_span` 都能在正文里逐字找到，`evidence_start/end` 与片段一致 |
| 2 | 模型返回改写过的证据 | 该校验失败被丢弃；带提醒重试一次；仍失败则用确定性候选，`notes` 含 `LLM returned no valid candidates` |
| 3 | 拿未审核候选去出题 | 出题被拒绝，提示「匹配仍是自动候选（未审核），不能作为出题依据」；改用知识点来源可继续 |
| 4 | 人工 accept 一条匹配 | 该行变为 `reviewed + verified`，出题可用；同章再跑匹配不会覆盖它 |
| 5 | 人工 reject 一条匹配 | 该行保留为 `rejected`；后续召回与展示都不再出现 |
| 6 | 无 API Key 跑匹配 | 仍返回确定性候选，`diagnostics.llm=false`、`notes` 含「LLM not configured」；学生只看到候选与证据句 |
| 7 | 准确率未达标 | 抽检 `precision@5 < 0.8` 时，该章匹配不得作为教学/出题依据上线（当前只计算不阻断，见 §7） |

## 7. 现状与差距（代码事实）

- 确定性召回：`packages/matcher/src/index.ts:188-330`；角色权重来自 `TAG_ROLE_WEIGHTS`（`packages/shared/src/index.ts:10-18`）；排序公式在 `:273`；阈值 0.18 与同小节 2 条上限在 `:297-306`。
- LLM 路径：`match()` 在 `:398-530`；`PROMPT_VERSION='match-v2'`、系统提示与重试提示在 `:40-42`；缓存按正文 hash + prompt version（`:427-465`）；重试一次在 `:467-477`；回落白名单 `LLM_FALLBACK` 在 `:43`。
- 证据校验：`validate()` 在 `:599-660`；`locateSpan(article.content, span)` 不通过即丢弃（`:617-621`）；`kp_id` 必须在候选集内（`:606`）。
- 落库保护：`packages/db/src/index.ts:2960-3085`；只删 `draft`，人工行（reviewed/adjudicated/published/rejected）保留（`:2966-2995`）；章节作用域删除在 `:2969-2981`。
- 审核：`reviewCaseMatch` 在 `:3183-3196`；CLI 在 `pipeline/review-tags.ts:57-86`，`--reviewer` 缺失直接退出（`:60-63`）。
- 出题门槛：`isTeachingMatch()` 在 `packages/questions/src/index.ts:196-201`，只接受 `reviewed/adjudicated/published` + `verified/gold`；新闻来源出题在 `:1055-1075` 抛错。
- 准确率：`precision@5` 与一致率只在传入 `--judgments` / `--annotations` 时计算（`pipeline/data-quality.ts:164-250`、`:252-315`、`:414-415`）；`checks`（`:322-329`）不含 precision 门槛，所以「不达标不上线」目前靠人工判断，不由命令阻断。
- 展示：`getMatchCandidates()` 在 `packages/db/src/index.ts:3135-3174`，把角色翻成「核心/例证/提及」并保留审核字段；`getMatches()` 过滤含 `mock evidence` 的历史行（`:3095-3100`）。
- 工具位置：`match_news` 在 `packages/matcher/src/index.ts:682-702`，由 matcher 插件注册，未进 `packages/agent/src/tools/`。
- 数据规模：`data/normalized/news_articles.json` 108 篇；匹配结果不预置在 normalized 文件里，由 `db:seed` 对正文 ≥300 字的文章跑确定性召回并写入（`pipeline/seed-db.ts:157-162`）。
- 待核对：当前库中 `case_matches` 的实际条数与 `draft` / `reviewed` 分布，以 `pipeline:quality` 输出为准。

## 8. MVP 范围与后续

**MVP 做到哪**

- 确定性召回 + 证据校验 + 角色/质量/多样性排序可用。
- 有 key 时走 LLM，证据必须是原文连续片段，失败重试一次后回落。
- 审核 CLI 可用：accept → `reviewed + verified`，reject → `rejected`。
- 未审核候选不得作为出题依据；学生只看到候选与证据句。
- 对话侧不新增工具：模型用 `read_news` + `read_kp` 完成匹配；`match_news` 只作为插件能力，需要显式候选时再按 R03 加一条声明。
- 人工抽检给出 `precision@5`；低于 0.8 的章节不进入教学与出题。

**后续**

- 把 precision@5 与一致率写进 `data-quality` 的 `checks`，不达标命令直接非零退出。
- 语义召回（embedding）与 rerank，`diagnostics.semantic` 才可为 true。
- 章节无关的全库回填与跨章去重；事件簇级匹配。
- 审核界面化（当前只有 CLI），审核理由与版本对比入库。

**不做**

- 不做「一条新闻自动生成教学结论」；匹配只给候选。
- 不把 `auto` 升格为 `verified`；`gold` 只能人工审批产生。
- 不为某个品牌、某条新闻写匹配特例。
- 不做多租户共享匹配库。
