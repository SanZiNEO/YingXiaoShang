# 07 · 领域服务与确定性分级

> 归属：`packages/` 领域层（agent / matcher / questions / research / bp / profile / artifacts / news 等） ｜ 状态：已完成 ｜ 核对日期：2026-11-18
> 覆盖：`packages/{agent,matcher,questions,research,bp,profile,artifacts,news,db,skills,ui,api,fs-app,path-gate,knowledge,export,llm-json,shared,bundle}` 的入口、输入输出、依赖面与确定性分级；行号截至 2026-11-18 工作区。
> 不覆盖：渲染层页面与交互（见 `04-renderer-ui-flows.md`）、IPC 方法逐条契约（见 `03-ipc-and-preload-contract.md`）、Python 采集服务内部（见 `06-news-sidecar-and-network.md`）、库结构与隔离造数（见 `08-data-fixtures-and-isolation.md`）。

## 1. 结论摘要（TL;DR）

1. 领域层分三档确定性：**纯函数 / DB 读写为「高」**，**模板与文档渲染为「中」**，**LLM 生成与网络调用为「低」**；分级落到具体函数，不按包一刀切 `[源码]`。
2. `db` 包是唯一持久化面：其余服务通过 `ctx.learningDb` 读写 SQLite，自身不直接打开库文件；服务内的「落库」是确定性写入，读回形状由 `shared` 的 zod schema 约束 `[源码]`。
3. `matcher` 有双路径：`generateDeterministicMatches` 是倒排 + bigram 词法召回，无模型无网络（高）；`match()` 在配置了 LLM 且未禁用时叠加一次模型标注，失败按正则回退到词法结果（低，可降级）`[源码]`。
4. `questions` / `research` / `bp` / `profile` 的生成方法都经 `llm-json.callStructuredTool` 走结构化工具调用；其中只有 `questions.generate` 在 LLM 不可用时内置了离线题库兜底，`research` / `bp` 重试 3 次后直接抛错 `[源码]`。
5. `agent` 包内部要拆开看：`StateProjector`、`FeedbackAgent`（`subagents.ts`）、历史压缩、判分、选题都是规则/DB 投影（高）；主循环 `tool-loop.ts` 与 `case-coach.ts` 直接消费 `llm.stream`（低）`[源码]`。
6. `artifacts` / `export` 是文件落盘与排版层：markdown/docx/html 由固定 block 结构生成（中），路径经过 `isPathUnder`  containment 校验（高）；产物正文来自上游，文案本身不在这里生成 `[源码]`。
7. `news` 的 TS 包只是 Python 采集服务的 HTTP 客户端：`list/get` 读本地库（高），`refresh/searchAndIngest/crawlAndIngest` 走网络子进程（低，受端口、服务存活、3 秒查询预算影响）`[源码]`。
8. 低确定性场景的断言口径统一为：**只断言结构与约束**（字段存在、引用可解析、长度区间、状态流转、错题被拒），不断言模型文案；具体约束见第 4 节各 SVC 行 `[源码，口径依据 spec 第 7 节]`。

## 2. 结构与流程

### 2.1 装配顺序（主进程侧）

主进程 `initServices()` 先 `ctx.provide('llm', llm)` 并 `ctx.plugin(LearningDb, { appHome })`，再依次 `new` 出 `Matcher / QuestionSmith / ResearchService / BpService / ProfileService / ArtifactService / NewsService / AgentService`（`apps/desktop/src/main/index.ts:82-100`）。cordis 组合层另有一份 profile 插件挂载表，见 `packages/bundle/cordis.patch.yml`。

```
IPC invoke/chat
   │
   ▼
AgentService (packages/agent) ──► StateProjector / FeedbackAgent / RecorderAgent（规则 + DB）
   │                                │
   │  工具调用链 tool-loop.ts        ▼
   ├─► knowledge / news / matcher / questions / research / bp / profile / artifacts（领域服务）
   │        │            │           │            │          │        │          │
   │        ▼            ▼           ▼            ▼          ▼        ▼          ▼
   └──────────────────► ctx.learningDb (packages/db, SQLite) ◄──────────────────┘
                          ▲
            NewsService ──┘（读库）；写库由 Python 子进程在同一文件上完成（见 06）
```

### 2.2 依赖面与确定性总表

> 依赖列：`DB` = SQLite 读写；`LLM` = 调用模型；`FS` = 文件系统；`NET` = 网络/子进程；`-` = 无外部依赖。确定性：高 / 中 / 低，依据写在等级后括号内。

#### A. 领域服务包

