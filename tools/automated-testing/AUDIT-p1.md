# 自动化测试独立审计报告（TC-P0-01…13 / TC-P1-01…18）

- 审计范围：`tools/automated-testing` 下 `src/scenarios` 31 条 TC、`src/pages/app-shell.ts`、`src/fixtures`、`src/driver`、`src/client`、`src/evidence`、`verify.ts`、`src/selftest/isolation.ts`、`README.md`。
- 审计方式：只读静态核对（Read/Grep/Glob + 只读 PowerShell/只读 SQLite 查询）；**未运行 Playwright、未启动 Electron**。
- 台账：`docs/11-scenario-catalog.md`；依赖登记表：`src/scenarios/dependencies.ts`（31 条）。
- 种子库实测基线（`release/win-unpacked/resources/seed/learning.db`，只读）：chapters 13、knowledge_points 228、news_articles 134、artifacts 4、chat_sessions 2、chat_messages 8、turns 4、evidence 9、summary_ledger 3、memory_facts 10、growth_snapshots 8。

## 一、总体结论

**有阻塞，不可直接交付**：31 条 TC 台账覆盖完整、无重复/多余；但存在 17 项硬性违例（选择器越层 8、跨层 import 4、固定等待 1、依赖台账失配 4）与 12 项文档/实现口径偏差，且整套用例尚未实际运行，运行态风险未排除。

## 二、31 条 TC 覆盖表

结论标记：✅ 通过｜⚠️ 有偏差/弱覆盖｜❌ 硬性违例。

