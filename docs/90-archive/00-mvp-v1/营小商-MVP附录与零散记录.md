# 营小商 MVP 附录与零散记录

> **已归档（2026-10-21）**：启动、测试命令与验收细节已并入 [`../00-mvp-v2/00-mvp/营小商-MVP-v2.0.md`](../00-mvp-v2/00-mvp/营小商-MVP-v2.0.md)，本文仅用于追溯。

> 日期：2026-10-19  
> 定位：`docs/00-mvp` 的第三份文档，收纳不适合放进设计文档或反馈文档的细小记录：截图、部署、测试、文件说明、历史记录。

---

## 1. 学生使用截图

来源：本机部署的 Web 服务（`pnpm web:build` + `pnpm web:start`），用 Playwright + 本机 Chrome 实际走完“空态 → 用胖东来案例讲消费者”流程后截取。使用干净的 `student_demo`（林晓）数据目录。

| 文件 | 内容 |
|---|---|
| `docs/screenshots/01-empty-state.png` | 按当前学习状态生成的空态：标题、说明与 2–3 个入口 |
| `docs/screenshots/02-case-lesson.png` | 聊天回复 + 右栏案例精讲总览 |
| `docs/screenshots/03-case-dialogue.png` | “消费者”知识点：定义 → 案例对应 → 案例对话 |
| `docs/screenshots/04-learning-dialogue.png` | “学习”知识点：定义 → 胖东来体验/心智/跨城行为 → 对话 |

复现：

```bash
pnpm web:build
LEARNING_AGENT_HOME="$PWD/.scratch/screenshot-home" pnpm db:seed
LEARNING_AGENT_HOME="$PWD/.scratch/screenshot-home" pnpm db:seed:student
LEARNING_AGENT_HOME="$PWD/.scratch/screenshot-home" LEARNING_AGENT_WEB_PORT=3084 pnpm web:start
LEARNING_AGENT_WEB_URL=http://127.0.0.1:3084 node scripts/capture-screenshots.mjs
```

---

## 2. 启动与部署

### 2.1 桌面端

```bash
pnpm install
pnpm build:desktop
LEARNING_AGENT_HOME="$PWD/.learning-agent" pnpm --dir apps/desktop start
```

### 2.2 Web 端

```bash
pnpm web:build
LEARNING_AGENT_HOME="$PWD/.learning-agent" pnpm web:start
# http://127.0.0.1:3081
```

### 2.3 非回环访问

容器化部署不在 MVP 范围。Web 端以进程方式长驻运行，需要对外提供服务时：

- 本地回环的桌面/CLI 可不设令牌；**非回环访问强制 `LEARNING_AGENT_ACCESS_TOKEN`**（服务拒绝在缺少令牌时绑定非回环地址）；
- 公网部署必须放在 HTTPS 反向代理后，反向代理到 `127.0.0.1:3081`。

### 2.4 新闻自动抓取

- Web：`apps/web/server.ts` 启动时 `startNewsAutomation()`，立即 `ensureFresh()`，之后默认每 30 分钟；
- 桌面：`apps/desktop/src/main/index.ts` 窗口创建后同样启动；
- 最新抓取在 30 分钟内会跳过；
- 抓取失败保留旧数据，写 `ingest_runs`。

---

## 3. 测试与验证

> 以下回归已于 2026-10-19 在本机全部跑通（无 `DEEPSEEK_API_KEY`，走离线确定性回退）。

```bash
# 类型检查（改 packages/*/src 后先跑，tsc -b 会编译 lib/）
pnpm typecheck

# 14 个非 UI 回归
pnpm test:router && pnpm test:context && pnpm test:offline && pnpm test:profile \
&& pnpm test:skills && pnpm test:plugins && pnpm test:smoke && pnpm test:artifacts \
&& pnpm test:web && pnpm test:agent && pnpm test:case && pnpm test:news \
&& pnpm test:data-quality && pnpm test:bootstrap

# 补充：mock LLM 管道、UI bundle 注册
pnpm test:llm && pnpm test:ui

# 真实界面（先构建）
pnpm --dir apps/web build && pnpm test:ui-web          # 真实 Chrome
pnpm build:desktop && \
  node scripts/test-ui-case.mjs && \
  node scripts/test-ui-flow.mjs && \
  node scripts/test-ui-queue.mjs                        # 真实 Electron ×3

# 质量报告（只读）
pnpm pipeline:quality --chapter ch04
```

本轮真实结果：

- 类型检查、14 个非 UI 回归、`test:llm`/`test:ui` 全部 EXIT=0；
- 真实 Chrome：教学示例标签、教材原文回链（块 `cb_f4ef77da999f`、第 71 页）、自动候选隐藏教学断言/已审展示、Markdown 下载鉴权、交卷隔离、Web 隐藏本地文件入口、访问令牌从地址栏剥离；
- 真实 Electron：案例结构（定义/案例对应/示例对话/教学示例）与追问聚焦；诊断 5 问→计划→解释（3 引用）→练习交卷→调研→BP→成长→新闻分析（自动候选 3、出题 0）→过程面板→文件；排队出题/2 题卷/清空；
- ch04：自动覆盖 25/26=0.9615、知识点覆盖 24/26=0.9231、1 个零标签块；`checks` 七项全 true（含重复知识点、span 可定位、引用可追溯）；
- 旧库（user_version=5）升级演练幂等，12 类学生进度表行数逐行不变、计划状态零漂移；KP 253→228；主库已非破坏升级（备份在 `.scratch/`）。

