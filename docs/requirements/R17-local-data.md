# R17 本地数据

> 状态：MVP（本轮）
> 依赖：无（被 R06 / R14 / R15 使用）
> 代码：`packages/db/src/index.ts`、`packages/fs-app/src/index.ts`、`packages/path-gate/src/index.ts`、`apps/desktop/src/main/window-state.ts`
> 上位原则：[`../principles/single-agent.md`](../principles/single-agent.md)

## 1. 要什么（学生可见结果）

- 装好就能用，不注册、不登录、不联网也能看已有课程与产物。
- 关掉软件再打开，对话、档案、记忆、做过的题、产出的页面都还在。
- 换一台机器或换一个数据目录，数据跟着目录走，不散落在系统各处。
- 卸载/重装安装包不覆盖已有学习记录；只有显式换目录才会看到另一份数据。
- 学生永远看不到「数据库」「迁移」「WAL」这类词；出问题时只看到一句能照做的中文提示。

## 2. 落位（提示词 / 工具 / skill / 数据）

属于**数据层**，三者之外的基础设施，但对模型是透明的：

- 提示词不出现路径、表名、SQL；模型只看到工具返回的业务字段。
- 工具不自己拼外部路径：产物与导出统一从 `appHome` 派生（BP 的 `projectId` 先做字符白名单清洗），产物写入前再做包含性检查。
- 路径解析只有一处权威：桌面端 `resolveAppHome()`，数据库服务 `LearningDb` 的 `appHome` / `dbPath`。
- 学生身份固定为本地演示学生 `student_demo`（`apps/desktop/src/main/index.ts:23`），服务调用显式传 `studentId`。

## 3. 行为（一轮里怎么发生）

1. 主进程启动，`loadDotEnv` 把仓库 `.env` 补进 `process.env`（`apps/desktop/src/main/index.ts:42-46`）。
2. `resolveAppHome()` 取 `LEARNING_AGENT_HOME`，没有就 `~/.learning-agent`（`apps/desktop/src/main/window-state.ts:24-26`）。
3. 首次启动：`<home>/data/learning.db` 不存在时，从安装包 `resources/seed/learning.db` 复制一份（`apps/desktop/src/main/index.ts:66-76`）。
4. `LearningDb` 打开库：建目录（0700）、建文件（0600）、`foreign_keys=ON`、`journal_mode=WAL`、`busy_timeout=5000`，校验 `application_id`，按 `user_version` 迁移到 7（`packages/db/src/index.ts:819-940`）。
5. 所有服务共享同一个 `ctx.learningDb`；一轮对话写入 `chat_sessions`、`chat_messages`、`turns`，产物写 `artifacts` 并把文件落到 `artifacts/<studentId>/<YYYY-MM>/`（`packages/artifacts/src/index.ts:112-117`）。
6. 导出 BP 与题目集写 `<home>/exports/`（`packages/bp/src/index.ts:1130`、`packages/questions/src/index.ts:986-989`）。

## 4. 契约（工具签名、数据结构、字段、命令）

**环境变量**

| 变量 | 作用 | 默认 |
|---|---|---|
| `LEARNING_AGENT_HOME` | 数据根目录 | 开发：`<repo>/.learning-agent`（`apps/desktop/electron.vite.config.ts:7`）；打包：`~/.learning-agent` |
| `LEARNING_AGENT_TOOL_MAX_BYTES` | 单次工具结果上限（UTF-8 字节） | 36000（`packages/agent/src/tool-loop.ts:9-17`） |
| `LEARNING_AGENT_TURN_TOOL_MAX_CHARS` | 单轮工具结果裁剪阈值（码点） | 48000（`packages/agent/src/tool-loop.ts:19-23`） |
| `LEARNING_AGENT_DEBUG` | 为 `1` 时新闻抓取把原始 HTML 落 `raw/` | 未设 |
| `LEARNING_AGENT_NEWS_REFRESH_MINUTES` | 新闻自动刷新间隔 | 30（`apps/desktop/src/main/index.ts:94-95`） |
| `LEARNING_AGENT_SAMPLE_HOME` | 打包时优先取用的录制示例库 | `.scratch/sample-home`（`scripts/package-desktop.mjs:34`） |

**目录结构**