| TC | 文件:行 | 唯一性 | 七字段一致性 | 规范（禁用模式/架构） | 结论 |
|---|---|---|---|---|---|
| P0-01 | p0-01-boot-health.spec.ts:8 | ✅ | ⚠️ warnings/notices 硬等 `[]`；基线计数/窗口断言越界（见违例 18/19） | ✅ | ⚠️ |
| P0-02 | p0-02-preload-bridge.spec.ts:6 | ✅ | ✅（额外硬断言 studentId 身份） | ❌ 选择器越层 :31-33 | ⚠️ |
| P0-03 | p0-03-chat-stream.spec.ts:7 | ✅ | ⚠️ citations 字段名口径偏差（违例 20） | ❌ :13 `page.locator` | ⚠️ |
| P0-04 | p0-04-chat-persistence.spec.ts:8 | ✅ | ✅ | ✅ | ✅ |
| P0-05 | p0-05-open-artifact.spec.ts:8 | ✅ | ⚠️ 标签标题/类型未断言 | ❌ :43,:46 `page.locator` | ⚠️ |
| P0-06 | p0-06-answer-set.spec.ts:9 | ✅ | ✅ | ❌ :17,:20,:30 `page.locator` | ⚠️ |
| P0-07 | p0-07-clean-exit.spec.ts:10 | ✅ | ✅ | ✅ | ✅ |
| P0-08 | p0-08-09-packaged.spec.ts:30 | ✅ 一文件两 TC（唯一一例） | ✅ | ✅ | ✅ |
| P0-09 | p0-08-09-packaged.spec.ts:64 | ✅ 同上 | ✅ | ✅ | ✅ |
| P0-10 | p0-10-readonly-invoke.spec.ts:14 | ✅ | ✅ | ✅ 经 driver 启动 | ✅ |
| P0-11 | p0-11-news-offline.spec.ts:8 | ✅ | ⚠️ 额外调用 `news.get`（IPC-11 属 P1-04） | ✅ | ⚠️ |
| P0-12 | p0-12-window-state.spec.ts:10 | ✅ | ✅ | ✅ `expect.poll` 合规 | ✅ |
| P0-13 | p0-13-artifact-export.spec.ts:9 | ✅ | ✅ | ✅ | ✅ |
| P1-01 | p1-01-settings.spec.ts:12 | ✅ | ❌ 台账依赖无命中；密钥不回传未断言（违例 14/21） | ✅ | ❌ |
| P1-02 | p1-02-empty-question-set.spec.ts:11 | ✅ | ❌ 空集 UI 口径冲突；台账仅 LEG-03 命中（违例 22） | ❌ 跨层 import :4；选择器 :52,:55,:56,:57 | ❌ |
| P1-03 | p1-03-cancel.spec.ts:7 | ✅ | ❌ 台账无命中；半截落库未查（违例 15） | ❌ 固定等待 :31；选择器 :41 | ❌ |
| P1-04 | p1-04-news-offline.spec.ts:8 | ✅ | ❌ 台账无命中（违例 16）；筛选/解析断言覆盖 | ✅ 经 driver 再导出 | ❌ |
| P1-05 | p1-05-news-refresh.spec.ts:8 | ✅ | ❌ 台账无命中；降级结构字段未断言（违例 17/23） | ✅ | ❌ |
| P1-06 | p1-06-sidecar.spec.ts:51 | ✅ | ✅ | ✅ 有界 `expect.poll` 轮询 | ✅ |
| P1-07 | p1-07-citation.spec.ts:14 | ✅ | ⚠️ 定位失败回落 evidence 分支未覆盖（违例 29） | ❌ :39,:65 `page.locator` | ⚠️ |
| P1-08 | p1-08-sessions.spec.ts:10 | ✅ | ⚠️ 当前 sessionId 未经 IPC 回读 | ✅ | ✅ |
| P1-09 | p1-09-profile.spec.ts:15 | ✅ | ⚠️ 证据 9 条/快照新增行口径偏差（违例 24/25） | ✅ | ⚠️ |
| P1-10 | p1-10-drag.spec.ts:15 | ✅ | ⚠️ `data-dragging` 观测点未断言 | ❌ :29,:30 `ui.page.locator` | ⚠️ |
| P1-11 | p1-11-corrupt-db.spec.ts:22 | ✅ | ⚠️ 权限/不可重置分支运行态未覆盖（已注释说明） | ❌ 跨层 import :7；有界轮询 :92,:141 | ❌ |
| P1-12 | p1-12-dual-instance.spec.ts:15 | ✅ | ⚠️ 源码层无单例锁未 grep 断言 | ✅ 经 driver 启动 | ✅ |
| P1-13 | p1-13-doc-kinds.spec.ts:14 | ✅ | ⚠️ activeTab 回退相邻、Empty 占位未断言 | ✅ | ✅ |
| P1-14 | p1-14-file-preview.spec.ts:78 | ✅ | ⚠️ 取消返 undefined、.docx mammoth 标注人工 | ✅ | ✅ |
| P1-15 | p1-15-memory.spec.ts:28 | ✅ | ⚠️ 按学生隔离未断言 | ✅ | ✅ |
| P1-16 | p1-16-ledger.spec.ts:44 | ✅ | ⚠️ record_json 引用内容未校验；retry 状态迁移未断言（违例 26/27） | ✅ | ⚠️ |
| P1-17 | p1-17-empty-db.spec.ts:22 | ✅ | ✅ | ❌ 跨层 import :5 | ❌ |
| P1-18 | p1-18-unknown-method.spec.ts:15 | ✅ | ⚠️ friendlyError 运行态通道未验证（违例 28） | ❌ 跨层 import :4 | ❌ |

唯一性补充：30 个 `.spec.ts` 文件、31 个 `test()` 标题；除 `p0-08-09` 外每文件一条 TC；无台账外多余 TC；31 条台账 ID 全部被覆盖。所有 spec 均从 `../fixtures/test.js` 取 `test/expect`；无 `test.skip/fixme/describe.skip`；无被注释掉的断言；无空 test body；无 `_electron`、无直接 `@playwright/test` 导入。

## 三、违例清单

归属：**主代理**（P0 侧）/ **P1 所有**（P1-01…18 侧）。

### A. 选择器越层（spec 直接操作 page 选择器，应下沉 `pages/app-shell.ts`）

