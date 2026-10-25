# R15 产物与导出

> 状态：MVP（本轮）
> 依赖：[R03](R03-tools.md)、[R17](R17-local-data.md)
> 代码：`packages/agent/src/artifacts.ts`、`packages/agent/src/tools/write-tools.ts`、`packages/artifacts/src/index.ts`、`packages/export/src/index.ts`、`apps/desktop/src/renderer/src/renderers.tsx`、`apps/desktop/src/renderer/src/ui.tsx`
> 上位原则：`../principles/single-agent.md`

## 1. 要什么（学生可见结果）

学生要一份「能带走的东西」时，右栏出现一份**打开就能看**的内容：

- 默认是页面（HTML）：排版好、能滚动阅读、离线可看，不出现 `##`、`**`、裸 JSON。
- 唯一的例外是题目集：学生要在里面选、交卷、看逐题解析，所以是结构化数据，由我们的做题壳子渲染。
- 可以导出：页面导出网页原件；题目集导出 Markdown / Word（不含答案）。
- 历史产物还在库里，打开不能变成一堆 Markdown 符号。
- 产物是下一轮的输入：上一轮写的页面/题目集，下一轮能接着改、接着追问。

## 2. 落位（提示词 / 工具 / skill / 数据）

| 层 | 放什么 | 位置 |
|---|---|---|
| 提示词 | 什么时候产附件、HTML 硬约束、写完就停 | `packages/agent/agents/mentor.md:124-149` |
| 工具 | 只有两个写入工具 | `write_page`（`tools/write-tools.ts:97`）、`emit_question_set`（`:122`） |
| 手册 | 页面与题目集怎么写 | `packages/agent/references/artifact-schemas.md` 第 1–4 节 |
| 数据 | `artifacts` 表 + 磁盘文件 | `packages/db/src/index.ts:308`；文件落在 `LEARNING_AGENT_HOME/artifacts/<studentId>/<YYYY-MM>/` |
| 渲染 | 沙箱 iframe + 结构化分支 | `apps/desktop/src/renderer/src/ui.tsx:188`、`renderers.tsx:744` |

## 3. 行为（一轮里怎么发生）

1. **模型调写入工具**：`write_page` 或 `emit_question_set`，内容长就分 2–3 次写；`collect` 按 spec 合并（`packages/agent/src/artifacts.ts:74`）。
2. **本轮结束统一落库**：`finalizeArtifacts` 先按 schema 校验（`:96`）；校验失败只记 warning、这一份不生成，学生看到「可以让我重做一次」（`:105-107`）。
3. **写文件 + 插库**：`ArtifactService.create` 按 `format` 决定落盘形态，然后 `insertArtifact`。
4. **右栏打开**：页面进 `HtmlFrame`（沙箱，三栏与标签行为见 [R16](R16-conversation-ui.md)）；题目集进做题壳子（作答与批改见 [R09](R09-questions.md)）；历史结构化产物走旧分支。
5. **导出**：菜单按 `isPage()` 分流，页面只给「导出网页」，其余给 Markdown / Word。
6. **下一轮**：回复里只说判断与下一步；下一轮由模型按需再取（当前缺口见第 7 节）。

## 4. 契约

### 4.1 两类产物与边界

| | `page`（默认） | `question_set`（唯一结构化） |
|---|---|---|
| 判断条件 | 学生要一份能带走的东西，但不需要在里面动手 | 学生要在里面作答，作答要被批改、记证据、进题库 |
| 内容 | `{ title, html }`（`PageContentSchema`） | `{ intro, questions[] }`（`QuestionSetContentSchema`） |
| 落库格式 | `format: 'html'`，写 `<id>.html` | `format: 'docx'`，另存 Markdown 导出稿 |
| 渲染 | 沙箱 iframe | 题目卡（答案交卷前折叠） |
| 导出 | 只导出网页原件 | Markdown / Word（打印稿不含答案） |
| schema 版本 | `Page@1` | `QuestionSet@1` |