| 包 | 职责一句话 | 对外入口函数 | 输入 | 输出（字段/形状） | 依赖 | 确定性等级（依据） | 可测点 |
|---|---|---|---|---|---|---|---|
| `db` | SQLite 连接、迁移、领域表 CRUD 与缓存状态 | `LearningDb`（构造 `ctx.plugin(LearningDb,{appHome})`）；`getKp/listNews/insertArtifact/upsertMatches/...` 见源码方法表 | 各领域实体对象 / id / 查询 opts | 实体数组或单实体（`shared` schema 形状）；`count*()` 返 `number`；`getState<T>()` 返 `T` | DB | **高**：纯 SQL 读写，同库同数据下结果确定；迁移在事务内按 `user_version` 顺序执行 `[源码]` | SVC-01、SVC-02 |
| `matcher` | 新闻 ↔ 知识点 / 课程思政点匹配，含词法召回与模型标注 | `Matcher.candidates(articleId,opts)`、`Matcher.backfill(limit)`、`Matcher.match(input,signal)`；纯函数 `generateDeterministicMatches(db,article,topK,chapterId?)` | `articleId:string`、`topK?:1..10`、`useLlm?:boolean`、`chapterId?:string`、`signal?` | `{ matches: CaseMatch[], ideology: IdeologyMatch[], diagnostics: {stages,degraded,vector,semantic,notes,candidates,llm} }`；`backfill` 返 `{processed,tagged,errors}` | DB、LLM（可选） | **高（`generateDeterministicMatches` / `candidates` 落库路径）**：倒排索引 + bigram 词法 + 排序，无模型无网络 `[源码]`；**低（`match()` 的 LLM 增强分支）**：模型标注可能被接受或被校验拒绝，且受缓存内容哈希影响 `[源码]` | SVC-03、SVC-04、SVC-05 |
| `questions` | 题库生成、校验、归一化与导出 | `QuestionSmith.generate(input,signal?)`、`validate(question,context)`、`exportQuestions(ids,format)`；纯函数 `validateQuestion/normalizeStem/normalizeChoiceAnswer/clampQuestionCount/questionId` | `GenerateInput{sourceType:'news'|'kp'|'text'|'resource',sourceId?,text?,kpIds?,types?,difficulty?:1|2|3,count?}`；导出 `ids:string[]`、`format:'json'|'csv'|'docx'` | `Question[]`（含 `id,type,stem,options,answer,explanation,difficulty,status,kp_ids`）；导出返 `{path:string}` | DB、LLM、FS | **高（校验/归一化/数量钳制/id 生成纯函数）** `[源码]`；**低（`generate` 模型出题）**：模型题目须过 `validateQuestion` 与 kp 绑定校验，被拒题目丢弃 `[源码]`；**中（`exportQuestions` 文件排版）**：JSON/CSV/DOCX 落盘，CSV 带 BOM `[源码]` | SVC-06、SVC-07、SVC-08 |
| `research` | 调研项目七步设计（简报→方法→抽样→问卷→访谈提纲→分析→评审） | `ResearchService.parseBrief/chooseMethod/designSampling/buildQuestionnaire/buildInterviewGuide/designAnalysis/reviewDesign`；`getProject/listArtifacts` | 各步 `*Input`（见源码接口 `ParseBriefInput` 等），均可选 `projectId`、`signal?` | 对应结构化对象 `ResearchBrief/MethodChoice/SamplingPlan/Questionnaire/InterviewGuide/AnalysisPlan/DesignReview`；有 `projectId` 时经 `upsertResearchArtifact` 落 `research_artifacts` | DB、LLM | **高（`getProject/listArtifacts/assertProject/persist` 读写）** `[源码]`；**低（七步生成）**：`requestStructured` 最多重试 3 次， zod 校验 + 自定义 `problems` 双过滤，不过则抛错；**无离线兜底** `[源码]` | SVC-09、SVC-10 |
| `bp` | 商业计划书六步生成与导出 | `BpService.outline/marketSizing/competitorAnalysis/businessModelCanvas/gtmPlan/financialProjection/review`；`getProject/listSections/exportPlan` | `*Input`（想法、受众、阶段、市场、目标、数据类型等），可选 `projectId`、`signal?`；导出 `{projectId,format:'docx'|'md'}` | 结构化 BP 对象；章节经 `upsertBpSection` 落 `bp_sections`；`exportPlan` 返 `{path:string}` | DB、LLM、FS | **高（项目/章节读写）** `[源码]`；**低（六步生成，重试与校验同 research）** `[源码]`；**中（`exportPlan` 文档排版落盘到 `exports/`）** `[源码]` | SVC-11、SVC-12、SVC-13 |
| `profile` | 学员画像、证据、成长快照、记忆与成长卡 | `ProfileService.getProfile/growthSummary/listEvidence/recordSnapshot/upsertMemoryFact/deleteMemoryFact/memorySummary/chatContext/extractEvidence/generateGrowthCard`；纯函数 `isSyntheticEvidence/isAbilityEvidence` | `studentId:string`、`chapterId?`、`competencyId?`、`limit?`；证据抽取 `ExtractEvidenceInput`；记忆 `{kind,key,value}` | `{profile,competencies,plan}` / `GrowthSummaryItem[]` / `Evidence[]` / `GrowthSnapshot[]` / 记忆事实列表；成长卡 `string`（markdown 流） | DB、LLM | **高（画像汇总、快照记录、记忆增删、上下文拼装）**：均为 DB 投影与规则聚合 `[源码]`；**低（`extractEvidence` 结构化抽取、`generateGrowthCard` 流式成文）** `[源码]` | SVC-14、SVC-15 |
| `artifacts` | 学习产物落库、文件落盘、模板渲染与再导出 | `ArtifactService.create(draft)/list(studentId,limit)/get(id)/export(id,format)/renderTemplate(templateId,vars)/writeTextFile(rel,content)` | `ArtifactDraft{studentId,sessionId?,skillId,templateId?,type,title,format?,content,contentJson?,sourceRefs?,evidenceIds?,status?}`；导出 `format:'md'|'docx'|'html'` | `Artifact{id,student_id,session_id,skill_id,template_id,type,title,format,path,content,content_json,schema_version,version,status,source_refs,evidence_ids,created_at}`；导出 `{path}` | DB、FS、模板文件 | **高（路径 containment 校验、id/时间戳生成、DB 写入）** `[源码]`；**中（模板占位替换、markdown→blocks→docx/md 排版、试卷脱敏裁剪 `questionDocument`）** `[源码]`；不直接调 LLM | SVC-16、SVC-17 |
| `news` | Python 采集服务的 TS 客户端 + 面向 agent 的工具注册 | `NewsService.list/get/refresh/ensureFresh/searchAndIngest/crawlAndIngest`；工具 `list_news/get_news/web_search/crawl_url/refresh_news` | 列表 opts `{source?,since?,limit?}`；`refresh(sourceIds?,{wait?,signal?})`；检索 `query,count,{crawl?,signal?}`；抓取 `url,{signal?}` | `NewsArticle[]` / `{article,matches,ideology}` / `RefreshOutcome{results:SourceRunResult[],queued,accepted}` / `SearchIngestResult{query,results,articles,errors}` / `NewsArticle` | DB（本地读）、NET（HTTP 到子进程） | **高（`list/get` 本地库读取）** `[源码]`；**低（`refresh/searchAndIngest/crawlAndIngest/ensureFresh`）**：依赖子进程存活、端口、3 秒查询预算与外部源可达性；返回带 `errors[]` 与 `meta.degraded` 降级位 `[源码]` | SVC-18、SVC-19 |
| `skills` | 技能定义注册与按 id 委派到下游服务 | `SkillService.list()`、`run(skillId,input,context)`；构造时把内置 `DEFINITIONS` upsert 进 `skills` 表 | `skillId`（`question.generate_set/research.design/bp.outline/growth.card/news.analyze`）、`input:Record`、`SkillContext{studentId,sessionId?,chapterId?}` | `SkillResult{skillId,summary,artifact?:Artifact}` | DB + 委派 questions/research/bp/profile/artifacts/news | **高（定义注册、列表返回静态定义）** `[源码]`；**等级随被委派下游**：出题/调研/BP/成长卡为低，新闻分析的库内拼装为中-高；`run` 本身是开关与参数归一 `[源码]` | SVC-24 |
| `knowledge` | 教材知识点检索门面 + agent 工具 | `KnowledgeService.search(query,chapter?,limit?)`、`get(kpId)` | `query:string`、`chapter?`、`limit?`；`kpId:string` | `KnowledgePoint[]` / `{knowledge_point,related_questions:Question[],ideology:IdeologyPoint[]}` | DB | **高**：纯 DB 查询与内存过滤（思政点按 `related_kp_ids` 包含匹配）`[源码]` | SVC-23 |