```
<LEARNING_AGENT_HOME>/
  data/learning.db              主库（运行时伴随 learning.db-wal / -shm）
  artifacts/<studentId>/<YYYY-MM>/   产物文件（HTML / 题目集）
  exports/                      BP、题目集导出（md / docx / json）
  raw/<source>/<articleId>.html 仅 LEARNING_AGENT_DEBUG=1
  spill/                        工具结果溢出，30 天后清理（profiles/learning-agent/cordis.patch.yml:11-14）
```

`tmp/` 在 `README.md:36` 被列为写入目录，但全仓没有对应写入点（待核对）。

**表（`packages/db/src/index.ts:91-440`，`SCHEMA_VERSION = 7`）**

- 课程：`chapters`、`sections`、`knowledge_points`、`content_blocks`、`content_tags`、`ideology_points`、`ideology_tags`、`kp_canonical_map`、`block_canonical_map`
- 新闻与匹配：`news_articles`、`news_tags`、`case_matches`
- 题目：`questions`、`question_kps`、`question_ideology`、`question_attempts`、`question_bank`
- 产物与项目：`artifacts`、`research_projects`、`research_artifacts`、`bp_projects`、`bp_sections`、`skills`
- 学情：`student_profiles`、`competencies`、`evidence`、`growth_records`、`growth_snapshots`、`learning_plan`、`memory_facts`、`memory_episodes`
- 会话与运行：`chat_sessions`、`chat_messages`、`turns`、`learning_states`、`summary_ledger`、`ingest_runs`、`plugin_state`

**命令**

```sh
LEARNING_AGENT_HOME="$PWD/.learning-agent" pnpm run db:seed
LEARNING_AGENT_HOME="$PWD/.learning-agent" pnpm run db:seed:student
```

不设变量时，种子脚本自己补成 `<repo>/.learning-agent`（`pipeline/env.ts:10-11`）。

**备份要求**

- 必须做 SQLite 在线备份：`sqlite3 learning.db ".backup backup.db"`，或 `VACUUM INTO 'backup.db'`（打包脚本就是这么取种子库的，`scripts/package-desktop.mjs:52-58`）。
- 关库后整目录复制时，必须带上 `learning.db-wal` 与 `learning.db-shm`；只复制 `.db` 会丢最近写入。
- 不要用 `RESET_DB=1` 重置学习记录（`pipeline/seed-db.ts:46` 仍保留该开关，仅用于造库）。

## 5. 边界（不做什么、失败怎么表现）

- 不做登录、多租户、教师端、云同步（属 backlog）。库里的 `student_id` 只是本地演示身份。
- 不往 `<home>` 之外写文件：`packages/fs-app/src/index.ts:26-38` 与 `packages/path-gate/src/index.ts:36-56` 在越界时直接拒绝。
- 库的 `application_id` 不是本产品时拒绝打开（`packages/db/src/index.ts:840-847`）；`user_version` 高于 7 时拒绝降级并报错（`:849-854`）。
- 不自动删数据、不自动重置、不在启动时覆盖已有学生档案。
- 迁移失败时整体回滚（每个版本一个事务，`:855-940`），不留下半迁移状态。
- 数据目录不可写时，启动失败；界面只显示中文提示，不显示 SQL 或栈。

## 6. 验收（场景 → 期望）

