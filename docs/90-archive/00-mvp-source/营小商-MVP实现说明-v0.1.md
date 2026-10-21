# 营小商 MVP 实现说明 v0.1

> **阅读入口**：`营小商-MVP总文档-v1.0.md`；本文保留在 `00-mvp` 同一目录，作为实现记录与验证细节的追溯来源。

> 日期：2026-10-18  
> 对应设计：`docs/00-mvp/营小商-MVP调研与设计报告-v0.1.md`  
> 本文只记录“已经实现什么、怎么验证、和设计有什么差异”，不是新方案。

## 1. 运行时主线

聊天入口已从 `SkillService.route()` 的关键词正则切换为：

```text
用户消息
  → 写入 chat_messages（seq / turn_id / kind / payload_json）
  → StateProjector 计算 StateFeatures + LearningStateSnapshot
  → 主 Agent 生成 TurnPlan（phase / scope / intent / decision / asks / steps）
  → 职能子 Agent 返回 SubagentResult
  → 主 Agent 写 TurnRecord 到 turns
  → 回复 + 产物卡片 + 一个检查问题
  → 记录 Agent 异步消费 TurnRecord
  → 幂等写 memory_episodes / evidence / learning_states / summary_ledger
```

实现位置：

| 模块 | 文件 |
|---|---|
| 状态投影 | `packages/agent/src/state.ts` |
| 主 Agent / TurnPlan / TurnRecord | `packages/agent/src/index.ts` |
| 职能子 Agent | `packages/agent/src/subagents.ts` |
| 记录 Agent / summary ledger | `packages/agent/src/recorder.ts` |
| 文本、章节推断、答题判分 | `packages/agent/src/text.ts` |
| 桌面端 IPC | `apps/desktop/src/main/index.ts` |
| 中栏 / 左栏 | `apps/desktop/src/renderer/src/App.tsx` |
| 右栏多标签工作区 | `apps/desktop/src/renderer/src/workspace.tsx` |
| 产物 renderer | `apps/desktop/src/renderer/src/renderers.tsx` |
| Markdown 降级 | `apps/desktop/src/renderer/src/markdown.tsx` |
| SVG 图标 / 空态插画 | `apps/desktop/src/renderer/src/icons.tsx` |

## 2. 数据层

数据库仍使用本地 SQLite，`SCHEMA_VERSION = 4`。

`MIGRATION_4` 做了：

- `chat_messages` 增加 `seq / turn_id / kind / payload_json`，按 `created_at, id` 回填旧消息 seq，并建立 `(session_id, seq)` 唯一索引；
- 新增 `turns`、`learning_states`、`summary_ledger`；
- `artifacts` 增加 `content_json / schema_version / version / status / source_refs_json`。

`artifacts.source_refs_json` 只放 KP / 新闻 / 教材来源；`evidence_ids_json` 只放学生能力证据。记录 Agent 会把本轮 feedback 产生的证据追加到对应题目集或引用产物。

`summary_ledger` 以 `source_type='session'`、`source_seq`、`summarized_seq` 维护水位；记录 Agent 每次只读 `summarized_seq + 1 .. source_seq`，摘要 id 使用 `ep_<sessionId>_<sourceSeq>`，重复 flush 不会重复写同一区间。失败时保留 `attempts / last_error`，连续 3 次失败后停止自动重试，可在“过程 / 记录”里手动重试。

## 3. 主 Agent 行为

- 首次进入“我想学消费者行为”：判定 `pre`，最多问 2 个诊断问题；回答后生成最小计划（前测完成、学习中 active、后测 pending），不出现章节下拉框。
- “直播间为什么让人冲动消费”：推断 `ch04`，调用知识新闻 Agent，返回 KP/新闻引用和 1 个检查问题；右栏打开“依据 / 引用”。
- “给我出 3 道题”：调用出题 Agent，产物以题目卡渲染，答案默认折叠；学生作答写 `question_attempts`，反馈 Agent 产 `evidenceCandidates`，记录 Agent 写入证据。
- “帮我设计国潮联名调研”：只问 1 个会改变设计的问题，澄清后调用调研 Agent，产物用研究设计 renderer。
- “校园二手书 BP”：调用 BP Agent，目录用 accordion 渲染，每节显示目的与所需证据。
- “我学得怎么样”：按 active 计划章节生成成长卡，证据不足的维度明确标注。
- 执行中继续发消息进入队列；当前轮结束后按顺序处理。