#### B. 支撑 / 基础设施包

| 包 | 职责一句话 | 对外入口函数 | 输入 | 输出（字段/形状） | 依赖 | 确定性等级（依据） | 可测点 |
|---|---|---|---|---|---|---|---|
| `agent` | 对话编排主服务：会话/轮次/历史/投影/答题/记账 | `AgentService.handleConversation/answerQuestion/answerQuestionSet/getSnapshot/sessionSummaries/suggestions/listLedger/retryLedger/listTurns/flushRecorder`；内部 `StateProjector`、`FeedbackAgent`、`RecorderAgent`、`runTeamTurn/runAgentLoop` | `HandleTurnInput{studentId,sessionId?,message,scopeOverride?,chapterId?}`；答题 `{studentId,sessionId,questionId,answer,artifactId?,chapterId?}`；交卷 `{studentId,sessionId,artifactId,answers:[{questionId,answer}],chapterId?}` | `HandleTurnOutput{sessionId,turnId,text,artifacts,Citation[],plan,Ask[],evidence[],ledger,snapshot,warnings}`；答题 `AnswerQuestionOutput{turnId,text,feedback,evidence,ledger,warnings,status}`；交卷 `AnswerSetOutput{turnId,text,results[],ledger,warnings,status}` | DB、LLM（主循环/教练）、FS（经 artifacts） | **高（`getSnapshot/sessionSummaries/suggestions/listLedger/listTurns`、`StateProjector`、`FeedbackAgent` 规则判定、历史压缩、判分 `text.ts`）** `[源码]`；**低（`handleConversation` 主循环、`answerQuestion` 反馈链路）**：经 `tool-loop.ts` 与 `case-coach.ts` 消费 `llm.stream`，文案与工具调用序列不稳定 `[源码]` | SVC-20、SVC-21、SVC-22 |
| `api` | cordis Typert 远程门面，把领域服务暴露给宿主/远程调用 | `LearningRemote`（`@Remote` 方法：`listChapters/listKps/getKp/listIdeology/listNews/getNews/matchNews/generateQuestions/listQuestions/createResearchProject/.../exportQuestions/exportBp/startSession`） | 各方法入参（与领域服务对应） | 领域实体 / `{id}` / `{path}` / `{sessionId}` | DB + 委派 matcher/questions/research/bp/agents | **高（转发层）**：自身不生成内容，形状由下游决定；`startSession` 生成 `learning_<uuid>` 会话 id `[源码]` | SVC-25 |
| `export` | markdown / docx 文件写入（`docx` 库排版） | `writeMarkdown(path,title,blocks)`、`writeDocx(path,title,blocks)`；类型 `DocBlock{heading?,text?,list?,table?,pageBreak?}` | 路径、标题、block 数组 | 落盘文件；无返回值 | FS | **中**：block→段落/列表/表格映射固定，但 docx 字节布局受库版本影响；同输入同 block 下文本内容确定 `[源码]` | SVC-26 |
| `fs-app` | 应用目录内的沙箱文件系统（继承 dsh 沙箱，加 containment 复核） | `AppFileSystem.resolve/lstat/processPathFromHostPath` | 路径字符串、`{cwd?,signal?}` | `FsTarget`；越界抛 `FS_PERMISSION_DENIED` | FS | **高**：词法 + realpath containment 判定，纯路径逻辑 `[源码]` | SVC-27 |
| `path-gate` | agent 工具执行前的路径/Shell 闸门 | `apply(ctx,{appRoot})`，挂 `tools/pre-execute` 钩子 | 工具名 + arguments | `{kind:'deny',reason,info}` 或放行 `next()` | 无（仅路径判定） | **高**：shell/检索工具名单硬编码拒绝；路径在 session cwd 下解析后做 `isPathUnder` `[源码]` | SVC-28 |
| `llm-json` | 单工具结构化输出调用封装：流式聚合 → 找 tool-call → JSON.parse | `callStructuredTool<T>({ctx,system,prompt,toolName,toolDescription,parameters,route?,maxTokens?,signal?})`、`jsonObjectSchema(properties,required?)` | 结构化请求参数；schema 对象 | 解析后的 `T`；无 tool-call 抛 `StructuredCallError`，JSON 非法抛 `StructuredCallError` | LLM | **低**：结果来自模型；封装层的 schema 拼装与解析本身确定，失败模式可枚举 `[源码]` | SVC-29 |
| `shared` | 跨包类型、zod schema、章节工具、跨度定位、词法工具 | `chapterId/chapterNumberFromPath/CHAPTER_TITLES/locateSpan`；各 `*Schema`；agent 内复用 `text.ts` 的 `normalize/bigrams/similarity/scoreAnswer` | 见各 schema 与函数签名 | 校验后实体 / `SpanLocation?` / 相似度数值 / 判分 `{score,level}` | 无 | **高**：纯函数与 schema 校验；`scoreAnswer` 基于关键词与相似度规则，不调模型 `[源码]` | SVC-30 |
| `ui` | 浏览器侧贡献：远程方法描述符 + 客户端组件（宿主半为空） | `learningRemote`（`client/remote.ts`）；`client/` 下 context/pages/remote/uix | 远程方法名与 anyCodec 描述 | 可挂载的 Typert 远程描述集 | 无（渲染层经宿主协议） | **中**：描述符注册确定；页面文案与状态呈现属渲染层（见 04），不在本篇分级 `[源码]` | SVC-31 |
| `bundle` | 组合层占位：行为都在 `cordis.patch.yml` 与被引用包内 | `apply()`（空实现） | 无 | 无 | 无 | **高（无行为）**：仅组合声明，不产生运行时逻辑 `[源码]` | SVC-32 |