1. **换目录，数据跟着走**：`LEARNING_AGENT_HOME=D:\yx-home pnpm run db:seed` → 同一变量启动桌面端 → 库路径为 `D:\yx-home\data\learning.db`，`D:\yx-home\artifacts\` 出现新产物；原 `.learning-agent` 目录不再被写入。
2. **换到空目录**：指向一个空目录启动 → 自动建库（schema 到 7），不出现「表不存在」；安装包首次启动还会从 `resources/seed/learning.db` 复制种子（开发态没有种子文件，建的是空课程库，需先跑 seed）。
3. **种子可重跑且不覆盖修订**：改学生姓名、加一条记忆、做一组题 → 重跑 `db:seed` 与 `db:seed:student` → 姓名、记忆、`question_attempts` 保留；`evidence` 只补缺的 id（`INSERT OR IGNORE`，`packages/db/src/index.ts:1059-1097`），但种子证据会被重新标回 `draft`（`markSyntheticEvidence`，`:1122-1138`）。
4. **备份能恢复**：关掉软件 → `VACUUM INTO` 备份 → 删整个 home → 用备份替换 `data/learning.db` → 会话列表、产物列表、记忆都在。
5. **旧设置不丢**：把 `settings.json` 放到 `%APPDATA%\@learning-agent\desktop\`，删掉新 userData 下的同名文件 → 启动后 Key 生效（`apps/desktop/src/main/index.ts:52-61`）。

## 7. 现状与差距（代码事实）

| 事实 | 位置 |
|---|---|
| 品牌常量集中定义：home 变量、目录名、库文件名 | `packages/shared/src/brand.ts:5-14` |
| 桌面端 home 解析只有一处 | `apps/desktop/src/main/window-state.ts:24-26` |
| 开发态默认写仓库内 `.learning-agent`，打包态写用户 home | `apps/desktop/electron.vite.config.ts:7`、`window-state.ts:24-26` |
| 首次启动复制种子库，之后不再覆盖 | `apps/desktop/src/main/index.ts:66-76` |
| WAL + busy_timeout + application_id + 7 版迁移 | `packages/db/src/index.ts:831-940` |
| 产物按学生/月分目录，越界即拒绝 | `packages/artifacts/src/index.ts:112-117` |
| 导出写 `exports/`（BP、题目集） | `packages/bp/src/index.ts:1130`、`packages/questions/src/index.ts:986-989` |
| `raw/` 只在调试开关下写 | `pipeline/ingest-news.ts:52-55` |
| 工具结果溢出落 `spill/`，30 天清理 | `profiles/learning-agent/cordis.patch.yml:11-14` |
| 种子脚本默认 home 与桌面端默认 home 不同 | `pipeline/env.ts:10-11` vs `window-state.ts:24-26` |
| `artifacts.path` 存绝对路径 | `packages/db/src/index.ts:308-315`；`ArtifactService.get()` 直接读该路径 |

差距：

1. **`tmp/` 无写入点**：`README.md:36` 的目录清单包含 `tmp/`，代码里找不到写入方，需删掉这行或补上用途。
2. **换 home 后旧产物打不开**：产物行里存的是旧 home 的绝对路径，只迁移 `data/` 不够；迁移工具需要按相对路径重写或提示「产物位置已变」。
3. **两套默认 home**：种子脚本写 `<repo>/.learning-agent`，数据库包默认 `~/.learning-agent`；桌面端显式传参才一致，命令行与桌面端共享进度必须显式设同一个 `LEARNING_AGENT_HOME`。
4. **Key 不跟数据走**：`settings.json` 在 Electron `userData`，不在 home 内；换 home 不会带走 Key，需在文档与设置页说明。
5. **`RESET_DB=1` 仍在**：`pipeline/seed-db.ts:46` 保留全量重置，仅靠 README 约束，脚本本身不二次确认。
6. **无自动备份**：没有备份按钮，也没有升级前提示；只能靠手工命令。
7. **`.scratch/` 膨胀**：本地实测临时目录已到 760MB（见 `营小商-代码卫生检查-v0.1.md` 第 4 节），不进库但占磁盘，打包脚本还会在其中建 `package-seed-home`。
8. **重跑会重置种子证据的复核状态**：`markSyntheticEvidence` 把 `ev_demo_*` 与 `synthetic=1` 的行改回 `method='rule'`、`review_status='draft'`（`packages/db/src/index.ts:1122-1138`）；学生/教师已复核过的种子证据重跑后需要重新复核，这与「重跑保留修订」的口径有张力。

## 8. MVP 范围与后续

**MVP 做到哪**

- 单一 home、单学生、SQLite（WAL）、7 版迁移、首次种子复制、产物/导出/溢出目录、越界拒绝、旧设置迁移。
- 种子可重跑且不覆盖学生修订。
- 验收见第 6 节五条。

**后续**

- 迁移工具：换 home 时重写 `artifacts.path` 与 `exports` 记录，或在打开失败时给出「文件已移动」的可操作提示。
- 一键备份/恢复（导出 zip，含 `-wal`）与升级前自动快照。
- 数据体积治理：`spill/` 与旧产物按体积/时间提示清理，但不自动删。
- 多学生并存（仍本地、仍无登录）时再评估 `student_id` 隔离与索引。

**明确不做**

- 账号体系、多租户、教师端、云同步、远程备份。
- 把教材/新闻全文提交进仓库，或把数据库文件放进安装包之外的可写系统目录。
- 让模型直接写 SQL 或选目录。

相关：[R06 课程知识库](R06-knowledge.md)、[R15 产物与导出](R15-artifacts.md)、[R18 模型运行时](R18-model-runtime.md)、[R20 运行与验收](R20-run-verify.md)。