## 4. 右栏

右栏已改为多标签文档工作区：

- 顶部是已打开文档标签，`+` 菜单打开任务概览 / 产物 / 依据 / 过程 / 文件 / 本地文件；
- 产物标签使用原生 renderer：QuestionSet、ResearchDesign、BpOutline、NewsAnalysis、GrowthCard；
- 未知 schema 或旧产物降级到 Markdown renderer；
- Markdown、DOCX（mammoth 转 HTML）、图片、PDF（data URL）只读预览；
- 支持 MD/DOCX 导出、打开所在文件夹、引用选中文本继续追问、全屏。

## 4.1 对话主线与信息减法

第二轮 UI 调整把“卡片墙”收回到对话：

- 助手消息不再套大边框卡片，改为头像 + 对话正文 + 轻量元信息；
- 执行过程收成一行“本次使用：出题 ›”，展开才看步骤；
- 引用从一排 chip 收成“依据 N 条”，点击打开右栏“依据 / 引用”；
- 产物从大卡片收成一行附件条，点击才在右栏打开；
- ask 收成对话内快速选项，不再单独放输入框；
- 反馈默认只显示结论和提示，解析折叠；
- 右栏在没有打开文档时隐藏，让对话独占宽度；打开文档后才出现；
- 新增 `icons.tsx`：品牌标记、发送、加号、关闭、文档、题目、调研、BP、新闻、成长、证据、过程、文件夹、导出、全屏、引用、空态插画等 SVG 资源，统一 `currentColor` / `var(--accent)`，替换了一批文字按钮。

## 4.2 新闻获取自动化

新闻获取分两层：

- `packages/news` 的 `NewsService` 本身支持 `refresh()` / `ensureFresh()`：串行刷新、2 并发抓详情、按 URL 去重、写 `ingest_runs`、网络失败保留旧数据。
- dsh web profile 的 `cordis.patch.yml` 已经挂载 news 插件，默认启动检查 + 每 30 分钟刷新。

本轮补上了桌面端：

- Electron main 启动后调用 `startNewsAutomation()`：立即 `ensureFresh()`，之后按 `LEARNING_AGENT_NEWS_REFRESH_MINUTES`（默认 30）定时检查；
- 新增 `news.status` / `news.refresh` IPC；
- 任务概览里显示新闻条数、最近抓取时间，并提供手动“刷新”兜底；
- `ensureFresh()` 发现最新抓取时间在 30 分钟内会跳过，避免重复抓取；
- 抓取失败只记录 `ingest_runs` 错误并保留旧数据，不阻塞聊天。

边界：这是“应用运行时自动更新”。应用关闭后不会抓取；要做完全无人值守，需要 OS 级计划任务或常驻服务。新闻入库不等于自动做 KP 匹配；匹配仍在知识新闻 Agent / `news.match` 按需触发，避免每次抓取都产生模型成本。

### 4.3 搜索工具与学生报新闻

`packages/news` 新增两类工具能力：

- **专项爬取**：继续走 `NEWS_SOURCES` 的站内适配器（socialbeta / linkshop / brandstar / wscn），`refresh(sourceIds)` 抓取并入库；单个任意 URL 走 `crawlAndIngest(url)`，优先 DeepSeek Fetch，失败回退本地 `fetchText + cheerio`。
- **网页搜索**：`webSearch(query, count)` 调用 DeepSeek `POST /v1/tools/search`，`searchAndIngest(query, count)` 把可用结果抓正文并入库。`apiKey` 由桌面设置懒读取。

dsh profile 里注册了三个工具：`web_search`、`crawl_url`、`refresh_news`。桌面端由主 Agent 直接调度同一个 `NewsService`。

新增 `news_lab` 子 Agent，处理“学生报一条新闻”的逆向流程：