### 2.3 一次出题调用的数据流（跨包示例）

`learning:invoke` → `agent.suggestions`（高，投影）；用户要求出题 → `agent` 工具链调 `skills.run('question.generate_set')` → `questionSmith.generate`（低，LLM + 校验）→ 被接受题目 `db.insertQuestions`（高，落库）→ `artifacts.renderTemplate('question_set',...)`（中）→ `artifacts.create`（高校验 + 中排版 + 落库）。断言时沿这条链分段：库内行数/字段为高置信断言，产物标题与正文长度为中置信，模型措辞不断言。

## 3. 关键代码位置

| 职责 | 文件:行 | 说明 |
|---|---|---|
| DB 构造、appHome 解析、建库占位文件 | `packages/db/src/index.ts:819` `constructor(ctx,config)` | 路径优先 `config.appHome` → `process.env[BRAND.homeEnv]` → `~/.learning-agent`；`data/learning.db`，`wx` 占位 0600 |
| DB PRAGMA | `packages/db/src/index.ts:832` | `foreign_keys=ON`、`journal_mode=WAL`、`busy_timeout=5000` |
| 迁移主循环 | `packages/db/src/index.ts:849` `migrate()` | 按 `PRAGMA user_version` 1→7 逐段事务迁移；高于当前版本直接抛错 |
| 种子数据重置 | `packages/db/src/index.ts:943` `resetDomainData()` | 清空领域表、保留 schema 与 application_id |
| 确定性召回纯函数 | `packages/matcher/src/index.ts:188` `generateDeterministicMatches` | 标签倒排 + bigram 词法 + 角色/质量/多样性排序，无模型无网络 |
| 候选落库 / 后台回填 | `packages/matcher/src/index.ts:355` `candidates`；`:378` `backfill` | 未刷新先读库；`backfill` 逐篇 try/catch 计 errors |
| LLM 标注分支与回退 | `packages/matcher/src/index.ts:398` `match`；`:462-493` | 内容哈希 + prompt_version 缓存；`LLM_FALLBACK` 正则命中才回退词法，否则抛出 |
| 题目校验纯函数 | `packages/questions/src/index.ts:298` `validateQuestion` | 题型/选项/答案/难度/kp 绑定/去重归一校验，返 `{valid,issues}` |
| 出题生成与离线兜底 | `packages/questions/src/index.ts:887` `generate`；`:913-925` | LLM 异常按正则识别后走 `offlineQuestions`；接受数为 0 抛错 |
| 题目导出 | `packages/questions/src/index.ts:968` `exportQuestions` | 落 `appHome/exports/questions-<timestamp>.{json,csv,docx}`；CSV 写 BOM（`:1023`） |
| 结构化重试封装 | `packages/research/src/index.ts:225` `requestStructured` | 最多 3 次；zod `safeParse` + `problems` 双校验；失败抛错，无离线兜底 |
| 调研服务入口 | `packages/research/src/index.ts:486` `ResearchService` | 七步方法 `:516/:541/:576/:602/:667/:702/:727` |
| BP 服务入口 | `packages/bp/src/index.ts:789` `BpService` | 六步方法 `:824/:866/:898/:943/:989/:1041/:1087`；导出 `:1116` `exportPlan` |
| 画像服务 | `packages/profile/src/index.ts:97` `ProfileService` | 汇总 `:104/:382`；证据抽取 `:178`；快照 `:331`；成长卡 `:455` |
| 产物服务 | `packages/artifacts/src/index.ts:90` `ArtifactService` | 模板 `:101`；创建 `:106`；列表/读取脱敏 `:157/:164`；再导出 `:171`；路径校验 `:114/:178/:191` |
| 新闻服务 | `packages/news/src/index.ts:218` `NewsService` | 读库 `:236/:240`；刷新 `:258`；检索入库 `:300`；单篇抓取 `:330` |
| Agent 主服务 | `packages/agent/src/index.ts:199` `AgentService` | 快照 `:227`；对话 `:403`；答题 `:572`；交卷 `:706` |
| 状态投影（规则） | `packages/agent/src/state.ts:36` `StateProjector` | 从 DB 会话/计划/证据投影当前 scope 与阶段 |
| 反馈子代理（规则） | `packages/agent/src/subagents.ts:1` `FeedbackAgent` | 无 `llm` 引用，规则匹配教材库与案例库 |
| 工具主循环（LLM） | `packages/agent/src/tool-loop.ts:235` | 直接 `for await ... llm.stream(...)`；含结果裁剪与调试开关 |
| 案例教练（LLM） | `packages/agent/src/case-coach.ts:541` | 流式消费模型输出 |
| 历史压缩 | `packages/agent/src/history.ts` `buildHistoryView` | 保留最近 3 轮、字符预算 `HISTORY_MAX_CHARS=7000` |
| 判分纯函数 | `packages/agent/src/text.ts` `scoreAnswer/levelFromScore` | 关键词 + 相似度规则判 L1–L4 |
| 知识门面 | `packages/knowledge/src/index.ts:15` `KnowledgeService` | `search:22`、`get:26` |
| 技能委派 | `packages/skills/src/index.ts:211` `SkillService` | 注册 `:217-227`；`run:234` 开关分发 |
| 远程门面 | `packages/api/src/index.ts:31` `LearningRemote` | `@Remote` 方法 `:39-156` |
| 文档写入 | `packages/export/src/index.ts:63` `writeDocx`；`:78` `writeMarkdown` | block → docx/md |
| 沙箱 FS | `packages/fs-app/src/index.ts:17` `AppFileSystem` | `resolve:26`、`lstat:40`、宿主路径映射 `:49` |
| 路径闸门 | `packages/path-gate/src/index.ts:35` `apply` | shell/检索工具拒绝名单 `:22-29`；参数键表 `:10-20` |
| 结构化工具调用 | `packages/llm-json/src/index.ts:37` `callStructuredTool` | `BlockAssembler` 聚合流，取指定 tool-call 后 `JSON.parse` |
| 远程描述符 | `packages/ui/src/client/remote.ts:32` `learningRemote` | 18 个 `learning/*` 方法描述 |
| 组合占位 | `packages/bundle/src/index.ts:1` `apply` | 空实现；挂载关系见 `packages/bundle/cordis.patch.yml` |