| # | 文件:行号 | 原文片段 | 违例理由 | 归属 |
|---|---|---|---|---|
| 1 | p0-02-preload-bridge.spec.ts:31-33 | `document.querySelectorAll('aside')` / `'main'` / `'[data-testid="composer-input"]'` | 选择器出现在 spec 的 evaluate 内，违反"选择器只在 pages 层" | 主代理 |
| 2 | p0-03-chat-stream.spec.ts:13 | `app.page.locator('[data-streaming="true"]')` | spec 层 `page.locator` | 主代理 |
| 3 | p0-05-open-artifact.spec.ts:43,46 | `app.page.locator('[data-tab-id=…]')` / `'[data-testid="question-set"]'` | spec 层 `page.locator` | 主代理 |
| 4 | p0-06-answer-set.spec.ts:17,20,30 | `app.page.locator('[data-message-role]')` / `'[data-testid="question-set"]'` / `'[data-testid="question-submit"]'` | spec 层 `page.locator` | 主代理 |
| 5 | p1-02-empty-question-set.spec.ts:52,55,56,57 | `app.page.locator(…)`、`app.page.getByText(…)` ×2 | spec 层选择器 | P1 |
| 6 | p1-03-cancel.spec.ts:41 | `app.page.locator('[data-streaming="true"]')` | spec 层 `page.locator` | P1 |
| 7 | p1-07-citation.spec.ts:39,65 | `app.page.locator('[data-tab-id=…]')` ×2 | spec 层 `page.locator` | P1 |
| 8 | p1-10-drag.spec.ts:29,30 | `ui.page.locator('[role="separator"][data-side="…"]')` ×2 | 经 `ui.page` 暴露选择器，spec 层越层 | P1 |

### B. 跨层 import（spec 直引 `apps/desktop` 被测源码）

| # | 文件:行号 | 原文片段 | 违例理由 | 归属 |
|---|---|---|---|---|
| 9 | p1-02-empty-question-set.spec.ts:4 | `import { emptyQuestionSetAction } from '../../../../apps/desktop/src/renderer/src/question-set.js'` | spec 穿透到 renderer 源码 | P1 |
| 10 | p1-11-corrupt-db.spec.ts:7 | `import { startupFailure } from '../../../../apps/desktop/src/main/health.js'` | spec 穿透到 main 源码 | P1 |
| 11 | p1-17-empty-db.spec.ts:5 | `import { startupHealth } from '../../../../apps/desktop/src/main/health.js'` | 同上 | P1 |
| 12 | p1-18-unknown-method.spec.ts:4 | `import { friendlyError } from '../../../../apps/desktop/src/main/errors.js'` | 同上 | P1 |

### C. 固定等待 / 忙等

| # | 文件:行号 | 原文片段 | 违例理由 | 归属 |
|---|---|---|---|---|
| 13 | p1-03-cancel.spec.ts:31 | `await new Promise((resolve) => setTimeout(resolve, 1200))` | 固定 1200ms 延时等待，命中 verify.ts `setTimeout` 禁用模式；应改事件静默/`expect.poll` | P1 |

有界轮询（仅位置标记，不计硬违例）：p1-11:92 `while (polling)` 标志控制；p1-11:141 `while (… && Date.now() < deadline)` 8000ms 上限；p1-06:55-57/73-75、p0-12、p1-08:45、p1-10:31-32 均为 `expect.poll` 或带超时 `waitFor`。

### D. 依赖台账失配（verify.ts `missingDeps`：文本无任一台账 ID 命中）

| # | 文件:行号 | 台账 ID | 文本实际引用 | 归属 |
|---|---|---|---|---|
| 14 | p1-01-settings.spec.ts:7 | CH-07, CH-08, DATA-10, UI-05, LEG-11 | SVC-19, CH-18, CH-19, DATA-13 | P1 |
| 15 | p1-03-cancel.spec.ts:5 | FLOW-02, CH-02, EVT-01, LEG-01, LEG-02 | CH-15, CH-16, EVT-05, SVC-12 | P1 |
| 16 | p1-04-news-offline.spec.ts:5 | IPC-08, IPC-09, IPC-11, SVC-18, EXT-10 | SVC-23, SVC-24, DATA-11, BOOT-11 | P1 |
| 17 | p1-05-news-refresh.spec.ts:5 | IPC-10, EXT-06, EXT-10, SVC-19 | SVC-26, BOOT-11, DATA-11 | P1 |

### E. 断言与台账卡片口径偏差

