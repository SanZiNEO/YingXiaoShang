# I · 小程序 UI 原型（纯 mock）· 范围与边界

> 轮次：I · 小程序纯静态 mock 原型
> 文档角色：01-scope
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1
> 写权：[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1
> 一句话：在 `tools/miniprogram-mock/` 下用纯静态 HTML/CSS/JS 做出 375px 宽的 5 页原型，数据全部来自 `fixtures/*.json`，断网可开、页间可跳，并在每一处「将来接真机」的位置打上标注。

## 1 目标

1. **5 个静态页面可在浏览器里直接互跳**：首页、新闻列表、新闻详情、问答（作答记录）、我的。
   判断标准：双击 `tools/miniprogram-mock/index.html` 以 `file://` 打开后，底部导航与页面内链接能在 5 页之间往返；不启动任何本地服务、不访问 `127.0.0.1` 或外网地址。页面结构与 375 宽度惯例对齐小程序设计指南的信息层级 [R1]。
2. **全部展示数据来自 `fixtures/*.json`，无网络请求**：每页只读取自己对应的 fixture，字段形状对齐冻结 §5 的 5 个只读方法返回结构（`student.current`、`news.list`、`news.get`、`questions.attempts`、`profile.get`）。
   判断标准：DevTools Network 面板在页面加载与三态切换时不出现任何 `http(s)` 请求；把机器断网后刷新，页面仍能渲染正常态数据。
3. **三态齐全：loading / error / empty 均可复现**：每页除正常态外，还能通过 URL 参数切到骨架屏、错误面板、空状态面板，三态文案与布局在 375px 下不溢出。
   判断标准：`pages/news.html?state=loading`、`?state=error`、`?state=empty` 三种参数各刷新一次，分别看到骨架、错误面板、空状态；去掉参数回到正常态。
4. **375px 视口无横向滚动**：正文、卡片、标签、长串文本都在视口宽度内换行，不出现左右拖动。
   判断标准：DevTools 设备宽度设为 375px，`document.documentElement.scrollWidth` 不大于 375；纵向允许滚动，横向不允许。不横向滚动的布局约束按响应式设计的 `max-width` / 换行口径落地 [R2]。
5. **每一处将来接真机的位置都有显式标注**：数据加载点、字段绑定点、导航入口、错误兜底点都标出「将来替换成哪个冻结方法 / 哪个通道」，让后续小程序实现者一眼看出 mock 与真机的接缝。
   判断标准：每个页面至少有一处标注，标注格式在 `02-contract.md` §2 写死；标注不参与渲染逻辑，只作为注释或 `data-*` 属性存在。
6. **原型不引入任何构建链与运行时框架**：不装 npm 依赖、不打包、不引小程序框架；产物是可被任意静态服务器或 `file://` 直接打开的 HTML。
   判断标准：`tools/miniprogram-mock/` 下只有 HTML/CSS/JS/JSON/Markdown；目录内没有 `package.json`、`node_modules`、`dist`。

目标排序是「先定页面与数据面，再定三态与布局，最后打接缝标注」：先把 5 页与 5 个方法的对应关系钉死 [R8]，再处理空错载三态，避免一开始就被视觉细节牵着走。

## 2 非目标

| 不做 | 为什么 |
|---|---|
| 不接 `apps/server`、不发任何 HTTP/RPC/SSE 请求 | 本轮是断网可开的原型；真机联调是后续轮次的事。mock 只在字段形状上对齐冻结 §5，不复制传输层信封 [R8] |
| 不实现登录、token、鉴权 | 5 个页面用到的方法在冻结 §5 里均为只读、无归属校验；原型里的学生身份直接取自 `fixtures/student.json`，不做登录页 |
| 不实现 `files.reveal` / `files.preview` / `files.openDialog` / `settings.get` / `settings.set` 这 5 个能力的入口 | 冻结 §6 明确排除：这 5 个是桌面端本机能力，HTTP 化不实现，**小程序 mock 一律不碰**。5 个页面不得出现「打开所在文件夹」「预览本地文件」「打开文件对话框」「设置页填 Key」之类入口；现状代码见 `apps/desktop/src/main/index.ts:370-389` 与 `apps/desktop/src/main/index.ts:537-538` |
| 不做写操作：不出题、不交卷、不提交答案、不复核证据、不记快照 | `questions.attempts` 在冻结 §5 是只读；原型问答页只展示历史作答与对错，不提供提交按钮写回。写操作对应的 `/api/v1/answer`、`/api/v1/answer-set` 通道本轮不接 |
| 不做真实新闻采集、不读本机 `learning.db`、不读 `.learning-agent` 数据目录 | 原型数据是手工编写的 fixture；读真实库会把原型绑死在本机环境上，也违反「不碰真实数据目录」的并行规则 |
| 不做小程序框架工程（不写 `wxml/wxss`、不接微信开发者工具、不做分包与路由配置） | 本轮交付物是浏览器可开的 HTML 原型，用来对齐页面结构与字段；框架化是真机阶段的工作 |
| 不做视觉高保真：不引入设计系统组件库、不做动效与主题切换 | 原型只保证信息层级、点击区尺寸与换行正确；动效按 `prefers-reduced-motion` 降级，不做复杂动画 [R3] |
| 不改 `apps/desktop/**`、`packages/**`、`docs/**` 任何一行 | 这些路径在写权矩阵里属于禁止写区；本轮只读它们作为现状证据 |
| 不做中英文案之外的多语言、不做无障碍完整审计 | 原型文案为中文；字号、对比度等只做最低限度对齐，不替代后续真机阶段的无障碍评审 |

## 3 真实依据（现状代码）

> 下表每条都指向仓库当前代码；行号为 Python 口径（按文件实际行数计），写文档前已用 `Select-String` 核实。原型字段形状必须从这些现状结构上长出来，不自造第二套命名。

| # | 位置 | 现在是什么 | 为什么必须作为本轮依据 |
|---|---|---|---|
| 1 | `apps/desktop/src/main/index.ts:209-212` | `student.current` 返回 `{ studentId, name, cohort }`，`name` 缺省兜底为 `'学生'`、`cohort` 缺省为空串 | 首页与「我的」页顶部身份区的三个字段以此为准；fixture 必须保留同样的兜底口径，不能把缺省值写成 `null` |
| 2 | `apps/desktop/src/main/index.ts:251-256` | `news.list` 调 `db.listNews({ source, since, limit })`，`limit` 缺省 20 | 新闻列表页的卡片字段、`source` 筛选形态、默认条数口径都从这里取；fixture 是数组，元素结构对齐 `NewsArticleSchema` |
| 3 | `apps/desktop/src/main/index.ts:274-282` | `news.get` 返回 `{ article, matches, ideology }`；查不到时返回 `undefined` | 新闻详情页必须分三块渲染：正文卡片、知识点匹配、思政匹配；「查不到」对应详情页 error/empty 分支 |
| 4 | `apps/desktop/src/main/index.ts:290-295` | `questions.attempts` 调 `db.listAttempts({ studentId, questionIds, limit })`，`limit` 缺省 200 | 问答页的数据行形状对齐 `QuestionAttemptSchema`；原型只展示记录，不调提交接口 |
| 5 | `apps/desktop/src/main/index.ts:296-297` | `profile.get` 调 `profileService.getProfile(studentId)`，返回 `ProfileData` 形状 | 我的页的目标约束、能力维度、证据账本三块结构以此为准；字段空数组时走空态 |
| 6 | `apps/desktop/src/renderer/src/pages.tsx:282-293` | 新闻列表用 `Card` 包 `Row`，每行显示 `title` 与 `source · published_at`（日期截前 10 位） | 新闻列表卡片的信息顺序与字段取舍直接参照现状，不额外堆 `summary`、`author` 等字段到首行 |
| 7 | `apps/desktop/src/renderer/src/pages.tsx:299-310` | 新闻详情在选中前显示空态「选择一条新闻查看原文与匹配证据」；选中后渲染 `source` / `content_status` 标签、原文链接、`content` 正文 | 详情页的标签行、链接行、正文段结构参照现状；`content` 长文在 375px 下必须换行，不照搬桌面端 `maxHeight:300` 的横向滚动写法 |
| 8 | `apps/desktop/src/renderer/src/pages.tsx:313` | 匹配结果为空时显示 `Empty`「尚未匹配」 | 详情页匹配区的空态文案与兜底位置参照现状；原型空态不藏起整段标题 |
| 9 | `apps/desktop/src/renderer/src/pages.tsx:109-113` | 新闻加载抛 `RemoteUnavailableError` 时置 `remoteMissing=true`、列表置空 | 现状已有「远端不可用」分支；原型把它显式化成 `?state=error` 面板，文案按 §4 重写为原型口径 |
| 10 | `apps/desktop/src/renderer/src/renderers.tsx:103-127` | 题目集为空时不显示死话，给一句兜底说明加两个可点的下一步按钮 | 原型空态遵循同一原则：空状态必须带一句「现在没有什么」加一个可操作的返回动作，不留一句干巴巴的「暂无数据」 |
| 11 | `apps/desktop/src/renderer/src/renderers.tsx:136-163` | 每题记录 `attempt`，按 `score >= 0.99` 判答对/答错并打标签；题型、难度、题干在标签行排列 | 问答记录行的对错标签、题型标签、题干排版参照现状；原型不做选项点选交互 |
| 12 | `apps/desktop/src/renderer/src/renderers.tsx:208-212` | 已作答后展示「你的答案 / 参考答案 / 解析」三段 | 问答记录展开态的三段结构参照现状；fixture 里的 `answer`、`explanation` 字段必须有对应位置 |
| 13 | `apps/desktop/src/renderer/src/App.tsx:320-321` | `ProfileView` 从 `profileData.profile` 取目标约束、从 `profileData.growth` 取能力维度 | 我的页两个主区块的数据来源不同，fixture 要分开放，不能把成长卡数据塞到 `profile` 字段里 |
| 14 | `apps/desktop/src/renderer/src/App.tsx:363` | 能力维度为空时显示空态「还没有形成能力快照。」 | 我的页能力区空态文案参照现状；原型三态切换时复用同一句中文 |
| 15 | `apps/desktop/src/renderer/src/App.tsx:386` | 证据账本为空时显示空态「还没有学生能力证据。」；非空时按 `competency_id` 回查能力名 | 证据列表的标签回查逻辑在原型里由 fixture 内联冗余一份能力名，避免原型再做一次字典查找 |
| 16 | `apps/desktop/src/renderer/src/App.tsx:750-763` | `loadAttempts` 先取题目 `questionIds` 再调 `questions.attempts`，`catch` 后把错误写进 `notice` | 现状错误是「捕获后挂到通知位」；原型把错误提升为整页 error 面板，保证断网/解析失败时学生看得见原因 |
| 17 | `apps/desktop/src/renderer/src/ui.tsx:176-180` | `Empty` 组件是灰色居中文本、上下 24px 内边距 | 原型空态的最小视觉口径参照这个组件，不另造居中插图 |
| 18 | `packages/shared/src/index.ts:124-137` | `NewsArticleSchema` 字段：`id/source/source_id/title/url/author/published_at/summary/content/content_status/rights/fetched_at`，`content_status` 枚举 `full/partial/unavailable` | 新闻两个 fixture 的字段全集以此为准；原型不展示的字段可以不出现在 fixture，但已出现的字段名不得改写 |
| 19 | `packages/shared/src/index.ts:260-268` | `QuestionAttemptSchema` 字段：`id/question_id/student_id/answer/feedback_json/score/created_at` | 问答 fixture 每行必须带这些字段；`score` 为 number，对错判定口径参照 `renderers.tsx:142` |
| 20 | `packages/shared/src/index.ts:333-344` | `StudentProfileSchema` 字段：`id/name/cohort/background/goals/preferences/constraints/self_assessment/created_at/updated_at` | 我的页 `profile` 区块字段以此为准；数组与记录类型字段缺省为空，不写 `undefined` |
| 21 | `packages/shared/src/index.ts:346-375` | `EvidenceSchema` 字段：`id/student_id/competency_id/level/strength/evidence_type/source_type/source_id/chapter_id/session_id/excerpt/rationale/confidence/method/review_status/review_note/occurred_at/created_at/metadata` | 证据账本行展示 `level/strength/review_status/excerpt/occurred_at`，其余字段在 fixture 里保留键位但可置空值 |
| 22 | `apps/desktop/src/main/index.ts:370-389` 与 `apps/desktop/src/main/index.ts:537-538` | 5 个被排除能力的现状实现：`shell.showItemInFolder`、`previewFile`、`dialog.showOpenDialog`、`settings.readPublic`、`settings.write` | 这 5 段是 §2 排除清单的代码证据；原型里任何卡片、按钮、链接都不得触发对应行为 |

fixture 与共享 schema 对齐的做法，参照「测试数据对象图由固定结构生成」的 fixture 组织方式 [R7]；我们不引入生成库，只手工维护与 schema 同构的 JSON 文件。

## 4 与现行为的差异（有意变更）

| 项 | 现状（Electron 渲染层） | 原型契约 | 影响谁 |
|---|---|---|---|
| 数据来源 | `window.learning.invoke(method, args)` 走 IPC 到主进程（`apps/desktop/src/renderer/src/App.tsx:582`、`:758`） | 页面只读同目录 `fixtures/*.json`；方法名只作为标注写在接缝处 | 后续真机实现者：换数据源时只改 loader，不改页面结构 |
| 错误呈现 | 捕获后挂到 `notice` 通知位（`App.tsx:760-761`） | 整页 error 面板，带中文说明与「重试」按钮（按钮在原型里只重置当前态，不发请求） | 原型验收者：三态必须整页可见，不允许错误只出现在角落提示 |
| 空态入口 | 空数组时在对应区块内显示 `Empty`（`pages.tsx:283`、`App.tsx:363`、`:386`） | 空态既是区块内兜底，也可经 `?state=empty` 整页演示；文案逐字沿用现状可复用的句子 | 文案评审：原型空态句子与桌面端保持一致，避免同一功能两套说法 |
| 布局宽度 | 桌面三栏自适应宽度，内容区可横向容纳长表格 | 固定 375px 原型宽度，单列布局；长串文本必须换行，不允许 `white-space: nowrap` 撑出视口 | 真机阶段的小程序页面按此单列结构迁移 |
| 本地文件能力 | 主进程提供 reveal/preview/openDialog（`index.ts:370-389`） | 原型完全不出现这 3 个入口；新闻外链仅以文本链接形式展示，不调本机预览 | 排除清单落地检查：5 个页面 HTML 里检索不到对应按钮文案 |
| 设置能力 | 主进程提供 settings 读写（`index.ts:537-538`） | 原型不出现设置页、Key 填写框；`我的`页只展示档案信息 | 后续真机若需要设置，另立轮次，不在本原型补 |
| 写回行为 | 桌面端可出题、交卷、复核、记快照 | 原型全部只读；交互按钮（如「重试」「返回列表」）只做页面内跳转或态切换 | 验收者不得把原型里的假按钮当成已实现功能 |

> 页面命名与原始 README 的对应关系：`I-miniprogram-mock/README.md` 保留为原始需求基线不改写；本轮按冻结 §5 的只读方法面把 5 页收敛为「首页 / 新闻 / 新闻详情 / 问答 / 我的」。README 里早期稿的「提问、回答带引用、出题、答题、学情」标签，在本目录 `02-contract.md` §2 的页面映射表里逐项对应到上述 5 页。

布局从桌面三栏收窄到 375 单列，是本轮最主要的有意放宽；换行与容器约束按响应式基线落地 [R2]。方法名、字段名不随原型改名，保持冻结 §5 的点分命名口径 [R7]。

## 5 产物清单

> 根目录：`tools/miniprogram-mock/`。除 `README.md`（原始基线，保持原样）外，以下全部为本轮新建；路径与 `02-ownership-and-parallel.md` §1 的 `tools/miniprogram-mock/**` 写权对齐。

```text
tools/miniprogram-mock/
  index.html                     原型入口：5 页导航总览 + 三态切换入口 + 接缝说明；file:// 直接打开
  README.md                      原始需求基线，保持原样（本轮不改写）
  pages/
    home.html                    首页：身份概览（student.current）+ 5 页入口导航
    news.html                    新闻列表：卡片列表（news.list）
    news-detail.html             新闻详情：正文 + 匹配 + 思政（news.get）
    ask.html                     问答：历史作答记录与对错（questions.attempts，只读）
    profile.html                 我的：目标约束 + 能力维度 + 证据账本（profile.get）
  styles/
    app.css                      全局样式：375 容器、卡片、标签、按钮、空/错/载三态样式、换行规则
  scripts/
    app.js                       共享 loader：读 fixture、解析 `?state=`、渲染三态、跳转导航、接缝标注解析
  fixtures/
    student.json                 student.current 结果：{ studentId, name, cohort }
    news-list.json               news.list 结果：NewsArticle[]
    news-detail.json            news.get 结果：{ article, matches, ideology }
    attempts.json               questions.attempts 结果：QuestionAttempt[]
    profile.json                 profile.get 结果：ProfileData（profile/competencies/plan/evidence/growth）
```

文件级职责与判据：

| 产物 | 作用 | 新建/修改 |
|---|---|---|
| `index.html` | 总览与导航枢纽；列出 5 页链接、三态演示链接、本轮不碰的 5 个排除能力说明 | 新建 |
| `pages/*.html` | 每页一个静态 HTML，内引 `../styles/app.css` 与 `../scripts/app.js`；页面骨架与空/错/载占位节点写死在 HTML 里 | 新建 5 个 |
| `styles/app.css` | 唯一样式表；宽度、点击区、换行、三态样式集中在此，页面内联样式不得重复定义宽度规则 | 新建 |
| `scripts/app.js` | 唯一脚本：按页面配置读对应 fixture，按 `state` 参数选渲染分支；不发网络请求 | 新建 |
| `fixtures/*.json` | 5 份手工 mock 数据，字段对齐冻结 §5 与共享 schema；每份含正常态样例，另在 `?state=empty` 时由脚本切换为空集合，不在 JSON 里复制三份空文件 | 新建 5 个 |

纯静态、无构建链的目录组织方式参照静态 HTML 原型的常见结构 [R6]；数据与视图分离（JSON 只放数据、HTML 只放骨架、CSS/JS 各管一段）参照 mock 数据与前端解耦的做法 [R4]，但不引入 json-server 这类需要起进程的 mock 服务。

## 6 并行边界

### 6.1 只读依赖

1. **冻结契约只读引用**：`../00-master/01-frozen-contracts.md` §5 的方法名与返回顶层、§6 的排除项、§4.2 的错误码表，本轮只引用不改；字段形状以 `packages/shared/src/index.ts` 的 schema 为准，只读不改动。
2. **桌面端渲染层只读参照**：`apps/desktop/src/renderer/src/` 下的 `App.tsx`、`pages.tsx`、`renderers.tsx`、`ui.tsx` 只作为现状证据与排版参照；不 import、不复制其组件代码到原型目录。
3. **主进程只读参照**：`apps/desktop/src/main/index.ts` 的方法分支只用于核对返回结构；原型不引用其 IPC 通道名做任何真实调用。

### 6.2 写权唯一

4. **写权范围**：本轮唯一可写路径是 `tools/miniprogram-mock/**`。`apps/desktop/**`、`packages/**`、`docs/**`、`apps/server/**`、其余 `tools/**` 目录全部只读；`tools/miniprogram-mock/` 之外不新建任何文件。若后续发现必须改共享文件，按 `02-ownership-and-parallel.md` §1 的约定，在本文档「需要 owner 配合的变更」里写明 diff 建议，交由人裁决，不直接动。

### 6.3 运行时资源

5. **无端口、无进程、无临时数据目录**：原型以 `file://` 打开，不监听任何端口，不写 `.scratch/run/I/`，不读写真实数据目录（`%APPDATA%`、`~/.learning-agent`、`<repo>/.learning-agent`）。`scripts/app.js` 里不出现 `fetch('http://…')`、`WebSocket`、`EventSource`、`<img src="http://…">` 等任何联网形态；页面内的新闻外链只渲染为文本，不在原型阶段点击跳转。

### 6.4 不依赖他轮产物

6. **开工不需要 A–H 任何一轮完成**：5 份 fixture 是手工编写的自包含数据；不等待 `apps/server` 起服务、不等待 OpenAPI 文件、不依赖采集库或数据库副本。真机联调（接 A 的 HTTP 服务）是原型验收之后的可选加跑，不是开工前置条件。

### 6.5 冲突裁决

7. **撞车规则**：与其他轮次共享的只有仓库根目录与 master 文档；本轮不改 master、不改他轮目录。若发现 `tools/miniprogram-mock/` 下已有他人文件，先在交付报告里登记外部改动，不擅自回滚；契约口径与冻结文件冲突时，以冻结文件为准，本原型不自行放宽字段或补入排除能力。

整轮不占端口、不起进程、不写临时目录，隔离面只有「一份静态目录 + 几份本地 JSON」；这种数据与运行时分离的组织方式参照纯静态 mock 的做法 [R4]，与 A–H 各轮的端口、容器、临时库分配互不相交。

## 7 未知与风险

| # | 风险 | 怎么验证这个风险是否发生 |
|---|---|---|
| 1 | **375px 下出现横向滚动**：标签行、按钮行、长 URL 或表格被固定宽度撑出视口 | 在 DevTools 切 375px 设备宽度逐页检查 `document.documentElement.scrollWidth <= 375`；对每个可滚动容器检查 `overflow-x`。若出现横向滚动，先查是否有 `white-space: nowrap`、固定像素宽度、未换行的长链接；修法是 `max-width:100%` + `overflow-wrap:anywhere` + `min-width:0`（契约见 `02-contract.md` §3 布局节） |
| 2 | **长英文串 / 长中文串溢出卡片**：fixture 里的长题干、长证据摘录、长 URL 在窄列里不换行，顶破卡片边界 | 每份 fixture 至少放 1 条超长样例（连续英文单词 / 无空格长串 / 超过 60 个汉字的段落）；逐页在 375px 下目检卡片边界。中文按 `line-break` 规则换行，英文长词按 `overflow-wrap:anywhere` 断行；测量结果记录在验收文档，不预先写死像素数值 |
| 3 | **`file://` 下 `fetch` 读本地 JSON 受限**：部分浏览器对 `file://` 页面读取本地文件施加同源限制，`fetch('../fixtures/x.json')` 可能直接抛错，导致正常态空白 | 用 `file://` 方式在 Chromium 内核浏览器与另一种内核浏览器各打开一次 `index.html`；若 `fetch` 被拦，`scripts/app.js` 切到内联兜底：页面内 `<script type="application/json" data-fixture="…">` 存放同份 fixture 副本，控制台打 `fixture-source: inline-fallback`。验证命令与判据写进 `02-contract.md` §5；真实可用的加载通道以验收时浏览器实测为准，不假设 `file://` 下 `fetch` 一定可用 |
| 4 | **三态切换被误当成真接口**：演示者看到 error/empty 面板，误以为后端已经返回过错误或空数据；或把 `?state=` 参数理解成线上功能 | 每个三态面板顶部标注「原型演示态」字样；`02-contract.md` §4 写明三态是前端演示分支，不对应任何真实方法返回。验收时检查：去掉 `state` 参数后页面只走正常态；面板上不出现「接口异常」「服务端返回」之类指向后端的措辞 |
| 5 | **fixture 字段与后续真机结构漂移**：后续 A 轮 OpenAPI 调整字段时，原型 JSON 没同步，接缝标注指向已不存在的字段 | 接缝标注里同时写方法名与字段名；E 轮契约测试覆盖冻结 §5 方法后，反向核对 fixture 键位。若发现 schema 变更，按冻结 §12 的变更规则先改契约再同步原型，不在原型里自行改字段名 |
| 6 | **排除能力入口被顺手加回来**：演示「完整原型」时补出设置入口、文件预览按钮，违反冻结 §6 | 交付前对 5 个页面与脚本做关键词检索：`reveal`、`preview`、`openDialog`、`settings`、`openFile`、`showItemInFolder`、`apiKey`；原型正文与注释里除「排除说明」外不得出现对应按钮或入口 |
| 7 | **低性能机器上骨架屏被当成真实加载**：loading 态若写死延时，演示节奏不可控；若完全无延时又看不出骨架样式 | loading 态只由渲染分支决定，不设固定 `setTimeout` 模拟网络等待；骨架样式在 `?state=loading` 下静态可见。动效按 `prefers-reduced-motion` 关闭，不做骨架闪烁以外的动画 [R3] |

## 参考

- [R1] 微信小程序设计指南 — https://developers.weixin.qq.com/miniprogram/design/ — 支撑 §1 目标 1 的 375 宽度、点击区与信息层级 — 借鉴尺寸惯例与页面结构；不引入小程序框架与构建链。
- [R2] MDN 响应式设计 — https://developer.mozilla.org/en-US/docs/Learn/CSS/CSS_layout/Responsive_Design — 支撑 §1 目标 4 与 §7 风险 1/2 的不横向滚动约束 — 采用 `max-width:100%`、`overflow-wrap`、`min-width:0`；不做多断点自适应布局。
- [R3] MDN `prefers-reduced-motion` — https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion — 支撑 §2 非目标与 §7 风险 7 的动效降级 — 采用减动效媒体查询；不做复杂动画。
- [R4] typicode/json-server — https://github.com/typicode/json-server — 支撑 §5 产物清单的数据/视图分离思路 — 借鉴「JSON 作为独立数据源」的组织；不引入需要起进程的 mock 服务。
- [R5] rough-stuff/wired-elements — https://github.com/rough-stuff/wired-elements — 支撑 §7 风险 7 对原型稿质感的参照 — 借鉴「原型优先表达结构」的取向；不引入自定义 Web Components 运行时。
- [R6] plannotator/effective-html — https://github.com/plannotator/effective-html — 支撑 §5 纯静态 HTML 原型的目录与单文件组织 — 借鉴 HTML 原型的可打开性；不照搬其代理技能脚本。
- [R7] FactoryBoy/factory_boy — https://github.com/FactoryBoy/factory_boy — 支撑 §3 真实依据末段的 fixture 对象图组织 — 借鉴「测试数据按固定结构成图」；不引入 Python 生成库，fixture 手工维护。
- [R8] JSON-RPC 2.0 规范 — https://www.jsonrpc.org/specification — 支撑 §1 目标 2 与 §2 非目标 1 的方法名/参数/结果对齐口径 — 借鉴 `method`/`params`/`result` 的命名习惯；不照搬信封、错误码与传输层。