判定链：**要附件吗？** 不要 → 聊天里讲完；要 → **要动手且结果要被系统接着算吗？** 要 → 题目集；不要 → 页面。

### 4.2 写入工具签名

```ts
write_page({ title?: string, html: string, sourceRefs?: string[] }): string
emit_question_set({ title?: string, content: object, markdown?: string, sourceRefs?: string[] }): string
```

- `html` 是**正文片段**：不写 `<html>`/`<head>`/`<body>`，不写 `<h1>`，不写 `<script>`，不引外部 CSS/JS/字体/图片。
- `emit_question_set` 的 `content.questions[].kpIds` 收**知识点中文名**，工具自己翻成内部 id（`write-tools.ts:9` 的 `resolveKpIds`）。
- 分次写：页面按顺序拼 `<section>`（`write-tools.ts:37-40`）；题目集按题干去重（`write-tools.ts:80-92`），不整份重写。

### 4.3 落库与导出

- `format === 'html'` → `join(dir, id + '.html')`，直接写原文，不转 Markdown/Word（`packages/artifacts/src/index.ts:121-124`）。
- 其他格式 → 先写 `.md`，`docx` 再写一份 `.docx`（`packages/export/src/index.ts` 的 `writeDocx` / `writeMarkdown`）。
- `export(id, format)`：页面产物无论要什么格式都返回 HTML 原件（`:176`）；非页面按 `md|docx` 生成到同目录（`:177-185`）。
- 题目集导出前先过 `questionDocument`（`:67`）：只印题干与选项，附一句「参考答案仅在交卷后显示」。

### 4.4 右栏渲染的安全边界

- `HtmlFrame` 用 `sandbox=""`（禁脚本、禁同源、禁表单）+ CSP `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:`（`ui.tsx:186`），`referrerPolicy="no-referrer"`。
- 宿主注入基础排版样式（`:192-198`），模型只提供正文片段。
- 页面里出现脚本或外链时，浏览器直接拦掉，不报错给学生。

## 5. 边界（不做什么、失败怎么表现）

- **不每轮产附件**：一句「为什么」、一次追问都不该变成附件；右栏不是阅读器。
- **不把 HTML 转成正文**：页面类产物不做 Markdown 降级，否则导出的是标签。
- **不给每类产物配模板与渲染器**：新产物一律 `page`；右栏的展示规则统一由 [R16](R16-conversation-ui.md) 管。
- **不暴露内部结构**：不出现 `kp_*`、`src_*`、阶段标签、置信度、裸 JSON。
- **失败表现**：schema 校验失败 → 这一份不生成、回复里说明可重做，不留空卡片；路径越界 → 抛 `PATH_OUTSIDE_APP`，不写文件。
- **历史产物**：5 个结构化渲染分支与 `apps/desktop/templates/*.md` 标为待清理，**本轮不删**（删了历史产物只能降级成 Markdown）。

## 6. 验收（场景 → 期望）

1. **「给我一份案例精讲」** → 右栏出现页面；正文里没有 `##`、没有 `**`、没有裸 JSON；页面内无 `<script>`、无外链请求（CSP 拦截后仍可读）。
2. **导出页面** → 菜单只有「导出网页」，导出得到 `.html` 原件，不是把标签转成 Markdown。
3. **导出题目集** → 得到 Markdown / Word，打印稿不含答案；答案在交卷后由做题壳子展示。
4. **模型分 3 次写页面** → 三段 `<section>` 按顺序拼成一份，右栏只出现一个标签，不出现三份。
5. **内容不合 schema**（例如题目缺 `stem`）→ 这一份不生成，回复说「可以让我重做一次」，右栏不留空白卡片。
6. **打开有渲染分支的历史产物**（`research_design` / `bp_outline` / `case_analysis` / `case_study` / `growth_card`）→ 仍能按结构化预览，不出现裸 JSON 或 Markdown 符号；`questionnaire` / `bp_section` / `evidence_pack` 目前只能 Markdown 预览，属已知待清理项。
7. **学生没要附件**（「这个概念什么意思」）→ 右栏不新增标签，回复里没有「附件在右栏」。

