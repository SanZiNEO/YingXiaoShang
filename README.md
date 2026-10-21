# 营小商

**营小商 · 市场营销伴学**

本地优先的营销学习助手，数据落在本地 SQLite；
当前 MVP 是**单学生本地演示库**（`student_demo`），没有登录/多租户；
多用户、教师端和完整 review/assessment 流程不在当前 MVP 范围。

学生只需聊天，不需要先选章节或专家。一轮对话就是三件事：

- **提示词**：系统拼好角色与当前环境（章节、学情、最近对话、已有产物）。
- **工具**：读材料、查课程、查新闻、写产物；模型自己看着选，不执行任意命令。
- **输出**：默认让模型直接产 HTML 页面，右栏直接看；只有出题这类要嵌进我们做题壳子的才走结构化数据。

内部可以有分工（案例精讲、出题、调研/BP、能力评价、反例挑战），但**只有一个说话人**，
产物是附件，不替代回复。

验收切片是第 4 章「消费者市场与购买行为分析」。

完整口径见 [`docs/00-mvp/营小商-MVP-v2.0.md`](docs/00-mvp/营小商-MVP-v2.0.md)。

## Prerequisites

- Node `^22.19.0 || >=24.0.0`
- pnpm 11（仓库通过 `packageManager` 固定 `pnpm@11.28.5`）
- Windows 上可选安装 Microsoft Word：`.doc` 优先用 `word-extractor`，失败时才走 Word COM
- `DEEPSEEK_API_KEY`：真实模型生成与 AI 标注需要；没有 Key 时保留课程检索、规则候选与离线回退

## Setup

```sh
pnpm install
cp .env.example .env   # 填入 DEEPSEEK_API_KEY（可选：不填也能离线跑四个核心 Skill）
```

`LEARNING_AGENT_HOME` 默认是 `<repo>/.learning-agent`；桌面端默认写入
`~/.learning-agent`，可用环境变量覆盖。应用只在这里写入：
`data/learning.db`、`artifacts/`、`exports/`、`tmp/`、`raw/`、`spill/`。
产品名、home 变量、数据库文件名集中在
`packages/shared/src/brand.ts`，改这一个文件即可换名。

首次使用时初始化课程和演示学生。桌面与 Web 若要共享进度，请显式使用同一数据目录：

```sh
LEARNING_AGENT_HOME="$PWD/.learning-agent" pnpm run db:seed
LEARNING_AGENT_HOME="$PWD/.learning-agent" pnpm run db:seed:student
```

## Data pipelines

```sh
pnpm run pipeline:resources   # 13 章、52 份必需文档 -> data/normalized/
pnpm run pipeline:news        # SocialBeta、联商网、品牌星球、WSCN -> DB + normalized JSON
pnpm run db:seed              # 非破坏性导入；合并主知识点、初始化自动标签与新闻候选
pnpm run pipeline:content-tags --chapter ch04
pnpm run pipeline:tag --limit 20 --no-llm
pnpm run pipeline:quality --chapter ch04
```

`data/normalized/` 是生成物；`data/legacy/` 只作参考；`resources/` 不跟踪、
只读。不要提交教材或新闻全文。

自动标签始终是 `auto/draft`，仅用于召回；不能冒充教师审核或能力评价锚点。
新闻出题要求已审核的 `verified/gold` 映射，只有自动候选时会说明缺少审核依据，
不会强行出题。`pipeline:review` 提供标签审查/导入入口，`pipeline:quality` 可用
`--judgments` 和 `--annotations` 计算真实标注数据的 precision@5 与双人一致率；
缺少数据时返回 `null` 及原因，不生成虚假分数。

已有库升级前应做 SQLite 在线备份（包括 WAL），不要只复制 `.db` 文件，也不要
用 `RESET_DB=1` 重置学习记录。种子脚本重跑会保留学生修订的档案、计划与记忆。

## Design docs

文档地图见 `docs/README.md`。当前只有一份文档定义口径：

- `docs/00-mvp/营小商-MVP-v2.0.md`：**产品口径，唯一权威**。边界、展示什么、一轮怎么走、输出格式规则、工具、谁说话、验收、现状与差距。
- `docs/00-mvp/` 其余四份：需求分层、现状不足与可借鉴、多专家团模式参考、代码卫生检查。
- `docs/10-long-term/`：长远系统拆解与能力评价需求，不约束 MVP。
- `docs/20-features/`：案例库、碎片化知识体系等单点方案；知识体系是当前数据底座。
- `docs/30-research/`：同类项目调研。
- `docs/90-archive/`：历史文档与合并前源材料，只读追溯。

## Verification

只验两件事：能编译、拉起来能跑。

```sh
pnpm run typecheck
pnpm run build
```

行为验收靠把服务真跑起来，用 `.env` 里的真实 key 走一轮，不靠脚本里的假模型：

```sh
pnpm run db:seed      # 首次：灌课程数据
pnpm run db:seed:student
pnpm run web:dev      # 后端 + Web
pnpm run dev:desktop  # 或直接开桌面端
```

此前 `scripts/test-*.ts` 那一批会在进程内塞一个返回固定字符串的假 `llm`，
再断言这个假回复——测的是桩，不是产品，已经全部删除。要验证行为就把服务
拉起来真跑一轮；`scripts/` 现在只留启动与打包用的工具。

## Run

桌面端（推荐）：

```sh
pnpm run build:desktop
pnpm run dev:desktop
```

桌面端是一个三栏对话式应用：

- 左栏：新对话、会话状态、学习档案、设置
- 中栏：唯一聊天主线，支持诊断、解释、案例、练习和产物附件
- 右栏：可关闭的文档标签；按需打开产物、依据、过程、文件与任务概览

Web 端（可长驻部署，复用同一份 React 界面）：

```sh
pnpm run web:build
LEARNING_AGENT_HOME="$PWD/.learning-agent" pnpm run web:start
# http://127.0.0.1:3081
```

Web 端默认只监听回环地址；要对外提供服务必须设置 `LEARNING_AGENT_ACCESS_TOKEN`，
并且放在 HTTPS 反向代理之后。细节见 `apps/web/README.md`。

容器部署不在当前 MVP 范围。

旧版 `pnpm run dev:web` 仍保留，用于 DSH profile 调试，不是本产品 Web 入口。

## Layout

```
packages/shared      zod schemas + brand/constants
packages/db          node:sqlite LearningDb service
packages/fs-app      app-root FileSystem provider
packages/path-gate   tools/pre-execute path guard
packages/knowledge   knowledge tools
packages/news        source adapters + runtime refresh/tools
packages/matcher     LLM matching + evidence validation
packages/questions   generation/validation/export
packages/research    research tools
packages/bp          business-plan tools
packages/skills      四个核心 Skill：出题、调研设计、BP 目录、成长卡 + 新闻分析
packages/artifacts   产物落盘、模板渲染、MD/DOCX 导出
packages/profile     档案、记忆、证据、前后测、成长卡
packages/export      DOCX/Markdown export
packages/api         LearningRemote (@Remote) service
packages/ui          营小商 Web pages + client bundle
packages/bundle      cordis.patch.yml + four agent presets
apps/desktop         Electron 三栏桌面端（主进程 IPC + React renderer）
apps/web             Web 长驻服务：同一份 React 界面 + HTTP API
pipeline/            TypeScript ingestion scripts
profiles/learning-agent/  learning profile package + overrides
```