| # | 文件:行号 | 卡片口径 | 代码事实 | 归属 |
|---|---|---|---|---|
| 18 | p0-01-boot-health.spec.ts:14-16 | 不断言 warnings 具体文案；空库/种子分叉会改变 warnings | 硬断言 `warnings`/`notices` 均 `toEqual([])`，偏紧、易碎 | 主代理 |
| 19 | p0-01-boot-health.spec.ts:20-31 | P0-01 卡片未要求基线条数与窗口尺寸 | 硬编码 13/228/134/4/2/8/4 计数（基线属 P0-09）+ 标题/最小尺寸断言（属 P0-02） | 主代理 |
| 20 | p0-03-chat-stream.spec.ts:77-79 | 卡片：`citations[].articleId/kpId` | 代码断言 `sourceId/sourceType`；实测 Citation 结构即 sourceId/sourceType（renderer `client-context.ts:33`、`App.tsx:626-646`），**台账字段名过时** | 主代理（文档侧） |
| 21 | p1-01-settings.spec.ts:27-30,41-48 | 断言：不回传密钥本体 | 未校验 settingsGet/set 响应体不含 `apiKey` 明文 | P1 |
| 22 | p1-02-empty-question-set.spec.ts:52-57 | 空集走两个下一步入口 | 实现走 MarkdownView 兜底，提交按钮/题集计数断言为 0；注释 :8-9 说明服务层兜底口径，与卡片 UI 口径冲突（有意偏差，需对齐台账） | P1 |
| 23 | p1-05-news-refresh.spec.ts:15-22 | `results/queued/accepted` 字段在降级结构中存在 | 走 reject 路径，未断言降级结构字段 | P1 |
| 24 | p1-09-profile.spec.ts:17-26 | 前置：seed 证据 9 条 | DB 实测 9 行（8 条 `ev_demo_` 合成 + 1 条真实）；IPC/视图过滤合成证据后非 9，代码只校验结构、以 DB 回退兜底，未断言 9 条 | P1（文档口径） |
| 25 | p1-09-profile.spec.ts:85-90 | 观测点：`growth_snapshots` 新行 | 仅断言 `after >= before`；实现 `INSERT OR IGNORE`（`packages/db/src/index.ts:1155`），重复 checkpoint 不新增，"新增行"不被实现保证 | P1（文档口径） |
| 26 | p1-16-ledger.spec.ts:52-54 | `record_json` 含产物/证据引用 | 仅判非空对象，未校验引用内容 | P1 |
| 27 | p1-16-ledger.spec.ts:92 | retry 后状态从 failed/pending 变化 | 仅校验状态落在枚举、`attempts=0`、`last_error=''`，未断言状态迁移 | P1 |
| 28 | p1-18-unknown-method.spec.ts:15-78 | friendlyError 通道只保留 message | 仅纯函数断言；运行态 IPC 通道返回形态未验证 | P1 |
| 29 | p1-07-citation.spec.ts:39-65 | 定位失败回落 evidence 标签并置 notice | 失败回落分支未构造、未覆盖 | P1 |

**违例统计**：硬违例 17 项（A 选择器 8、B 跨层 4、C 固定等待 1、D 台账失配 4）——主代理 4 项，P1 13 项；口径偏差 12 项——主代理 3 项，P1 9 项。合计 29 项。

## 四、已知偏差的独立复核结论

1. **侧车拉起需删除 `NEWS_CRAWLER_URL`（复核：成立）**
   - 文档/注释说法：该变量非空时 `startNewsBackend` 跳过 spawn，仅做体检。
   - 代码事实：`driver/env.ts:68` 总是注入 `NEWS_CRAWLER_URL=http://127.0.0.1:<port>`；`env.ts:77-80` 对 `extraEnv` 中值为 `undefined` 的键执行删除；`apps/desktop/src/main/news-backend.ts:97-99`：`if (process.env.NEWS_CRAWLER_URL || process.env.NEWS_CRAWLER_AUTOSTART === '0') return url`，非空即返回、不 spawn。`p1-06-sidecar.spec.ts:17-18` 设 `autostartSidecar: true` 且 `extraEnv: { NEWS_CRAWLER_URL: undefined }`，删除后配合 `AUTOSTART=1` 才进入 spawn 分支。