## 7. 现状与差距（代码事实）

**已符合**

- 两个写入工具即全部：`WRITE_TOOLS` 只有 `write_page` / `emit_question_set`（`packages/agent/src/tools/write-tools.ts:95`）。
- 页面落 `.html`、不转格式（`packages/artifacts/src/index.ts:121`）。
- 沙箱 iframe + CSP（`apps/desktop/src/renderer/src/ui.tsx:186`、`:204`）。
- 页面导出给原件（`packages/artifacts/src/index.ts:176`；菜单 `workspace.tsx:319`）。
- 校验失败只警告不中断（`packages/agent/src/artifacts.ts:105-107`）。

**差距**

- **产物不是下一轮的输入**：`environment()`（`packages/agent/src/team.ts:97-111`）只拼章节/学情/知识点目录，没有产物摘要；`runTeamTurn` 的 `history` 只有 user/assistant 文本（`packages/agent/src/index.ts:439-442`）。模型看不到上一轮写了什么，也没有读产物的工具。
- **`skillId` / `templateId` 是硬编码**：落库时 `skillId: 'agent'`、`templateId: pending.spec.type`（`packages/agent/src/artifacts.ts:115-116`），产物与 skill、模板没有真实关联。
- **历史 5 个结构化渲染分支仍在**：`research_design`、`bp_outline`、`case_analysis`、`case_study`、`growth_card`（`renderers.tsx:751-760`，实现分别在 `:235`、`:316`、`:391`、`:552`、`:695`），只为库里的历史产物服务；`ArtifactSchema.type` 里对应枚举仍在（`packages/shared/src/index.ts:415`）。
- **还有三种历史类型没有渲染分支**：`questionnaire`、`bp_section`、`evidence_pack` 落到 `ArtifactRenderer` 的 `default`，走 `MarkdownView`（`renderers.tsx:761-765`）——这几类产物在右栏就是 Markdown 预览，与第 1 节「不出现 `##`」的要求冲突，属待清理项。
- **模板仍在打包**：`apps/desktop/templates/` 下 4 个模板（`growth_card.md`、`bp_outline.md`、`research_design.md`、`question_set.md`）由 `templatesDir` 注入（`apps/desktop/src/main/index.ts:88`）并随构建发布（`electron-builder.yml:9`）；当前调用方只有旧路径 `packages/skills/src/index.ts:279/344/384/484` 与未接线的 `packages/agent/src/news-lab.ts:423`。
- **旧路径仍能旁路写文件**：`ArtifactService.writeTextFile`（`packages/artifacts/src/index.ts:189`）与 `packages/bp` 的 `export_bp` 都能绕开产物契约写盘（待核对：是否还有调用方）。

## 8. MVP 范围与后续

**MVP 做到哪**

- 两类产物、两个写入工具、`.html` 落库、沙箱渲染、导出分流，全部按第 4 节。
- 历史产物可打开；5 个渲染分支与 4 个模板保留并标为待清理。
- 产物内容不出现 Markdown 符号、裸 JSON、脚本、外链。
- 产物是下一轮的输入：`environment()` 加「最近产物」摘要（最多 3 条，只含标题 / 类型 / 状态），正文不进 system。

**后续**

- 读产物正文：**新增工具：`read_artifact(artifactId: string)`**（返回标题、类型、正文摘要与来源），需要接着改上一份产物时按需读，不把正文塞进 system。
- 清理历史：确认库里历史产物已归档后，删 5 个渲染分支、`templates/` 与 `renderTemplate`。
- 产物版本化（同一份页面的 v1/v2）与「继续完善刚才的产物」的状态联动。

**明确不做**

- 不做按产物类型配置的模板体系。
- 不做页面内交互（折叠、答题、跳转）——交互只走题目集。
- 不做在线预览服务、不做 PDF 导出。
