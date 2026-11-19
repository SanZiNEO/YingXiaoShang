# I · 小程序 UI 原型（纯 mock）· 实现方案

> 轮次：I · 小程序纯静态 mock 原型
> 文档角色：03-implementation
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1
> 写权：[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1（唯一可写路径 `tools/miniprogram-mock/**`）
> 一句话：在 `tools/miniprogram-mock/` 下用零依赖、零构建的原生 HTML/CSS/JS 做出 375px 五页原型，fixture 经内联 JSON 注入，三态由 URL 参数切换，每处真机接缝用 `data-*` 属性标注。

## 1 目录与模块

目录树与 [`01-scope.md`](01-scope.md) §5 产物清单、[`02-contract.md`](02-contract.md) §1 页面映射表逐项对齐；以下行数为开工前预估，落地后以 `Get-Content <file> | Measure-Object -Line` 的实测口径回填到验收记录，不在本文写死实测值。

```text
tools/miniprogram-mock/
  index.html                     原型入口：5 页导航总览 + 三态演示链接 + 排除能力说明区
  README.md                      原始需求基线，保持原样（本轮不改写）
  pages/
    home.html                    首页：身份概览（student.current）+ 页面入口
    news.html                    新闻列表：卡片列表（news.list）
    news-detail.html             新闻详情：正文 + 知识点匹配 + 思政匹配（news.get）
    ask.html                     问答：历史作答记录与对错（questions.attempts，只读）
    profile.html                 我的：目标约束 + 能力维度 + 证据账本（profile.get）
  styles/
    app.css                      唯一样式表：375 容器、卡片、标签、按钮、三态、换行规则
  scripts/
    app.js                       唯一脚本：fixture 加载、state 解析、三态渲染分发、导航拼接
  fixtures/
    student.json                 student.current 结果：{ studentId, name, cohort }
    news-list.json               news.list 结果：NewsArticle[]
    news-detail.json             news.get 结果：{ article, matches, ideology }
    attempts.json                questions.attempts 结果：QuestionAttempt[]
    profile.json                 profile.get 结果：ProfileData
```

| 文件 | 职责（一句话） | 行数预估 | 现状依据 |
|---|---|---|---|
| `index.html` | 导航枢纽：列出 5 页入口、每页三态演示链接、§6 排除能力说明区；不绑定任何业务数据 | 110 | 入口组织参照纯静态 HTML 原型的单文件可打开结构 [R5] |
| `pages/home.html` | 身份卡片 + 导航入口列表 + 四个三态占位节点；数据来自 `student.json` | 100 | 身份字段对齐 `apps/desktop/src/main/index.ts:209-212` |
| `pages/news.html` | 页头条数 + 新闻卡片行列表 + 空态区块 + 骨架占位；数据来自 `news-list.json` | 130 | 卡片行对齐 `apps/desktop/src/renderer/src/pages.tsx:283`、`:289` |
| `pages/news-detail.html` | 返回行 + 标签行 + 原文链接行 + 正文段 + 知识点匹配区 + 思政匹配区；数据来自 `news-detail.json` | 170 | 区块结构对齐 `apps/desktop/src/renderer/src/pages.tsx:299`、`:303`、`:313` |
| `pages/ask.html` | 对错标签 + 题干行 + 时间 + 可展开答案/反馈区；数据来自 `attempts.json` | 140 | 对错判据对齐 `apps/desktop/src/renderer/src/renderers.tsx:142`，展开三段对齐 `renderers.tsx:210-212` |
| `pages/profile.html` | 页头 + 目标约束区 + 能力维度网格 + 证据账本；数据来自 `profile.json` | 190 | 两块数据来源对齐 `apps/desktop/src/renderer/src/App.tsx:320-321`，空态对齐 `App.tsx:363`、`:386` |
| `styles/app.css` | 全局 reset、375 容器、卡片/标签/按钮/空错载三态样式、换行与点击区约束、减动效降级 | 280 | 换行约束参照响应式布局基线 [R2] |
| `scripts/app.js` | 页面配置表、fixture loader（双通道）、state 解析、按分支渲染、导航链接拼接、兜底分支 | 310 | 方法名只出现在配置表与标注属性里 [R9] |
| `fixtures/student.json` | 3 字段对象样例 | 15 | schema 对齐 `apps/desktop/src/main/index.ts:209-212` |
| `fixtures/news-list.json` | ≥3 条文章（含 1 条 `partial`、1 条超长标题样例） | 95 | schema 对齐 `packages/shared/src/index.ts:124-136` |
| `fixtures/news-detail.json` | 单篇 `{ article, matches, ideology }`，匹配与思政各 ≥1 条 | 120 | 结构对齐 `apps/desktop/src/renderer/src/model.ts:95-99` |
| `fixtures/attempts.json` | ≥2 条记录（1 条答对、1 条答错） | 65 | schema 对齐 `packages/shared/src/index.ts:260-268` |
| `fixtures/profile.json` | `profile/competencies/plan/evidence/growth` 五段，证据 ≥1 条 | 150 | 形状对齐 `apps/desktop/src/renderer/src/model.ts:73-79`，能力项对齐 `model.ts:62-71` |

模块边界硬约束：HTML 只写骨架与占位节点，不拼业务数据字符串；CSS 不内联到页面 `<style>`；JS 不出现第二个页面配置表；fixture 不引用其他 JSON 文件做拼接。数据与视图分文件组织，参照 mock 数据「JSON 独立成源」的做法 [R4]，但不引入需要起进程的 mock 服务。

## 2 依赖与构建

### 2.1 零依赖、零构建

- **运行时依赖：无。** 目录内不出现 `package.json`、`node_modules`、`dist`、锁文件；不执行 `npm install` / `pnpm install`；不引第三方 CSS、JS、字体、图标库。
- **构建步骤：无。** 不写打包脚本、不做转译、不生成产物；HTML/CSS/JS/JSON 就是最终产物。
- **打开方式：** 直接双击 `tools/miniprogram-mock/index.html`，浏览器以 `file://` 打开；也可以挂在任意静态文件服务器上用 `http://` 访问，两种方式走同一套文件，不区分构建产物。
- **脚本形态：** `scripts/app.js` 是经典 `<script>`（非 `type="module"`）。`file://` 下 ES Module 会被 CORS 拦截，原型不依赖模块加载；语法限于 ES2017 及以下，不用顶层 `await` [R5]。

### 2.2 为什么不用框架

| 候选 | 不采用的理由 |
|---|---|
| Vue / React / 小程序框架 | 框架需要包管理器安装依赖、打包链与开发服务器，产物是构建后的 `dist`；原型目标是「双击 `file://` 可开、断网可看」，引入框架会把开工条件绑到 Node 工具链上。页面只有五段 DOM 拼接，原生 JS 的模板字符串与 `createElement` 足够，框架的状态管理与组件体系在原型阶段没有载荷 [R7] |
| 组件库 / CSS 框架（如 Bootstrap 式栅格） | 组件库会带入整套样式 reset 与响应式断点；原型只需要 375px 单列一套约束，引入框架反而要覆盖其默认宽度与栅格。栅格分栏思路可参照成熟框架的容器约束 [R7]，但不复制其运行时 |
| 线框 Web Components（如手绘稿元素库） | 原型取向是「结构与字段先对齐」，不追求手绘质感；自定义元素运行时会增加 `file://` 下的加载不确定性 [R6] |
| 需要起进程的 mock 服务（json-server 一类） | 这类方案要求验收者先启动一个本地服务，与「断网可用、零进程」的 DoD 冲突；只借鉴其「JSON 作为独立数据源」的组织方式 [R4] |

### 2.3 目录内禁止出现的东西

`package.json` / `pnpm-lock.yaml` / `node_modules/` / `dist/` / 外网 CDN 链接 / 字体文件 / 位图素材 / `type="module"` 的脚本 / 任何 `http://`、`https://` 形式的资源地址。原型本版无位图；`styles/app.css` 预留 `img { max-width: 100%; height: auto; }` 规则即可。

## 3 关键实现

### 3.1 五页 DOM 骨架

每页 HTML 统一四段结构：页头区、内容区（按态填充）、三态占位节点、底部导航（新闻详情页除外）。骨架里只放静态文案与空占位，业务文本由脚本按 fixture 填充。

**首页 `pages/home.html`**（依据 `apps/desktop/src/main/index.ts:209-212`）：

```html
<body data-fixture="student.json">
  <header class="page-header">
    <div class="identity" data-mock-source="student.current" data-replace="data-field">
      <div class="identity-name" data-slot="name"></div>
      <div class="identity-sub"  data-slot="sub"></div>
    </div>
  </header>
  <nav class="entry-list" aria-label="页面导航">
    <a class="entry-row" href="news.html">新闻</a>
    <a class="entry-row" href="ask.html">问答</a>
    <a class="entry-row" href="profile.html">我的</a>
  </nav>
  <div data-state="loading" hidden></div>
  <div data-state="error"  hidden></div>
  <div data-state="empty"  hidden></div>
  <footer class="tabbar"><!-- 首页 / 新闻 / 问答 / 我的 四项 --></footer>
</body>
```

**新闻列表 `pages/news.html`**（依据 `apps/desktop/src/renderer/src/pages.tsx:283`、`:289`）：

```html
<body data-fixture="news-list.json">
  <header class="page-header"><h1 class="page-title" data-slot="count">新闻</h1></header>
  <section class="card-list" data-mock-source="news.list" data-replace="data-field">
    <!-- 脚本按 fixture 逐条插入 <article class="row"> -->
  </section>
  <div data-state="loading" hidden></div>
  <div data-state="error"  hidden></div>
  <div data-state="empty"  hidden></div>
  <footer class="tabbar"></footer>
</body>
```

卡片行骨架：首行 `title`，次行 `source · published_at`（日期截前 10 位），整行 `href="news-detail.html?articleId=<id>"`；无 `id` 的行置灰不可点。

**新闻详情 `pages/news-detail.html`**（依据 `pages.tsx:299`、`:303`、`:313`）：

```html
<body data-fixture="news-detail.json">
  <a class="back-link" href="news.html">← 返回新闻列表</a>
  <section class="detail" data-mock-source="news.get" data-replace="data-field">
    <div class="tag-row" data-slot="tags"></div>
    <div class="origin-link" data-slot="url"></div>
    <article class="content" data-slot="content"></article>
    <section class="match-block">
      <h2>知识点匹配</h2>
      <div class="match-list" data-slot="matches"></div>
    </section>
    <section class="ideology-block">
      <h2>思政匹配</h2>
      <div class="ideology-list" data-slot="ideology"></div>
    </section>
  </section>
  <div data-state="loading" hidden></div>
  <div data-state="error"  hidden></div>
  <div data-state="empty"  hidden></div>
</body>
```

详情页无底部 tab，只保留返回新闻列表链接；未带 `articleId` 或 fixture 无对应文章时，内容区渲染「选择一条新闻查看原文与匹配证据」。

**问答 `pages/ask.html`**（依据 `apps/desktop/src/renderer/src/renderers.tsx:142`、`:210-212`）：

```html
<body data-fixture="attempts.json">
  <header class="page-header"><h1 class="page-title">问答记录</h1></header>
  <section class="record-list" data-mock-source="questions.attempts" data-replace="data-field">
    <!-- 每行：对错标签 + question_id + 日期；展开区：你的答案 + 反馈 message -->
  </section>
  <div data-state="loading" hidden></div>
  <div data-state="error"  hidden></div>
  <div data-state="empty"  hidden></div>
  <footer class="tabbar"></footer>
</body>
```

`score >= 0.99` 打「答对」标签，否则「答错」；`score` 缺失不打标签。本页不提供提交答案、交卷按钮。

**我的 `pages/profile.html`**（依据 `apps/desktop/src/renderer/src/App.tsx:320-321`、`:335-339`、`:363`、`:386`）：

```html
<body data-fixture="profile.json">
  <header class="page-header">
    <div class="identity" data-slot="profile"></div>
  </header>
  <section class="goal-block" data-mock-source="profile.get" data-replace="data-field">
    <h2>目标与约束</h2><div data-slot="goals"></div>
  </section>
  <section class="growth-block" data-slot="growth"></section>
  <section class="evidence-block" data-slot="evidence"></section>
  <div data-state="loading" hidden></div>
  <div data-state="error"  hidden></div>
  <div data-state="empty"  hidden></div>
  <footer class="tabbar"></footer>
</body>
```

### 3.2 数据注入方案（`file://` 避开 `fetch`）

**问题口径：** `file://` 页面下，浏览器把本地文件来源按不透明同源处理，`fetch('../fixtures/x.json')` 在 Chromium 内核会直接抛 `TypeError: Failed to fetch`，部分浏览器还会拦 `XMLHttpRequest` 读本地文件；因此原型不能把「页面能渲染」建立在 `fetch` 读本地 JSON 之上 [R5]。

**选定方案：内联 `<script type="application/json">` 为必选通道。** 每份 fixture 在对应页面里放一段同内容的内联副本：

```html
<script type="application/json" data-fixture="student.json">
{ "studentId": "20230001", "name": "张三", "cohort": "2023" }
</script>
```

加载流程（与 [`02-contract.md`](02-contract.md) §5.3 对齐）：

```text
loadFixture(name):
  1. 先尝试 fetch('../fixtures/<name>.json')
     - 成功且 JSON 可解析 → 使用返回对象，控制台标记 fixture-source: fetch
  2. fetch 抛错（file:// 同源拦截 / 网络不可达）→ 读取页面内
     <script type="application/json" data-fixture="<name>"> 内联副本，JSON.parse
     → 标记 fixture-source: inline-fallback
  3. 内联副本也缺失或解析失败 → 进入 §6 错误分支，不抛未捕获异常
```

落地硬规则：

- **内联副本是 `file://` 验收的实际通道**：即使第 1 步在 `file://` 下必然被拦，页面也必须靠第 2 步渲染；不允许出现「只写了 JSON 文件、页面里没有内联副本」的情况。
- **JSON 文件是唯一编辑源**：改数据先改 `fixtures/*.json`，再把同份内容同步进页面内联块；两处必须逐字一致。真机阶段把 loader 换成 HTTP 调用后，内联块即可移除。
- **不选 `.js` 全局变量方案**：备选是 `fixtures/student.js` 挂 `window.__FIXTURES__`，但那样会多出一套脚本命名空间与加载顺序依赖，且与「JSON 是唯一编辑源」冲突；内联 JSON 直接由 `JSON.parse` 得到纯数据对象，不进入全局作用域。
- **不发任何联网请求**：脚本里不出现 `fetch('http…')`、`XMLHttpRequest`、`WebSocket`、`EventSource`；`<img>`、`<link>`、`<script src>` 不引外网资源。

### 3.3 三态切换实现

- **参数约定：** URL query `state=loading|error|empty`；缺省或取值不在枚举内（含大小写不一致、乱码）一律按 `normal` 处理，不报错。另一个参数 `articleId` 只在详情页读取。
- **DOM 约定：** 页面根节点 `data-state="<当前态>"`；四个分支容器带 `data-state="loading|error|empty|normal"` 属性，脚本按当前态互斥显隐，一次只出现一个分支，不叠加。
- **渲染分发（`scripts/app.js` 伪代码）：**

```js
var PAGES = {
  'home.html':        { fixture: 'student.json',     method: 'student.current',  render: renderHome },
  'news.html':        { fixture: 'news-list.json',    method: 'news.list',       render: renderNews },
  'news-detail.html': { fixture: 'news-detail.json', method: 'news.get',        render: renderDetail },
  'ask.html':         { fixture: 'attempts.json',    method: 'questions.attempts', render: renderAsk },
  'profile.html':     { fixture: 'profile.json',     method: 'profile.get',     render: renderProfile }
};

function boot() {
  var cfg = matchPage(location.pathname, PAGES);
  var state = parseState(new URLSearchParams(location.search).get('state'));
  if (state === 'loading') { showBranch('loading'); return; }
  var data = loadFixture(cfg.fixture);            // §3.2
  if (data == null) { showBranch('error'); return; }
  if (state === 'error') { showBranch('error'); return; }
  if (state === 'empty' || isEmpty(cfg, data)) { showBranch('empty'); return; }
  cfg.render(data);
  showBranch('normal');
}
```

- **loading 态**：骨架占位条按页面区块静态呈现（页头 1 条、列表行 3 条、卡片段 2 条），不复制 fixture 文本；不设 `setTimeout` 模拟等待，骨架样式由分支决定。
- **error 态**：整页错误面板，文案见 §6.1；「重试」按钮拼出去掉 `state` 参数的当前地址，原型内不发请求、不延时。
- **empty 态**：用空集合走正常渲染函数，由各区块的空值兜底规则输出空态文案；既是 `?state=empty` 的整页演示，也覆盖正常态数据本身为空的情况。

### 3.4 375px 布局的 CSS 约束

宽度与换行规则集中写在 `styles/app.css`，页面不内联固定像素宽度；约束口径参照响应式设计的容器与换行基线 [R2]，触控尺寸对齐小程序设计指南 [R1]：

| 约束 | 写法 | 作用 |
|---|---|---|
| 盒模型 | `*, *::before, *::after { box-sizing: border-box; }` | 内边距与边框不计入内容宽度，避免卡片被 `padding` 顶破 |
| 视口容器 | `.app { max-width: 375px; margin: 0 auto; }`，`<meta name="viewport" content="width=device-width, initial-scale=1">` | 原型按 375 单列；页面背景铺满，内容不超出 375 |
| 文本容器 | 所有文本块 `max-width: 100%`；长英文串 / 长 URL `overflow-wrap: anywhere`；`word-break` 不用于中文段落 | 长词与链接在窄列内断行，不溢出卡片 |
| 弹性子项 | flex / grid 直接子项 `min-width: 0` | 防止长文本把 flex 行撑出视口 |
| 点击区 | 按钮、可点行、标签链接 `min-height: 44px; min-width: 44px`；纯文字链接用 `padding` 撑出点击区 | 触控目标达标 [R1] |
| 媒体 | `img { max-width: 100%; height: auto; }` | 预留后续补图不撑破卡片 |
| 横向滚动 | 根节点不设 `overflow-x: auto`；卡片内部不做横向滚动条；不靠 `overflow-x: hidden` 掩盖溢出 | 无横向滚动判据以 `scrollWidth` 实测为准 [R2] |
| 动效 | 过渡 ≤200ms；`@media (prefers-reduced-motion: reduce)` 下关闭过渡与骨架动画 | 减动效降级 [R3] |

### 3.5 长串溢出处理

| 串类型 | 风险 | 处理 |
|---|---|---|
| 长英文单词 / 无空格标识符 | 撑破卡片右侧 | `overflow-wrap: anywhere` 在词内断行；代码样式区同样受此规则约束 |
| 长 URL | 一行不可断，顶破视口 | 链接行 `overflow-wrap: anywhere`；原型阶段外链仅文本展示，不在点击时跳转 |
| 长中文段落 | 汉字间可断，但卡片宽度被标签行挤压 | 段落容器 `min-width: 0`，标签行 `flex-wrap: wrap`；中文按 `line-break` 规则换行 |
| 长题干 / 长证据摘录 | 多行后高度不可控 | 纵向允许 `overflow-y: auto`，横向不允许；不设 `white-space: nowrap` |
| 表格 | 窄列下必然横向溢出 | 原型本版不使用表格；证据与记录全部用卡片行布局 |

每份 fixture 至少放 1 条超长样例（连续长英文词 / 无空格长串 / 超过 60 个汉字的段落），用于 §3.4 规则的复验。

### 3.6 导航与返回

- 全部导航由相对路径 `<a>` 链接承担，不引路由库、不做历史栈管理；浏览器后退键按原生行为工作。
- 链接关系与 [`02-contract.md`](02-contract.md) §5.2 一致：`index.html` → 五页；`news.html` → `news-detail.html?articleId=<id>`；详情页 → `news.html`；各内页 → `../index.html`；内页底部导航含 首页 / 新闻 / 问答 / 我的 四项，详情页无底部导航。
- 回根目录用 `../`；页面内链接不写绝对路径、不写 `file:///` 前缀，保证目录整体移动后链接不断。
- 「重试」「返回首页」等动作按钮只做页面内跳转或态切换，不触发任何写回。

### 3.7 替换点标注

标注以 `data-*` 属性为主（格式见 [`02-contract.md`](02-contract.md) §2.6），不依赖 HTML 注释：

| 属性 | 取值示例 | 出现位置 |
|---|---|---|
| `data-mock-source` | `news.list` | 每个读数据的组件块 |
| `data-fixture` | `news-list.json` | 页面根节点 |
| `data-replace` | `transport` / `navigation` / `data-field` | 具体接缝元素 |
| `data-excluded` | `true` | `index.html` 排除说明区 |

方法名、字段名沿用冻结 §5 的点分命名，不自造 camelCase 别名 [R9]。注释只在需要一句 prose 说明时补充，不作为标注唯一载体。

## 4 数据读写

| 方向 | 口径 |
|---|---|
| 读 | 只读同目录 `fixtures/*.json`（经 §3.2 双通道）；不读本机 `learning.db`、不读 `.learning-agent` 或 `%APPDATA%` 数据目录、不读其他页面的内联块 |
| 写 | **零写操作**：不调用 `/api/v1/answer`、`/api/v1/answer-set`，不做出题、交卷、复核、记快照；页面上的按钮只做跳转或态切换 |
| 存储 | 不使用 `localStorage` / `sessionStorage` / Cookie / IndexedDB；刷新后状态只由 URL 参数决定 |
| 网络 | 不发任何 `http(s)` 请求；不连 `127.0.0.1:8080`，不引用服务端 OpenAPI；fixture 是手工编写的自包含数据 |
| 字段兼容 | 渲染只取 [`02-contract.md`](02-contract.md) §3 列出的字段；fixture 多出的未知字段忽略不报错；必需字段缺失按 §6.2 兜底，不把 `undefined` / `null` 渲染到界面 | 字段命名沿用冻结 §5 的点分口径，不自造别名 [R9] |

fixture 与 schema 同构：新闻字段对齐 `packages/shared/src/index.ts:124-136`，作答记录对齐 `packages/shared/src/index.ts:260-268`，档案对齐 `packages/shared/src/index.ts:333-343`，证据对齐 `packages/shared/src/index.ts:346-375`，能力字典对齐 `packages/shared/src/index.ts:324-331`。真机阶段换数据源时，只替换 loader 与信封解包，页面字段名与渲染函数不改。

## 5 配置约定

- **环境变量：无。** 原型不读任何 `YXS_*` / `LEARNING_AGENT_HOME` 类环境变量；不区分开发与生产模式。
- **视图宽度：** 375px 写死在 `styles/app.css` 的容器规则里，不由 URL 参数或配置文件调整；验收视口按 375px 设备宽度检查，宽度层级对齐小程序设计指南的单列惯例 [R1]。
- **URL 参数约定：**

| 参数 | 取值 | 作用页面 | 默认 |
|---|---|---|---|
| `state` | `loading` / `error` / `empty`，其他值回退 `normal` | 全部五页 | `normal` |
| `articleId` | 文章 `id` 字符串 | 仅 `news-detail.html` | 缺省时显示未选中占位 |

- **页面配置表：** `scripts/app.js` 内的 `PAGES` 是唯一页面-方法-fixture 映射；新增页面只改这张表，不在各渲染函数里散落路径字符串。
- **文案配置：** 三态与空态中文文案逐字写在 [`02-contract.md`](02-contract.md) §4，页面与脚本不另造同义句子；枚举值（如 `review_status`）在标签上转中文展示。

## 6 失败处理

### 6.1 加载失败 → 整页 error 面板

失败分支的定位是「静态原型在任何加载异常下都给一句可见中文」，不依赖运行时框架的错误边界机制 [R5]。

| 失败路径 | 用户看到的中文 | 行为 |
|---|---|---|
| fixture 文件与内联副本都缺失 | 标题「暂时没拿到这条数据。」；说明「原型演示错误态：当前没有连接真实服务端，以下内容是占位。」 | 整页 error 面板；主按钮「重试」链接到去掉 `state` 的当前地址；次按钮「返回首页」链接到 `../index.html` |
| 内联 JSON 解析失败 | 同上 error 面板 | 控制台记录解析失败的 fixture 名；不抛未捕获异常到窗口 |
| `fetch` 抛错且内联副本存在 | 正常态（命中兜底通道） | 控制台标记 `fixture-source: inline-fallback` |
| 脚本文件自身加载失败 | 页面 `<body>` 首行的静态兜底节点保留可见：「页面脚本未能加载，请对照 fixtures 查看数据结构。」 | 该节点是纯 HTML 静态文案，不依赖 JS；脚本成功启动后移除 |

错误面板不展示堆栈、不展示英文方法名、不展示 `error.code`；方法名只出现在 `data-mock-source` 属性里。error 态是前端演示分支，文案不出现「服务端异常」「接口返回」这类指向后端的措辞。

### 6.2 字段缺失兜底

| 场景 | 兜底规则 |
|---|---|
| `student.name` 缺失或空串 | 显示「学生」（对齐 `apps/desktop/src/main/index.ts:211` 兜底口径） |
| `student.cohort` 为空串 | 副行只显示 `studentId` |
| 新闻 `title` 缺失 | 卡片首行显示「无标题新闻」 |
| 新闻 `published_at` 缺失 | 次行只显示 `source` |
| 新闻 `url` 为空 | 原文链接行整行不渲染 |
| 详情 `matches` 为空 | 知识点区显示「尚未匹配」 |
| 详情 `ideology` 为空 | 思政区整区不渲染 |
| 作答 `score` 缺失 | 不打对错标签 |
| 作答 `answer` 缺失 | 展开区显示「未作答」 |
| `feedback_json` 无 `message` 文本 | 反馈区不展开 |
| 证据回查不到能力名 | 标签显示「能力维度」（对齐 `apps/desktop/src/renderer/src/App.tsx:389`） |
| 数组为 `[]` / 整对象为 `null` | 走对应区块空态，文案见 [`02-contract.md`](02-contract.md) §4.2 |

### 6.3 非法参数与异常输入

- `state` 取值非法 → 按 `normal` 渲染，不在界面报错。
- `articleId` 找不到对应文章 → 详情页显示未选中占位文案，不跳 404、不抛错。
- 渲染函数对 `null` / `undefined` 入参先做空判断再取字段；模板字符串里不直接拼接可能为 `undefined` 的值。

## 7 性能与资源

- **资源构成：** 纯静态 HTML/CSS/JS + 内联 JSON；无位图、无字体、无第三方脚本；目录总体积预估 < 200 KB（待实测，测量方法见下）。
- **网络：** 首屏不发任何请求，加载耗时只受本地磁盘读取与解析影响；断网与联网表现一致。
- **首屏耗时：待实测。** 测量方法：在 375px 设备宽度下用浏览器 DevTools Performance 面板记录单次打开，或在 `app.js` 启动处用 `performance.now()` 取 `boot()` 前后差值；连续打开 5 次取中位数，记录到 `.scratch/run/I/checks/perf.txt`。不在本文预设毫秒数值。
- **体积：待实测。** 测量方法：`Get-ChildItem -Recurse tools\miniprogram-mock | Measure-Object Length -Sum`，记录总字节数到同目录检查输出。
- **运行时开销：** 渲染为一次性 DOM 拼接，无轮询、无定时刷新、无监听外部事件；骨架屏不写闪烁以外的动画，动效按 `prefers-reduced-motion` 关闭 [R3]。
- **内存：** 五页各自独立加载，页面间不共享运行时状态；不做单页应用的常驻内存保留。

## 8 实施顺序

每步可中断；做完一步有对应的可验证结果，不把验证堆到最后。

1. **建目录与 fixture。** 建 `tools/miniprogram-mock/` 下 `pages/`、`styles/`、`scripts/`、`fixtures/` 四个子目录；按 §1 表与 [`02-contract.md`](02-contract.md) §3 写五份 JSON。验证：五份 JSON 均能被 `JSON.parse` 解析；字段名与 schema 表逐项对得上。
2. **写全局样式表。** 先落 `styles/app.css` 的 reset、375 容器、换行与点击区约束、三态样式骨架、减动效媒体查询。验证：临时 HTML 探针里放一条长英文词与一段长中文，375px 下不出现横向滚动。
3. **写导航枢纽 `index.html`。** 五页入口链接、三态演示链接、排除能力说明区（`data-excluded="true"`）。验证：链接路径与 §3.6 表一致；说明区不含可点击的功能入口。
4. **写首页与 loader。** 落 `pages/home.html` 骨架与 `app.js` 的配置表、`loadFixture` 双通道、`boot()` 分发。验证：`file://` 打开首页渲染身份卡片；控制台出现 `fixture-source: inline-fallback` 或 `fetch` 标记。
5. **写新闻两页。** `news.html` 卡片列表与跳转参数；`news-detail.html` 三区块渲染与未选中占位。验证：列表行带 `articleId` 跳转；详情返回链接回到列表；匹配与思政空数组走空态。
6. **写问答与我的两页。** `ask.html` 记录行与展开区；`profile.html` 目标约束、能力网格、证据账本与回查兜底。验证：答对/答错标签判据与 `renderers.tsx:142` 一致；证据能力名回查不到时显示「能力维度」。
7. **接三态分支与接缝标注。** 补 `loading`/`error`/`empty` 三个分支容器、静态兜底节点、全部 `data-mock-source` / `data-fixture` / `data-replace` 属性。验证：每页四个态互斥显隐；非法 `state` 回正常态；`querySelectorAll('[data-mock-source]')` 逐页清点非空。
8. **逐条自检与落证据。** 按 [`04-acceptance.md`](04-acceptance.md) §3 的 AC-I-01..14 逐条复跑；断网复验五页；把截图与检查输出落到 `.scratch/run/I/`。验证：14 条 AC 全绿；`git status --porcelain` 除 `tools/miniprogram-mock/` 与 `.scratch/` 外无改动。

纯静态原型的目录组织与单文件可打开性参照有效 HTML 原型实践 [R5]；线框阶段「结构先于视觉」的取向参照手绘稿原型项目，但不引入其运行时元素 [R6]。

## 参考

- [R1] 微信小程序设计指南 — https://developers.weixin.qq.com/miniprogram/design/ — 支撑 §3.4 点击区 44px 与 375 宽度惯例 — 借鉴尺寸与触控建议；不引入小程序框架与构建链。
- [R2] MDN 响应式设计 — https://developer.mozilla.org/en-US/docs/Learn/CSS/CSS_layout/Responsive_Design — 支撑 §1 样式职责与 §3.4/§3.5 换行、`min-width:0` 约束 — 采用 `max-width:100%` 与 `overflow-wrap`；不做多断点自适应布局。
- [R3] MDN `prefers-reduced-motion` — https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion — 支撑 §3.4 动效降级与 §7 动画口径 — 采用减动效媒体查询；不做复杂动画。
- [R4] typicode/json-server — https://github.com/typicode/json-server — 支撑 §1 数据/视图分离与 §2.2 不引入进程式 mock 服务 — 借鉴 JSON 独立成文件；不引入需要起服务的 REST mock。
- [R5] plannotator/effective-html — https://github.com/plannotator/effective-html — 支撑 §2.1 经典脚本形态与 §3.2 `file://` 可打开性 — 借鉴本地相对路径组织；不照搬其代理技能脚本。
- [R6] rough-stuff/wired-elements — https://github.com/rough-stuff/wired-elements — 支撑 §2.2 不引入线框 Web Components — 借鉴原型结构取向；不引入自定义元素运行时。
- [R7] twbs/bootstrap — https://github.com/twbs/bootstrap — 支撑 §2.2 容器与栅格思路参照 — 借鉴容器约束思路；不复制其 CSS 框架运行时。
- [R8] evolus/pencil — https://github.com/evolus/pencil — 支撑 §8 实施顺序中「先结构后视觉」的原型推进方式 — 借鉴 GUI 原型分段验证；不引入绘图工具链。
- [R9] JSON-RPC 2.0 规范 — https://www.jsonrpc.org/specification — 支撑 §3.7 方法名点分命名与 §4 信封解包预留 — 借鉴 `method`/`result` 命名；不照搬 batch 与错误码体系。