## 4. 可测点

> 等待策略与断言口径遵循 spec 第 7 节：高确定性可直接等值/行数断言；中确定性断言结构与区间；低确定性只断言结构、引用可解析、长度区间与状态流转。ID 前缀 `SVC-` 为本篇定义。

| ID | 触发方式 | 观测点（IPC 返回 / DB / 文件 / 日志） | 前置条件 | 断言口径 |
|---|---|---|---|---|
| SVC-01 | 以隔离 `LEARNING_AGENT_HOME` 启动（方式见 08），打开 DB | `data/learning.db` 存在；`PRAGMA application_id=1280201284`、`user_version=7`、`journal_mode=wal` | 空目录首启 | 高：连接成功、application_id 与版本号精确相等 `[源码:db:832-859]` |
| SVC-02 | 经 `learning:invoke` 调 `chapters.list / kps.list / news.list / profile.get` 等只读方法 | IPC 返回数组/对象；对应表行数与返回条数一致 | 已加载 seed 库 | 高：字段名与 `shared` schema 一致；列表顺序与 DB 查询顺序一致；不断言具体文案 |
| SVC-03 | 对一篇 ≥300 字新闻调 `matcher.match({articleId,useLlm:false})` | 返回 `matches/ideology/diagnostics`；`diagnostics.stages` 不含 `llm-tagging`、`diagnostics.llm=false` | 库内有 KP 与教材标签 | 高：同一文章重复调用结果集合稳定；`matches[].kp_id` 均可在 `knowledge_points` 解析；`evidence_span` 为原文连续片段（可回查 `news_articles.content` 包含） |
| SVC-04 | `matcher.backfill(20)`（或 `news.refresh` 后链路） | 返回 `{processed,tagged,errors}`；`case_matches` 增量落库 | 有待标注新闻 | 高：`processed≤pending 数`；`errors` 为计数；落库 `kp_id/article_id` 外键可解析；不对匹配分数文案断言 |
| SVC-05 | 配置有效 LLM 后调 `matcher.match`（默认路径） | `diagnostics.llm`、`stages`；被接受/拒绝数量；失败时回退词法结果 | LLM 可达或不可达两种环境分别跑 | 低：只断言返回 `matches/ideology/diagnostics` 三键存在；`matches[].kp_id` 可解析；`score/confidence` 在数值区间；LLM 不可用时不抛未捕获异常、`notes` 含降级说明；不断言匹配标题与理由文案 |
| SVC-06 | 直接调 `QuestionSmith.validate` / 纯函数单测 | `{valid,issues}`；归一化后 stem 一致；`clampQuestionCount` 边界 | 构造合法/非法题目样本 | 高：合法样例 `valid=true`；缺答案/缺选项/未知题型 `valid=false` 且 `issues` 非空；同 stem 归一化结果相同 |
| SVC-07 | 调 `questions.generate`（有/无 API Key 两环境） | 返回 `Question[]`；`questions` 表新增行；离线路径返回 `offlineQuestions` | 提供 kp/news/text/resource 来源 | 低：断言返回数组长度 1..count；每题 `type∈题型枚举`、`stem` 非空、`options` 与题型匹配、`answer` 非空、绑定 `kp_ids` 均可解析；难度 1..3；模型不可达时兜底路径返回非空数组或空数组，不崩；不断言题干措辞 |
| SVC-08 | 调 `questions.exportQuestions(ids,'json'|'csv'|'docx')` | `exports/questions-<timestamp>.<ext>` 文件落盘；JSON 可解析；CSV 首字节为 BOM；DOCX 为有效 zip | 库内已有题目 | 中：文件存在、大小 >0；JSON 题目数与入参一致；CSV 列头固定；不比对排版像素 |
| SVC-09 | 创建/读取调研项目：`createResearchProject` → `getProject/listArtifacts` | `research_projects`、`research_artifacts` 行；步骤键 ∈ `RESEARCH_STEP_KEYS` | 隔离库 | 高：项目 `id` 可回查；artifact `step` 为固定枚举；`content_json` 可解析 |
| SVC-10 | 调任一 research 步骤方法（如 `parseBrief`） | 结构化对象；对应 zod 字段齐全；有 `projectId` 时落 `research_artifacts` | LLM 可达 | 低：断言顶层字段存在、数组元素非空、`assumptions/未说明` 类缺口字段允许为空字符串；校验失败抛错且错误信息含工具名；不断言问卷题干预设数量与措辞 |
| SVC-11 | 创建/读取 BP 项目与章节 | `bp_projects`、`bp_sections`；章节键 ∈ `BP_SECTION_KEYS` | 隔离库 | 高：项目 id 可回查；章节排序按 `BP_SECTION_ORDER` |
| SVC-12 | 调任一 BP 步骤方法 | 结构化对象；数值字段带 `sources/assumption` 标记位 | LLM 可达 | 低：断言字段存在、`marketSizing` 的 TAM/SAM/SOM 为数值或 null；不断言数字大小与结论；评审意见条数不固定 |
| SVC-13 | `bp.exportPlan({projectId,format})` | `exports/bp-<safeId>-<timestamp>.{md|docx}` 落盘 | 项目已有章节 | 中：文件存在、章节顺序与 `BP_SECTION_ORDER` 一致；空内容回退占位文本；不断言排版 |
| SVC-14 | 调 `profile.getProfile/growthSummary/listEvidence/recordSnapshot/memorySummary/upsertMemoryFact` | 画像/汇总/证据/快照/记忆表；返回结构 | 隔离库 + 预置证据 | 高：`evidence[].competency_id/student_id` 可解析；快照 `checkpoint∈pre|post`；记忆 `kind∈枚举`；汇总等级取值域固定 |
| SVC-15 | 调 `profile.extractEvidence` / `generateGrowthCard` | `Evidence[]` / 流式 markdown 文本 | LLM 可达 | 低：断言证据字段齐全、`method` 标注、`confidence` 区间；成长卡非空且含固定章节标题；不断言评价措辞 |
| SVC-16 | `artifacts.create(draft)` 后 `list/get` | `artifacts` 表行；`artifacts/<studentId>/<YYYY-MM>/<id>.<ext>` 文件；`status/version/schema_version` | 合法 draft | 高：`id` 前缀 `art_`；路径落在 `appHome/artifacts` 内；`studentId` 非法直接抛错不落盘；question_set 列表/读取内容已脱敏（不含答案段） |
| SVC-17 | `artifacts.renderTemplate(templateId,vars)` | 占位 `{{key}}` 被替换；缺 vars 替换为空串 | 模板文件存在 | 中：输出不含未替换的 `{{...}}`；模板缺失抛错；不断言装饰性空格 |
| SVC-18 | `news.list/get` | 本地 `news_articles` / `case_matches` / `ideology_tags` 行 | 库内有新闻 | 高：返回条数与 `countNews` 口径一致；`get` 的 article/matches/ideology 三键齐全 |
| SVC-19 | `news.refresh/searchAndIngest/crawlAndIngest` | HTTP 到采集服务；返回 `results/queued/accepted` 或 `errors[]` | `NEWS_CRAWLER_AUTOSTART=0` 或外置服务（见 06/08） | 低：断言 `queued` 为布尔、`results[]` 元素含 `source/status/fetched/inserted/errors`；降级时 `errors` 非空；不断言抓到的标题与条数；服务不可达时错误可识别 |
| SVC-20 | `agent.getSnapshot/suggestions/sessionSummaries/listLedger/listTurns` | 快照 scope/phase；建议列表；账本状态；轮次表 | 隔离库有历史会话 | 高：快照字段齐全；建议引用的 artifact/turn id 可解析；账本 `status` 取值域固定；不依赖模型 |
| SVC-21 | `learning:chat` 一轮对话；`learning:answer` / `answer-set` | `HandleTurnOutput` 全字段；事件流 `learning:chat-event`；答题 `feedback/status` | LLM 可达/不可达分别跑 | 低：断言 `sessionId/turnId/text/artifacts/citations/plan/asks/evidence/ledger/snapshot/warnings` 键存在；`citations[].articleId/kpId` 可解析；交卷 `results[]` 每题一条；终态 `status∈完成域`；不断言回复文案与建议条数 |
| SVC-22 | 规则子链路单测：答题合并、题目归一、历史拼装、判分 | 纯函数返回；重复输入结果一致 | 构造样本 | 高：`mergeRetryAnswers` 覆盖关系确定；`normalizeArtifactQuestion` 稳定 id；历史截断符合字符预算；判分等级在 L1–L4 |
| SVC-23 | `knowledge.search/get` | KP 列表；单 KP 的相关题目与思政点 | seed 库 | 高：空 query 返章节全量；`get` 不存在返 `undefined`；关联题目 `kp_id` 回指一致 |
| SVC-24 | `skills.run` 各 skillId | `SkillResult{skillId,summary,artifact?}` | 下游服务可用 | 中-低：`skillId` 回显；未知 skill 抛错；产物引用的 artifact 可在库内解析；内容断言随下游档级 |
| SVC-25 | 经 `LearningRemote` 调各 `@Remote` 方法 | 与对应领域服务同形返回 | 宿主装配完成 | 高：转发不改变字段；`startSession` 返 `learning_<uuid>` 格式 id |
| SVC-26 | `writeMarkdown/writeDocx` 固定 block 样本 | 落盘文件；md 标题/列表/表格行；docx 可被解压读出段落 | 临时目录 | 中：md 文本结构确定；docx 字节不做等值比对；表格行列数与 blocks 一致 |
| SVC-27 | `AppFileSystem.resolve` 越界路径 | 抛 `FS_PERMISSION_DENIED`；合法路径返 `FsTarget` | 应用根目录固定 | 高：`..` 逃逸、绝对路径越界均拒绝；同根内相对路径放行 |
| SVC-28 | 工具前置钩子：bash/pwsh/glob/grep 等 | `deny` 决策；读类工具越界参数 `deny` | 配置 appRoot | 高：拒绝名单内工具一律 `kind:'deny'`；错误码 `PATH_OUTSIDE_APP` |
| SVC-29 | `callStructuredTool` 成功 / 模型未调工具 / JSON 非法 | 解析对象；两类 `StructuredCallError` | mock 或真实 LLM | 低：成功时返回对象过 schema；失败错误名固定；不断言模型选择的参数值 |
| SVC-30 | `shared` 纯函数与 schema 单测 | 校验通过/拒绝；`locateSpan` 定位；相似度/判分 | 样本集 | 高：同输入同输出；schema 拒绝缺字段样例；跨度定位命中原文区间 |
| SVC-31 | 渲染前的远程描述符装配 | `learningRemote` 含 18 个方法键 | 宿主加载 ui 包 | 中：方法名集合固定；渲染层断言不在本篇（见 04） |
| SVC-32 | bundle 装配加载 | 无运行时行为变更 | - | 高：`apply()` 空操作；组合效果以 `cordis.patch.yml` 为准 |