```text
学生给 URL / 搜索词 / 说“这条新闻”
→ crawlAndIngest / searchAndIngest
→ 按当前章节选 KP
→ 生成 NewsAnalysis 产物
→ 需要时基于新闻情境生成 QuestionSet
```

主 Agent 识别：

- `https://...`、`报一条新闻`、`这条新闻`、`用第4章分析这条新闻` → `news_lab`
- `搜一下/查一下/找新闻/最新新闻` → `news_lab` 的 web search 分支
- “并出 2 道题”会在分析后继续出题；不会把新闻请求误判成普通练习

### 4.4 难度视觉与上下文可见性

题目卡不再写“难度 2”文字：

- 难度 1/2/3 对应薄荷绿 / 靛蓝 / 暖橙三套色；
- 卡片顶部边框用主色、底部边框用浅色，背景从浅色渐变到白色；
- 题目头部只保留题型和一条三格难度条，鼠标悬停显示“基础/应用/挑战”。

聊天头部新增“上下文”浮层，显示本轮自动传入的章节、阶段、最近轮次、证据数、最近产物、本轮使用工具和可用工具。开放聊天会带上最近 8 条消息、状态快照和工具说明调用模型；模型失败时回退到本地短回复。

回复顺序固定为“先对话、后附件”：

- 每轮都必须有 assistant 文本；没有结果时也会给下一步，不会只丢一张卡片；
- 调研、BP、新闻分析等复杂产物由主 Agent 把子 Agent 结果、引用和产物摘要交给模型汇总成 2–4 句对话；失败时用本地摘要回退；
- 题目集/研究设计/BP/成长卡/新闻分析都是对话里的附件条，点击才在右栏打开；
- 只有题目集会在生成后自动打开右栏，因为学生需要直接作答；知识解释只自动打开“依据 / 引用”；
- 右侧工作区没有打开文档时隐藏，聊天独占宽度。

## 5. 验证记录

以下命令已实际运行：

```bash
pnpm typecheck
pnpm --dir apps/desktop exec tsc --noEmit
pnpm build:desktop
pnpm test:agent
pnpm test:news
pnpm test:ui-flow
pnpm test:ui-queue
pnpm test:skills
pnpm test:offline
pnpm test:profile
```

验证覆盖：

- `test:agent`：首次进入 → 诊断 → 最小计划 → ch04 解释 → 3 题 → 作答 → 调研澄清 → 研究设计 → BP → 成长卡 → 10 轮后账本；另测“用第4章分析这条新闻并出题”和“带 URL 的新闻分析+出题”；重复 flush 不重复写 episode。
- `test:ui-flow`：真实 Electron UI 走完上述验收场景；检查无章节 `select`、上下文浮层、新闻入库/分析/出题、产物无 `##`/`**`、DOCX/Markdown/图片/PDF 预览 kind。
- `test:ui-queue`：第一轮执行中发送第二条消息，出现“排队 1”，当前轮结束后依次处理。
- `test:news`：真实网络刷新 socialbeta（`fetched=30 / inserted=27 / skipped=3 / errors=0`）；DeepSeek Search 返回 3 条并入库 3 条；`crawlAndIngest` 抓取一条英文直播盲盒论文并入库。网络依赖测试，不作为默认离线套件。

## 6. 已知差异与未做项

- `review / assessment` 已进入类型与状态判定，但 MVP UI 只把“我学得怎么样”走成长卡；独立复习流程未做。
- 对话内搜索未实现（P1 非演示关键项）。
- 产物编辑、版本历史、`content_hash` stale 重算未做；当前只保留 `version/status` 字段。
- 模型调用有 9–12 秒上限，超时自动使用离线研究/BP/出题 fallback，保证无 Key 或网络慢时演示可跑。
- 右栏 PDF 预览依赖 Chromium 内置 PDF viewer；只读，不做批注。
- 搜索/抓取工具已经可被主 Agent 和 dsh 工具层调用，但桌面端仍是“主 Agent 规则调度 + 工具执行”，没有做完整的 LLM function-calling 循环；开放聊天会把工具清单放进 system prompt，但不会让模型直接发起工具调用。下一步可以加 `chatWithTools` 循环。
