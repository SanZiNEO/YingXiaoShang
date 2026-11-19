# I · 小程序 UI 原型（纯 mock）· 验收

> 轮次：I · 小程序纯静态 mock 原型
> 文档角色：04-acceptance
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1
> 写权：[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1
> 一句话：14 条 AC 全部可命令或可观察复现；任何一条只能靠「看着差不多」判过的，都不算过。

## 1 验收口径

**过 = 下列三组同时成立**：

1. **硬指标**：5 页从 `index.html` 全部可达且可往返；375px 视口逐页 `document.documentElement.scrollWidth <= 375`；loading / error / empty 三态均可复现；断网刷新五页正常态可渲染，且代码与 Network 面板零网络请求；长英文串、长 URL、长中文串不溢出；5 个冻结排除能力无入口；展示数据全部来自 fixtures；接缝标注逐页可见；`file://` 直接打开可用。
2. **反向验证**：§5 的 5 个改坏样例各自让指定 AC 变红，改回后变绿。
3. **证据**：每条 AC 在 `.scratch/run/I/` 留下截图或命令输出原文，复跑命令写在 §4。

不可替代项（不能用「手工点了一遍」代替）：零网络请求的静态检索、`scrollWidth` 数值、排除能力关键词检索、fixture 改值后页面跟随变化。断言写成可执行检查或可观察的固定结果，避免「看起来正常」这类不可判定描述 [R5]。

契约追溯：每条 AC 追到 [`02-contract.md`](02-contract.md) 的具体节与冻结契约 §5/§6；下表「契约点」列给出对应位置。

## 2 前置条件

```powershell
cd E:\Documents\GitHub\YingXiaoShang

# 1) 确认产物目录已生成（实现阶段产出；验收前不得在目录外补数据）
Test-Path tools\miniprogram-mock\index.html
Test-Path tools\miniprogram-mock\pages\home.html
Test-Path tools\miniprogram-mock\pages\news.html
Test-Path tools\miniprogram-mock\pages\news-detail.html
Test-Path tools\miniprogram-mock\pages\ask.html
Test-Path tools\miniprogram-mock\pages\profile.html

# 2) 准备证据目录（只读扫描产物，不写真实数据目录）
New-Item -ItemType Directory -Force .scratch\run\I\screenshots, .scratch\run\I\checks | Out-Null
```

环境与工具口径：

- **不需要起服务、不需要装依赖、不需要 Node 包管理**：原型是纯静态文件，验收用浏览器直接打开；不执行 `npm install` / `pnpm install`。
- **浏览器**：至少一种 Chromium 内核浏览器（Edge / Chrome）打开 `file://` 路径；另一种内核浏览器为可选加跑，用于复现 `file://` 兜底差异。
- **断网方式**：DevTools Network 面板选 `Offline` 节流，或关闭本机 Wi-Fi / 拔网线；断网后刷新页面复验。
- **缺什么就明说**：没有第二种内核浏览器时，跨内核 AC 标 `skipped`，只记录 Chromium 内核结果；不得用联网状态下的表现代替断网复验。
- **不触碰**：不读本机 `learning.db`、不读 `.learning-agent` / `%APPDATA%` 目录；验收过程不向任何 `127.0.0.1:8080` 地址发请求。

fixture 是手工编写的自包含样例，验收不依赖服务端或数据库副本；数据与视图分离的组织方式参照静态 mock 实践 [R4]。

## 3 用例清单

| 编号 | 操作步骤 | 期望输出 | 失败判据 | 契约点 | 证据文件 |
|---|---|---|---|---|---|
| AC-I-01 | 双击 `tools/miniprogram-mock/index.html`（`file://`），逐一点击 5 个入口链接：首页、新闻、新闻详情、问答、我的 | 五个页面全部打开，无 404、无死链；地址栏路径分别为 `pages/home.html`、`pages/news.html`、`pages/news-detail.html`、`pages/ask.html`、`pages/profile.html` | 任一链接落空路径、跳错文件、浏览器报文件找不到 | 02 §5.2 导航表；冻结 §1 方法面 | `screenshots\index-home.png` 等 5 张 |
| AC-I-02 | 从新闻列表进入新闻详情，点「← 返回新闻列表」；再用各内页底部导航在 首页/新闻/问答/我的 之间往返；用浏览器后退键返回上一页 | 列表 → 详情 → 列表往返可达；底部导航四项互相可达；原生后退按历史顺序回退；链接全部为相对路径 | 详情页无返回入口；底部导航缺项；链接写绝对路径或 `file:///` 前缀 | 02 §5.2 | `screenshots\news-detail-back.png` |
| AC-I-03 | DevTools 设备宽度设 375px，逐页在 Console 执行 `document.documentElement.scrollWidth` 与 `document.documentElement.clientWidth` | 五页 `scrollWidth <= 375`；无横向滚动条；纵向允许滚动 | 任一页 `scrollWidth > 375`；出现横向滚动条 | 02 §3.6 无横向滚动 | `checks\scroll-width.txt` |
| AC-I-04 | 逐页查看 fixture 中超长样例：长英文词串 / 长 URL / 超过 60 个汉字的段落；卡片边界与视口右侧不被顶破 | 长串在容器内换行；卡片左右边界完整；`scrollWidth` 不因此变大 | 出现溢出、文字裁切、横向滚动；长词一行撑出视口 | 02 §3.6 文本换行；02 §3.2 超长样例 | `screenshots\long-string-*.png` |
| AC-I-05 | 逐页访问 `pages/<page>.html?state=loading` | 骨架占位条按区块可见；辅助文本为「加载中（原型演示态）」；不出现「正在连接服务器」「请求接口中」措辞；无固定延时动画 | 骨架缺失；两态叠加；出现指向后端连接的措辞；骨架复制了 fixture 真实文本 | 02 §4.3 加载态 | `screenshots\*-loading.png` |
| AC-I-06 | 逐页访问 `pages/<page>.html?state=error` | 整页错误面板：标题「暂时没拿到这条数据。」；说明「原型演示错误态：当前没有连接真实服务端，以下内容是占位。」；主按钮「重试」回到去掉 `state` 的当前页；次按钮「返回首页」到 `../index.html`；面板无堆栈、无英文方法名、无 `error.code` | 文案与契约不一致（含标点）；按钮落空；出现堆栈或英文码；错误只挂在角落提示位 | 02 §4.1 错误态 | `screenshots\*-error.png` |
| AC-I-07 | 逐页访问 `pages/<page>.html?state=empty`；逐字比对 02 §4.2 空态文案 | 首页「暂无学生信息。」；新闻「暂无新闻，Python 采集服务会在后台自动入库」；详情未选中「选择一条新闻查看原文与匹配证据」；详情匹配区「尚未匹配」；问答「还没有作答记录，去完成一道题后再来看。」；我的目标约束「还没有记录目标与约束。」；能力维度「还没有形成能力快照。」；证据账本「还没有学生能力证据。」 | 任一文案被改写、漏字、换成英文；空态只留干巴巴单句无返回动作 | 02 §4.2 空态；现状依据 `pages.tsx:283`、`:299`、`:313`、`App.tsx:363`、`:386` | `screenshots\*-empty.png` |
| AC-I-08 | DevTools Network 切 `Offline`（或关闭 Wi-Fi），刷新五页正常态（不带 `state` 参数） | 五页正常态数据均可渲染；身份、列表、详情、记录、证据各区块不空屏 | 断网后任一空白、报错、骨架常驻 | 01 §1 目标 2；02 §5.1 规则 4 | `checks\offline-render.txt` |
| AC-I-09 | 静态检索产物目录；并在联网与断网两种状态下观察 Network 面板 | 代码与页面中无 `fetch(`、`XMLHttpRequest`、`WebSocket`、`EventSource`、外网 `http://` / `https://` 资源引用；Network 面板无任何 `http(s)` 请求条目 | 检索命中任一联网形态；面板出现请求条目（含静态资源外链） | 02 §5.1 规则 4；02 §6.3 | `checks\network-audit.txt` |
| AC-I-10 | 对 `index.html`、`pages/`、`scripts/` 做关键词检索：`reveal`、`preview`、`openDialog`、`settings`、`apiKey`、`openFile`、`showItemInFolder` | 除 `index.html` 排除说明区（`data-excluded="true"`）与标注属性外，无可点击入口、按钮、菜单项或处理器；不出现「打开所在文件夹」「预览本地文件」「选择/上传文件」「设置页填 Key」 | 出现上述任一可触发元素；出现对应调用代码；说明区之外残留入口 | 冻结 §6 排除项；02 §6.2；现状 `index.ts:370-389`、`:537-538` | `checks\excluded-audit.txt` |
| AC-I-11 | 打开五份 fixture 对照页面文本；把 `news-list.json` 第一条标题改成一个标记串，刷新新闻列表，再改回 | 页面展示文本与 fixture 字段一致；改值后列表首行跟随标记串；改回后恢复；页面 HTML/JS 中不写死业务标题、题干、证据摘录等展示数据 | 改 fixture 页面无变化（数据被硬编码）；页面出现 fixture 之外的业务文案 | 02 §3 数据结构；02 §6.1 字段兼容 | `checks\fixture-trace.txt` |
| AC-I-12 | Console 逐页执行 `document.querySelectorAll('[data-mock-source]')` 清点；核对属性值与页面-方法对应表 | 五页均有标注；取值依次为 `student.current`、`news.list`、`news.get`、`questions.attempts`、`profile.get`；页面根节点带 `data-fixture`；接缝元素带 `data-replace` | 缺标注；方法名拼写与冻结表不符；标注只写在易被丢弃的 HTML 注释里 | 02 §2.6 接缝标注；冻结 §5 方法表 | `checks\annotations.txt` |
| AC-I-13 | 以 `file://` 方式（双击文件，不经任何静态服务器）打开 `index.html`，走完 AC-I-01 的五页往返；查看 Console 的 `fixture-source` 标记 | 五页渲染正常；`file://` 下命中内联兜底时标记为 `inline-fallback`；无 CORS 报错导致的空白 | `file://` 下正常态空白；依赖 fetch 读本地 JSON 被拦后无兜底；出现模块加载报错 | 02 §5.3 数据加载通道；02 §6.3 浏览器兼容 | `checks\fixture-source.txt` |
| AC-I-14 | 对照 02 §2 各组件兜底规则，检查字段缺失样例（可用临时把 fixture 字段置空的方式，验完还原） | 界面不出现 `undefined` / `null` 字面量；缺 `name` 显示「学生」；缺 `score` 不打对错标签；缺 `answer` 显示「未作答」；证据回查不到能力名显示「能力维度」；非法 `state` 参数回正常态 | 界面渲染出 `undefined` / `null`；缺字段时报错或空白；非法 `state` 进错误分支 | 02 §2 各组件兜底；02 §6.1；现状 `index.ts:211`、`renderers.tsx:142`、`App.tsx:389` | `checks\fallback-check.txt` |

页面结构与触控尺寸对齐小程序设计指南的 375 宽度惯例 [R1]；无横向滚动与换行规则参照响应式布局基线 [R2]；三态骨架不做复杂动画，动效降级口径参照减动效媒体查询 [R3]。

## 4 证据落点

- **根目录：** `.scratch/run/I/`，下分 `screenshots/` 与 `checks/`；每条 AC 的证据文件名见 §3 表。
- **截图：** 375px 设备宽度下整页截图，文件名含页面与状态（正常 / loading / error / empty）；截图只记录视觉结果，不充当数值证据。
- **命令输出原文：** 下列 PowerShell 命令在仓库根执行，输出重定向到 `checks/` 对应文件：

```powershell
cd E:\Documents\GitHub\YingXiaoShang

# AC-I-03 逐页 scrollWidth（浏览器 Console 粘贴，结果手抄或复制进文件）
#   console.log(location.pathname, document.documentElement.scrollWidth, document.documentElement.clientWidth)

# AC-I-09 联网形态静态检索
Select-String -Path "tools\miniprogram-mock\index.html","tools\miniprogram-mock\pages\*.html","tools\miniprogram-mock\scripts\*.js" `
  -Pattern "fetch\(|XMLHttpRequest|WebSocket|EventSource|http://|https://" |
  Out-File -Encoding utf8 .scratch\run\I\checks\network-audit.txt

# AC-I-10 排除能力关键词检索
Select-String -Path "tools\miniprogram-mock\index.html","tools\miniprogram-mock\pages\*.html","tools\miniprogram-mock\scripts\*.js" `
  -Pattern "reveal|preview|openDialog|settings|apiKey|openFile|showItemInFolder" |
  Out-File -Encoding utf8 .scratch\run\I\checks\excluded-audit.txt

# AC-I-12 标注清点（浏览器 Console 粘贴，结果写入文件）
#   Array.from(document.querySelectorAll('[data-mock-source]')).map(e => e.dataset.mockSource)

# AC-I-11 fixture 改值记录：改动前后首行文本各留一份截图或文本摘录
```

- **复跑要求：** 同一套产物可重复跑；AC-I-11 的临时改值必须在验收后还原；`.scratch/run/I/` 下不写任何真实业务数据。
- **数值口径：** `scrollWidth`、体积、首屏耗时一律以实测记录为准；本文不预设像素与毫秒数值。首屏耗时测量方法：DevTools Performance 面板单次打开，或 `performance.now()` 取 `boot()` 前后差值，连开 5 次取中位数，记入 `checks/perf.txt`。

证据以「命令原文 + 输出原文」落盘，便于失败复盘；结构化检查落盘的做法参照测试实践中的 fixture 与证据分离思路 [R4]。

## 5 反向验证（mutation）

约定：手工改坏一处 → 跑对应 AC → 记录失败输出到 `checks/mutation-*.txt` → 还原文件 → 再跑确认变绿。改坏仅限 `tools/miniprogram-mock/` 目录内；不动 `apps/desktop/**`、`packages/**`。

| # | 改坏哪里 | 预期变红的 AC | 还原后 |
|---|---|---|---|
| M1 | 删掉 `styles/app.css` 中长串规则 `overflow-wrap: anywhere`（或对应容器的 `min-width: 0`） | AC-I-04 红：长英文词 / 长 URL 溢出卡片，`scrollWidth` 增大；AC-I-03 可能同时变红 | 变绿 |
| M2 | 把 `news.html` 列表第一条标题改成页面内硬编码字符串，不再从 `news-list.json` 读取 | AC-I-11 红：改 fixture 标题后页面不跟随；AC-I-12 标注与实际数据源脱节 | 变绿 |
| M3 | 在 `scripts/app.js` 引入一次联网调用（`fetch` 指向任一外部地址，或 `new XMLHttpRequest()`） | AC-I-09 红：静态检索命中联网形态，Network 面板出现请求；断网时 AC-I-08 同时受影响 | 变绿 |
| M4 | 在 `profile.html`（或 `index.html`）补一个「打开所在文件夹」按钮入口 | AC-I-10 红：排除能力关键词检索命中可点击元素 | 变绿 |
| M5 | 删掉 `news.html` 根节点或列表块上的 `data-mock-source="news.list"` 属性 | AC-I-12 红：清点结果缺标注或方法名不符 | 变绿 |

mutation 判据沿用 killed / survived 口径：AC 变红 = killed，仍绿 = survived（说明该 AC 没覆盖到这条契约）[R6]；本轮只做手写改坏样例，不引入 mutation 运行时框架 [R7]。

## 6 排查表

| 症状 | 最可能原因 | 一条命令 / 操作确认 |
|---|---|---|
| 双击 `index.html` 页面空白 | 内联 JSON 副本缺失；`app.js` 有语法错误；脚本被浏览器拦截 | 打开 DevTools Console 看报错；检查页面内 `<script type="application/json" data-fixture="…">` 是否存在且可 `JSON.parse` |
| 375px 下出现横向滚动 | 长串未断行；某元素写死固定像素宽度；残留 `white-space: nowrap` | Console 跑 `document.documentElement.scrollWidth`；`Select-String -Path "tools\miniprogram-mock\styles\*.css" -Pattern "nowrap|width:\s*\d{3}px"` |
| 断网后页面空白 | 代码里存在 `fetch` / XHR / 外网 `<img>` 或 `<link>` | 跑 §4 的 `network-audit.txt` 检索命令；Network 面板按类型筛静态资源 |
| 三态面板叠加显示 | 分支容器互斥显隐逻辑未生效；`hidden` 属性被样式覆盖 | 检查根节点 `data-state` 与各 `[data-state]` 容器的显隐；Console 核对 `document.querySelectorAll('[data-state]')` |
| 空态文案与契约不符 | 文案被硬编码改写；引用了桌面端旧句子 | 逐字比对 02 §4.2 表格；`Select-String -Path "tools\miniprogram-mock\pages\*.html" -Pattern "暂无|还没有|尚未匹配"` |
| 详情页点列表行不跳转 | `articleId` 未写入 `href`；卡片 `id` 缺失被置灰 | 检查行元素 `data-article-id` 与 `news-detail.html?articleId=…`；Console 打印 `location.search` |
| 证据标签显示英文能力键 | `competencies` 字典回查未命中，兜底文案未生效 | 对照 `App.tsx:389` 兜底口径；检查 `profile.json` 中 `competencies[].id` 与 `evidence[].competency_id` 是否一致 |
| `file://` 下控制台报模块加载错 | 脚本误用 `type="module"` | `Select-String -Path "tools\miniprogram-mock\pages\*.html" -Pattern 'type="module"'`，应无命中 |
| 改了 JSON 页面没变化 | 页面读的是内联副本，JSON 与内联块未同步 | 核对内联 `<script type="application/json">` 内容与 `fixtures/*.json` 是否逐字一致 |

排查表按「症状 → 最可能原因 → 一条确认命令」组织；布局类症状先落 `scrollWidth` 数值，不凭目估判断 [R2]。

## 7 自检输出

文档自检是交活前的最后一道机器闸：脚本只查结构与引用是否对得上，查不到内容对不对——内容由 §3 的 14 条 AC 负责。机器查形式、人查语义的分工参照测试实践口径 [R5]。

```powershell
cd E:\Documents\GitHub\YingXiaoShang
python plans\server-client-split\00-master\check-docs.py --round I
```

> 说明：`01-scope.md` 与 `02-contract.md` 由并行子代理同时撰写；若本节自检输出仅报告缺这两份文档，属并行期中间状态，保留原样，由主代理在四份齐备后重跑本命令。

```text
仓库根：E:\Documents\GitHub\YingXiaoShang
检查轮次：I
行数统计：
  I-*: 1168 行 / 4 份

全部通过：轮次齐全、节数达标、每节有引用、参考清单与本地行号引用都对得上。
退出码：0
```

（实跑时间 2026-11-19，退出码 0；行数统计会随文档微调变化，以最后一次为准。）

## 参考

- [R1] 微信小程序设计指南 — https://developers.weixin.qq.com/miniprogram/design/ — 支撑 §3 AC-I-01/03 的 375 宽度与点击区口径 — 借鉴尺寸与触控建议；不引入小程序框架。
- [R2] MDN 响应式设计 — https://developer.mozilla.org/en-US/docs/Learn/CSS/CSS_layout/Responsive_Design — 支撑 §3 AC-I-03/04 与 §6 布局排查 — 采用 `max-width:100%` 与换行规则；不做多断点自适应。
- [R3] MDN `prefers-reduced-motion` — https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion — 支撑 §3 AC-I-05 骨架与动效降级 — 采用减动效媒体查询；不做复杂动画。
- [R4] typicode/json-server — https://github.com/typicode/json-server — 支撑 §2 fixture 自包含与 §4 证据分离 — 借鉴 JSON 独立成文件；不引入需要起进程的 mock 服务。
- [R5] JavaScript Testing Best Practices — https://github.com/goldbergyoni/javascript-testing-best-practices — 支撑 §1 可机器判定口径与 §7 自检分工 — 采用可执行断言；不引入其全部工具链。
- [R6] Stryker JS — https://github.com/stryker-mutator/stryker-js — 支撑 §5 mutation 改坏→变红范式 — 借鉴 killed/survived 术语；不引入 Stryker 运行时。
- [R7] Stryker 文档 — https://stryker-mutator.io/docs/ — 支撑 §5 报告口径 — 同上，不做全量 mutant 扫描。
- [R8] Playwright — https://playwright.dev/docs/intro — 支撑 §4 证据落盘与 §3 浏览器内清点思路 — 借鉴断言与证据目录；本原型不强制安装 Playwright。
- [R9] plannotator/effective-html — https://github.com/plannotator/effective-html — 支撑 §2 纯静态可打开性与 §6 `file://` 排查 — 借鉴本地相对路径组织；不照搬其代理脚本。