诚实保持为 `null` 的指标（没有真实输入不填模拟值）：

- `precision@5`：需要教师 `--judgments` 相关性判定；
- 双人标注一致率：需要两名独立标注者 `--annotations`；
- 语义召回：无 embedding 供应商时为 `lexical-hash` 降级（`semantic=false`）。

仍未验证：

- 多学生并发/登录；
- 真实课堂 12 周试点。

---

## 4. 文件说明

| 路径 | 说明 |
|---|---|
| `packages/agent/src/index.ts` | 主 Agent、TurnPlan/TurnRecord、执行器 |
| `packages/agent/src/judge.ts` | 规则判断入口 |
| `packages/agent/src/router.ts` | 受限 LLM 路由 |
| `packages/agent/src/registry.ts` | AgentSpec 注册表与步骤校验 |
| `packages/agent/src/subagents.ts` | 知识/出题/调研/BP/成长/反馈 |
| `packages/agent/src/news-lab.ts` | 新闻抓取/分析/出题 |
| `packages/agent/src/case-coach.ts` | 案例精讲产物 |
| `packages/agent/src/case-library.ts` | 预置区域商超案例 |
| `packages/agent/src/chat.ts` | ChatAgent（唯一说话人） |
| `packages/agent/src/recorder.ts` | 记录 Agent / summary ledger |
| `packages/agent/src/state.ts` | 状态投影 |
| `packages/shared/src/index.ts` | 共享 schema / 契约 |
| `apps/desktop/src/renderer/src/App.tsx` | 三栏布局、聊天、空态 |
| `apps/desktop/src/renderer/src/workspace.tsx` | 右栏多标签工作区、过程面板 |
| `apps/desktop/src/renderer/src/renderers.tsx` | 产物 renderer |
| `apps/web/server.ts` | Web API + 静态服务（默认回环、非回环强制令牌） |
| `apps/web/src/bridge.ts` | 浏览器 `window.learning` bridge |
| `data/normalized/knowledge_points.curated.json` | 人工审定知识点 |
| `data/normalized/kp_merge_map.json` | 近义知识点人工同义合并映射（9 对，seed 消费） |
| `pipeline/data-quality.ts` | 覆盖率/质量报告（缺真实标注时指标返回 null） |
| `pipeline/tag-content.ts` / `review-tags.ts` | 教材块规则标签与人工审查/导入 |
| `packages/shared/src/span.ts` | 原文 span 定位与回归校验 |
| `scripts/test-*.ts` / `test-ui-*.mjs` | 非 UI 回归脚本 + Chrome/Electron 真实界面脚本 |
| `docs/screenshots/` | 学生使用截图 |

---

## 5. 当前已知缺口（整改后状态）

> 下列为整改前缺口（详见反馈文档附录 A/B）在 2026-10-19 收尾后的状态。

已解决：

- ~~`content_tags = 0`，教材段落没有标签~~ → 规则标签已落库，ch04 自动覆盖 25/26；
- ~~`news_tags = 1`、`case_matches = 1`，匹配几乎是 mock~~ → 60 个真实候选、`invalid_spans=0`、`mock_matches=0`，自动/已审分级；
- ~~ch04 有同名/近义知识点~~ → 精确同名 18 + 人工映射 9 共合并 27 个，KP 253→228，无重复组；
- ~~UI 显示 `core` / `kp_*` 英文/内部 ID~~ → 中文化、去原始 ID/角色/章节/Markdown；
- ~~案例证据 `sourceId` 全部指向同一篇不相关文章~~ → 引用经 `locateSpan` 回原文校验，定位失败明确提示“旧引用需复核”；
- ~~案例主体是预置内容~~ → 案例精讲与教材知识点/新闻证据联动；
- ~~Prompt 固定“三点+三条+边界”、复杂问题不拆解~~ → 复合问题先拆覆盖契约、单概念不扩写；
- ~~追问错误聚焦~~ → 追问继承主题并聚焦，Electron 用例已验证。

保留为真实限制 / 需人工（不编造）：

- 自动覆盖是规则结果（非人工标注），不能宣称“教材已人工标注”；
- 无 embedding 供应商时语义召回为 lexical-hash 降级（`semantic=false`）；
- `precision@5`、双人一致率保持 `null`，待真实教师标注；
- 种子确定性新闻候选只预生成前 20 篇（处理上限，非召回失败）；
- 历史 case 产物旧 `sourceId` 是否回填需人工决定；
- 脏数据 `kp_digital_consumer_traits_2` 名称/内容错位，需人工裁决。

---

## 6. 文档历史

| 日期 | 变更 |
|---|---|
| 2026-10-18 | MVP v0.1 调研/设计、实现说明 |
| 2026-10-18 | 对话与多 Agent 优化 v0.2 |
| 2026-10-19 | 案例联动与 Web 部署 v0.3 |
| 2026-10-19 | Codex 式多 Agent 路由 v0.4 |
| 2026-10-19 | 合并为三份：设计文档、反馈文档、本附录 |
| 2026-10-19 | MVP 整改收尾：近义知识点合并（人工映射）、14 非 UI + 4 真实界面回归全通过、旧库升级演练、主库非破坏升级；同步本附录 §3/§4/§5 |