2. **P1-17 空库分支 dev/out 可达、packaged 不可达（复核：成立）**
   - 代码事实：`apps/desktop/src/main/index.ts:72-80` 种子候选仅两处——`process.resourcesPath/seed/learning.db`、`app.getAppPath()/seed/learning.db`，不读环境变量。
   - 实测（当前工作区，只读）：`apps/desktop/seed/learning.db` 不存在；electron `dist/resources` 下无 `seed/` 目录；`release/win-unpacked/resources/seed/learning.db` 存在。故 dev/out 两候选均缺失 → 空库分叉真实可达；packaged 首启必然复制种子，该分叉在 packaged 下不可达。证据：`p1-17-empty-db.spec.ts:11-18` 注释与之一致。

3. **"成长快照应新增行"（复核：台账口径偏严，实现与 spec 一致）**
   - 文档说法：观测点 `growth_snapshots` 新行。
   - 代码事实：`packages/db/src/index.ts:1155` 为 `INSERT OR IGNORE`，同 student/chapter/checkpoint 重复记录不新增；`p1-09-profile.spec.ts:85` 断言 `after >= before`、新增行仅校验 checkpoint 合法域。建议台账改为"行数不减少、新增行 checkpoint 合法"。

4. **"档案证据 9 条非空"（复核：9 为 DB 基线口径，IPC 过滤后非 9）**
   - 文档说法：前置 seed 证据 9 条。
   - 代码事实：只读查询 DB 得 9 行，其中 8 行 `ev_demo_` 合成前缀、1 行真实；`p1-09-profile.spec.ts:11-12` 注释说明合成证据在 `profile.evidence` 与档案视图被过滤，写路径用 DB 回读兜底。建议台账注明"9 条为 DB 基线，IPC/视图仅返回非合成证据"。

5. **"news/source 标签 id 为裸 kind"（复核：代码为前缀 id，裸 kind 仅限五类列表标签）**
   - 文档说法：P1-13 九种 DocKind 与标签 id 并列，字面易被理解为裸 kind。
   - 代码事实：`App.tsx:795` `source:textbook:<id>`、`:822` `source:resource:<id>`、`:868` `news:<sourceId>`、`:775` `artifact:<id>`；裸 kind 仅五类列表标签 `overview/artifacts/evidence/process/files`（`App.tsx:765-768` `openTab`）。`p1-07-citation.spec.ts:36,62` 期望前缀 id，与 renderer 一致；台账 P1-13 的 kind/id 并列表述需澄清。

## 五、必须人工验证项汇总

1. **整套用例首次实跑**：README 自述尚未运行；需确认 Playwright 1.64.1、Electron 二进制、`apps/desktop/out` 构建产物、venv 侧车可用，再跑 `test:p0` / `test:p1`。
2. **跨层 `.js` 导入运行态解析**（违例 9-12）：被引源码为 `.ts`、磁盘无同名 `.js`（`out/main` 仅打包 `index.js`）；tsc Bundler 解析或可通过，Playwright/esbuild 运行态模块解析需首跑验证。
3. **renderer testid 覆盖度**：页面层依赖约 30 个 `data-testid/data-tab-id` 等钩子；台账"渲染层 0 处 testid"与现状不符（renderer 实测 29 处匹配），需逐一核对钩子存在性。
4. **未自动化分支**：P1-11 权限/不可重置运行态；P1-14 取消对话框返 undefined、.docx mammoth 转 HTML；P1-13 缺数据 Empty 占位；P1-12 源码层无 `requestSingleInstanceLock` 的 grep 断言。
5. **种子基线漂移**：多处硬编码计数（13/228/134/4/2/8/4/10/3）依赖 seed 库不变化；种子更新后需同步。
6. **真实模型链路**：P0-03、P0-06、P1-03 依赖 LLM 响应时长与内容，首跑需观察超时与静默窗口。
7. **verify.ts 静态自检**：当前规则会把 `p0-08-09` 两 TC 计为"一文件两 TC"违例；若保留该结构例外，需在自检中白名单化。