## 5. 风险与坑

1. **同一包内确定性混合，按包断言会误判**：`matcher`、`agent`、`skills` 都是「规则/DB 主干 + LLM 分支」。若把 `match()` 整体当高确定性做等值比对，LLM 分支或缓存命中（`packages/matcher/src/index.ts:435-459`）会造成偶发失败；必须按函数/分支拆分断言口径 `[源码]`。
2. **离线兜底只有 questions 有，research/bp/profile 证据抽取没有**：`research.requestStructured` 重试 3 次后抛错（`packages/research/src/index.ts:269`），`bp` 同构；在无 API Key 的隔离环境跑调研/BP 用例，会直接走到异常分支，测试需把「抛错且错误可识别」纳入断言，而不是期待空结果 `[源码]`。
3. **缓存与内容哈希会改变匹配结果来源**：`matcher` 以 `sha256(content)` + `PROMPT_VERSION` 缓存到 `plugin_state`（`packages/matcher/src/index.ts:427-501`）；复制库/改文章后若哈希变了会重算，旧缓存不会误命中，但断言 `diagnostics.stages` 时要区分 `cache` 与 `llm-tagging`/词法阶段 `[源码]`。
4. **新闻链路双写同一 SQLite**：TS 侧读库，Python 子进程写库（见 06/08）；`news.refresh` 是 `wait:false` 入队即返，随后由 `matcher.backfill` 补标注，时序上返回时刻库内不一定已有新行——不能把「invoke resolve」当成「新文章可见」的信号 `[源码:main/index.ts:262-272]`。
5. **`api` 门面使用固定学生 id `student_default`，而桌面 IPC 默认 `student_demo`**：`packages/api/src/index.ts:29` 与 `apps/desktop/src/main/index.ts:27` 是两条装配路径；跨路径造数时别把一个 id 下的记忆/证据断言到另一个 id 上 `[源码]`。
6. **产物脱敏发生在读取侧而非落库侧**：`question_set` 的答案段只在 `list/get` 时由 `questionDocument` 裁剪（`packages/artifacts/src/index.ts:67-88,157-169`），库里 `content` 仍含答案；取证导出文件与库内文本不能混为一谈 `[源码]`。
7. **路径校验依赖 `isPathUnder` 的 realpath 遍历**：`fs-app` / `path-gate` / artifacts 三处闸门对「尚未创建的后缀目录」做逐层 realpath 回挂（`packages/shared/src/containment.ts:13-28`）；符号链接与大小写盘符场景在本机未实测，断言越界拒绝前应先确认路径形态 `[源码，未实测部分见第 6 节]`。

## 6. 未覆盖与待验证

1. **`tool-loop.ts` 工具白名单与每工具的入参/返回 schema 未逐条展开**：本篇只定位到主循环 LLM 调用点（`tool-loop.ts:235`）。验证方法：阅读 `packages/agent/src/tools/` 与各服务 `defineTool` 注册段，补到 03/11 文档对应工具条目。
2. **`case-coach.ts` 的教练规则与模型分支边界未逐行核对**：已知 `:541` 调 `llm.stream`，其规则前置部分的覆盖条件未穷举。验证方法：在隔离库中分别喂「教材内案例 / 外部新闻 / 无关闲聊」三类样本，观察 `TurnStep` 序列与降级路径。
3. **research / bp 的 zod 输出 schema 字段全集未在本篇列出**：表中只给了步骤名与约束类别。验证方法：以一条固定 brief/idea 调通后，把 IPC/DB 返回的 JSON 落盘为 fixture，再据此补字段级断言清单。
4. **`skills` 五个技能在真实装配下是否全部可达**：`run` 开关与 `cordis.patch.yml` 预设插件的对应关系未端到端跑过。验证方法：隔离环境分别以四个预设启动 agent 会话，逐技能触发并记录 `SkillResult`。
5. **`ui` 包客户端页面与渲染层 `apps/desktop/src/renderer` 的漂移程度**：本篇未对比两份 pages 实现（spec 基线已提示字节数接近、存在漂移风险）。验证方法：见 `04-renderer-ui-flows.md` 与 `09-existing-verification-and-gaps.md` 的对照记录。
6. **LLM 不可达时 `agent` 主循环的降级文案与事件序列**：源码可见 matcher/questions 有正则回退，但对话主循环在无 Key 时的完整行为未实测。验证方法：隔离 `LEARNING_AGENT_HOME`、不设 `DEEPSEEK_API_KEY` 启动，捕获 `learning:chat-event` 与最终错误对象。

## 7. 交叉引用

- 库结构、seed 基线、隔离环境与造数清理：`08-data-fixtures-and-isolation.md#41-sqlite-结构基线`、`08-data-fixtures-and-isolation.md#5-最小隔离运行组合powershell可直接照抄`、`08-data-fixtures-and-isolation.md#46-产物与导出目录隔离`
- IPC 方法契约与通道方向：`03-ipc-and-preload-contract.md`（`learning:invoke` 各分支对应本篇 SVC-02/SVC-07/SVC-10/SVC-12/SVC-14/SVC-16/SVC-19/SVC-20/SVC-21）
- 渲染层页面与交互断言：`04-renderer-ui-flows.md`
- Python 采集服务、端口与离线降级：`06-news-sidecar-and-network.md`（对应 SVC-19）
- 启动装配顺序与服务单例：`02-main-runtime-and-boot.md`
- 既有校验脚本覆盖：`09-existing-verification-and-gaps.md`
- 场景用例与依赖 ID：`11-scenario-catalog.md`
