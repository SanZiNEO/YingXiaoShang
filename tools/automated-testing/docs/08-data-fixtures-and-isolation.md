# 08 · 数据 fixture 与环境隔离

> 归属：持久化层、种子库、配置/状态文件、测试隔离与清理 ｜ 状态：已完成 ｜ 核对日期：2026-11-18
> 覆盖：`packages/db` 的 SQLite 结构与迁移、打包 seed 库首启复制、`LEARNING_AGENT_HOME` 隔离组合、`settings.json` / `window-state.json`、WAL/SHM 取证清理、`artifacts/` / `exports/` 布局、造数方案对比；行号截至 2026-11-18 工作区。
> 不覆盖：打包/asar/extraResources 构建流程细节（见 `05-build-package-and-first-run.md`）、Python 采集服务写库契约（见 `06-news-sidecar-and-network.md`）、IPC 方法字段（见 `03-ipc-and-preload-contract.md`）。

## 1. 结论摘要（TL;DR）

1. 库文件固定在 `<appHome>/data/learning.db`；`appHome` 解析顺序为 `config.appHome` → `LEARNING_AGENT_HOME` 环境变量 → `~/.learning-agent`；dev 下 `electron.vite.config.ts` 把 home 指向仓库内 `.learning-agent` `[源码]`。
2. 迁移由 `PRAGMA user_version` 驱动，当前 `SCHEMA_VERSION = 7`，逐段事务迁移；`application_id = 0x4c4e5244`（1280201284），非本应用库直接抛错 `[源码]`。
3. 种子库仅在「目标库文件不存在」时从 `resources/seed/learning.db`（兜底 `appPath/seed/learning.db`）复制一次；仓库内 `apps/desktop/seed/` 不存在，重新打包可能产出无种子安装包 `[源码]`。
4. 实测 seed 基线：38 张表、`user_version=7`、`journal_mode=delete`、13 章 / 228 知识点 / 134 新闻 / 456 题目；线上活库多一张 Python 侧 `source_runs` 表，共 39 张表、WAL 模式 `[实测，只读打开]`。
5. 隔离首选临时 `LEARNING_AGENT_HOME`：db、`artifacts/`、`exports/`、`window-state.json` 全部落在该目录；**但 `settings.json` 走 Electron `userData`，不受 `LEARNING_AGENT_HOME` 重定向**，这是当前隔离面的已知缺口 `[源码]`。
6. `NEWS_CRAWLER_AUTOSTART=0`（或显式给 `NEWS_CRAWLER_URL`）时主进程只做健康检查、不拉起 Python 子进程；隔离用例应固定一个不冲突端口（示例 8799）`[源码]`。
7. WAL 三件套 `learning.db` / `learning.db-wal` / `learning.db-shm` 必须一起快照、一起清理；只复制主库可能漏掉未 checkpoint 的 WAL 帧 `[源码 + 实测]`。
8. 造数三条路：复制 seed 库（最稳）、直接 SQL 插入（可控但绕开服务校验）、IPC 调方法生成（最贴近真实但依赖 LLM 且内容不确定）；对比见第 6 节 `[源码]`。

## 2. 结构与流程

### 2.1 首启自举与数据落位

```
应用启动 initServices()
  │
  ├─ loadDotEnv() 补 process.env（已有变量优先）            [main/env.ts:7]
  ├─ 解析 appHome = LEARNING_AGENT_HOME || ~/.learning-agent [main/window-state.ts:24]
  ├─ settings.json → app.getPath('userData')（不在 appHome）[main/index.ts:58]
  ├─ 若 <appHome>/data/learning.db 不存在：
  │     候选1 resourcesPath/seed/learning.db
  │     候选2 appPath/seed/learning.db
  │     找到则 copyFileSync 到 dbPath                      [main/index.ts:71-81]
  └─ ctx.plugin(LearningDb,{appHome})
        └─ 打开 DB → PRAGMA foreign_keys/WAL/busy_timeout
             → 校验 application_id → 按 user_version 迁移   [db/index.ts:819-940]
```

### 2.2 appHome 内文件布局（源码 + 实测对照）

| 路径（相对 appHome） | 写入方 | 内容 | 证据 |
|---|---|---|---|
| `data/learning.db` | `LearningDb`（主进程）；Python 子进程同库写新闻/`source_runs` | SQLite 主库 | `[源码:db/index.ts:824]` |
| `data/learning.db-wal` | SQLite WAL 层 | 未 checkpoint 的写帧 | `[实测: 活库 0 字节，shm 32768 字节]` |
| `data/learning.db-shm` | SQLite WAL 层 | 共享内存索引 | `[实测]` |
| `window-state.json` | `trackWindowState`（debounce 300ms + close 时保存） | 窗口位置/最大化 | `[源码:main/window-state.ts:84-143]` |
| `artifacts/<studentId>/<YYYY-MM>/<id>.<ext>` | `ArtifactService.create` | 学习产物文件（md/html/docx） | `[源码:packages/artifacts/src/index.ts:110-133]` |
| `exports/questions-<timestamp>.{json,csv,docx}` | `QuestionSmith.exportQuestions` | 题目导出 | `[源码:packages/questions/src/index.ts:986-1027]` |
| `exports/bp-<safeId>-<timestamp>.{md,docx}` | `BpService.exportPlan` | BP 导出 | `[源码:packages/bp/src/index.ts:1127-1137]` |
| `settings.json`（**不在 appHome**） | `SettingsStore.write` | API Key / 模型 | `[源码:main/index.ts:58, main/settings.ts:67-84]` |

### 2.3 环境变量入口（主进程与 agent 实际读取点）（DATA-09）

| 变量 | 读取点 | 默认 / 约束 | 隔离用途 |
|---|---|---|---|
| `LEARNING_AGENT_HOME` | `db/index.ts:822`、`window-state.ts:25` | 缺省 `~/.learning-agent`；dev 由 `electron.vite.config.ts:7` 注入仓库 `.learning-agent` | **隔离根目录，必须显式设置** |
| `LEARNING_AGENT_PROMPT_ROOTS` | `agent/prompts.ts:11`；主进程 `index.ts:52-55` 每次启动拼装 `;` 分隔根 | `resourcesPath/prompts` + `packages/agent` | 一般不必改；离线改提示词时指向隔离副本 |
| `LEARNING_AGENT_PROMPTS_DIR` | `agent/prompts.ts:10` | 空 | 单提示词根覆盖，优先级高于 ROOTS |
| `LEARNING_AGENT_NEWS_REFRESH_MINUTES` | `main/index.ts:104` | 默认 30，最小 1（`Math.max(1,…)`） | 隔离用例调大，避免后台轮询干扰断言 |
| `NEWS_CRAWLER_PORT` | `main/news-backend.ts:10` | 默认 8788 | 选不冲突端口（示例 8799） |
| `NEWS_CRAWLER_URL` | `news-backend.ts:11`、`packages/news/src/index.ts:146` | 默认 `http://127.0.0.1:8787`（news 包内默认值）；桌面后端默认拼 `:8788` | 指向外置/占位服务；设置后不自动拉起 |
| `NEWS_CRAWLER_AUTOSTART` | `news-backend.ts:97` | 未设置则 autostart；`=== '0'` 只健康检查 | 隔离用例设 `0`，禁止 spawn 子进程 |
| `NEWS_CRAWLER_DIR` | `news-backend.ts:42` | 候选：`appPath/services/news-crawler-py`、`../../services/...`、`cwd/services/...` | 仅 autostart 时使用 |
| `NEWS_CRAWLER_PYTHON` | `news-backend.ts:51` | 空则走 venv 解析 | 仅 autostart 时使用 |
| `NEWS_CRAWLER_VENV` | `news-backend.ts:63` | 默认 `<repo>/.venv` | 仅 autostart 时使用 |
| `NEWS_CRAWLER_WORKERS` | `news-backend.ts:132,142` | 默认 8 | 仅 autostart 时使用 |
| `ELECTRON_RENDERER_URL` | `main/index.ts:154-157` | 存在则 `loadURL`，否则 `loadFile(out/renderer/index.html)` | dev 服务器地址；打包/冒烟不设 |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` / `DEEPSEEK_BASE_URL` | `main/settings.ts:50-61`、`main/llm.ts:85` | 模型默认 `deepseek-chat`；地址默认 `https://api.deepseek.com` | 离线用例不设 Key；在线用例按需注入 |
| `LEARNING_AGENT_TOOL_MAX_BYTES` / `LEARNING_AGENT_TURN_TOOL_MAX_CHARS` | `agent/tool-loop.ts:15,20` | 代码内默认值 | 工具结果裁剪预算，一般不改 |
| `AGENT_DEBUG_LOOP` | `agent/tool-loop.ts:278,352` | 未设为 `1` 关闭 | 调试日志开关 |

## 3. 关键代码位置

| 职责 | 文件:行 | 说明 |
|---|---|---|
| appHome 解析 | `apps/desktop/src/main/window-state.ts:24` `resolveAppHome` | `LEARNING_AGENT_HOME` 优先，否则 `homedir()/.learning-agent` |
| 库路径与占位文件 | `packages/db/src/index.ts:819-830` | `data/<BRAND.dbFile>`；`mkdirSync(...,0o700)`；`openSync(path,'wx',0o600)` 占位 |
| PRAGMA 设置 | `packages/db/src/index.ts:832-834` | `foreign_keys=ON`、`journal_mode=WAL`、`busy_timeout=5000` |
| application_id 校验 | `packages/db/src/index.ts:840-847` | 非 0 且不等于 `APP_ID` 抛 `database belongs to another application` |
| 迁移主循环 | `packages/db/src/index.ts:849-940` | `user_version` 0→1（SCHEMA）→2…→7；每段 BEGIN/COMMIT，失败 ROLLBACK；v6 后 `mergeDuplicateKps()` |
| 迁移段定义 | `packages/db/src/index.ts:91-233`（SCHEMA）、`:235-289`（M2）、`:291-322`（M3）、`:324-384`（M4）、`:386-401`（M5）、`:403-443`（M6）、`:445-449`（M7） | 建表 / ALTER / 索引 |
| 领域数据清空 | `packages/db/src/index.ts:943-989` `resetDomainData` | 删领域表、保留 schema 与 application_id |
| 种子复制 | `apps/desktop/src/main/index.ts:71-81` | 仅 `!existsSync(dbPath)` 时；候选顺序 resources → appPath |
| seed 打包映射 | `apps/desktop/electron-builder.yml:12-20` | `seed/learning.db` → `resources/seed/learning.db`；agents/references → `resources/prompts/...` |
| settings 路径与旧目录迁移 | `apps/desktop/src/main/index.ts:58-65` | 现路径 `userData/settings.json`；旧目录 `appData/@learning-agent/desktop/settings.json` 存在则复制一次 |
| settings 读写 / BOM 剥离 | `apps/desktop/src/main/settings.ts:19,37-45,67-84` | 读时正则去 BOM；写回 `JSON.stringify(...,2)+"\n"`，utf8 无 BOM |
| window-state 读写 | `apps/desktop/src/main/window-state.ts:58-92` | 损坏/越界返 `undefined` 回退默认；写失败静默忽略 |
| 窗口状态跟踪 | `apps/desktop/src/main/window-state.ts:98-143` | resize/move debounce 300ms；maximize/unmaximize/close 即时保存 |
| 新闻后端拉起条件 | `apps/desktop/src/main/news-backend.ts:97-115` | 有 `NEWS_CRAWLER_URL` 或 `AUTOSTART==='0'` 直接返 URL；否则探活 → 找目录/解释器 → spawn |
| 产物目录与命名 | `packages/artifacts/src/index.ts:110-133` | `art_<ts36>_<uuid8>`；目录 `artifacts/<studentId>/<YYYY-MM>`；html 直写，md/docx 走 export 包 |
| 题目导出目录 | `packages/questions/src/index.ts:986-1027` | `exports/questions-<ISO 时间戳>`；CSV 首字节写 `\uFEFF`（Excel 兼容） |
| BP 导出目录 | `packages/bp/src/index.ts:1127-1137` | `exports/bp-<safeId>-<ISO 时间戳>.<md|docx>` |
| 启动健康自检 | `apps/desktop/src/main/health.ts:23-35` | 章节 0 / KP 0 告警；新闻 0 仅提示 |
| 坏库重置改名 | `apps/desktop/src/main/index.ts:426-434` | 主库与 `-wal`/`-shm` 一并改名为 `.broken-<时间戳>` 后 relaunch |

## 4. 可测点（DATA-xx）

### 4.1 SQLite 结构基线

| ID | 观测点 | 断言口径 | 证据等级 |
|---|---|---|---|
| DATA-01 | `<appHome>/data/learning.db` 路径 | 隔离 home 下库路径可拼出；不指向 `~/.learning-agent` 或仓库 `.learning-agent` | `[源码:db/index.ts:821-824]` |
| DATA-02 | 打开后 `PRAGMA application_id / user_version / journal_mode / busy_timeout / foreign_keys` | `application_id=1280201284`；`user_version=7`；`journal_mode=wal`；`busy_timeout=5000`；`foreign_keys` 由连接置 ON（注意：`foreign_keys` 是连接级 PRAGMA，另开只读连接查到 0 不代表主连接未开） | `[源码:db/index.ts:832-846]`；`[实测: 活库 user_version=7, wal]` |
| DATA-03 | 迁移幂等性 | 对 v7 库再开一次不抛错、不重复建表；构造旧版本库（历史快照 v6）启动后升到 v7；高于 7 抛错 | `[源码:db/index.ts:849-939]`；`[待验证]` 旧库升级路径需用 `.scratch` 快照实跑一次 |
| DATA-04 | 表清单与关键字段 | 见 4.2 节表清单；新增用例只依赖已列出字段，JSON 字段（`*_json`）按字符串读取后解析 | `[源码: db/index.ts SCHEMA/MIGRATION_*]`；`[实测: 种子库 38 表、活库 39 表]` |
| DATA-05 | 索引与外键 | 关联表删除父行级联删子行；唯一索引：`news_articles(url)`（`:146`）、`chat_messages(session_id,seq)`（`:338`）、`question_bank(stem_hash)`（`:400`）；连接表 `question_kps/question_ideology/plugin_state` 为 `WITHOUT ROWID`（`:178,:185,:232`） | `[源码:db/index.ts:97-232,338,400]` |
| DATA-06 | seed 复制条件 | dbPath 不存在才复制；已存在则不动；两个候选路径都找不到则建空库并走迁移 | `[源码:main/index.ts:71-81]` |
| DATA-07 | seed 基线内容 | 见 4.3 节实测行数；冒烟可用「chapters=13、knowledge_points=228」做健康断言 | `[实测: 只读打开 release/win-unpacked/resources/seed/learning.db]` |
| DATA-08 | 历史快照对照 | `.scratch/desktop-20261019183452.db` 与 `repo-20261019183452.db` 均 `user_version=6`、38 表；可作「旧版本升级」与「脏数据样本」对照，不可直接当 fixture 写回 | `[实测: 只读打开]` |

### 4.2 表清单与关键字段（源码 schema，种子库实测行数）

> 行数来自 seed 库只读 `COUNT(*)`；`*_json` 列为 JSON 字符串；外键默认 `ON DELETE CASCADE`。分组按主题。

**课程内容**

| 表 | 关键字段 | seed 行数 |
|---|---|---|
| `chapters` | `id PK, number, title, source_path` | 13 |
| `sections` | `id PK, chapter_id FK→chapters, number, title` | 56 |
| `knowledge_points` | `id PK, chapter_id FK, section_id FK, name, name_en, definition, keywords_json, examples_json, non_examples_json, aliases_json, difficulty, competencies_json, decisions_json, source, status, parent_id` | 228 |
| `content_blocks` | `id PK, chapter_id FK, section_id, block_type, text, page, source, rights` | 413 |
| `content_tags` | `id PK, block_id FK, tag_type, tag_key, tag_role, confidence, method, evidence_span, evidence_start, evidence_end, review_status, evidence_level, version, reviewer_id, reviewed_at` | 654 |
| `ideology_points` | `id PK, name, definition, examples_json, non_examples_json, related_kp_ids_json, source` | 49 |
| `ideology_tags` | `id PK, target_type, target_id, ideology_id FK, confidence, evidence_span, rationale, review_status, evidence_level, version, reviewer_id, reviewed_at` | 393 |

**新闻与匹配**

| 表 | 关键字段 | seed 行数 |
|---|---|---|
| `news_articles` | `id PK, source, source_id, title, url(UNIQUE), author, published_at, summary, content, content_status, rights, fetched_at, content_hash, tag_content_hash` | 134 |
| `news_tags` | `id PK, article_id FK, tag_type, tag_key, tag_role, confidence, method, evidence_span, evidence_start, evidence_end, review_status, evidence_level, version, reviewer_id, reviewed_at` | 402 |
| `case_matches` | `id PK, article_id FK, kp_id FK, score, confidence, tag_role, evidence_span, evidence_start, evidence_end, rationale, method, created_at, review_status, evidence_level, version, reviewer_id, reviewed_at` | 402 |

**题目**

| 表 | 关键字段 | seed 行数 |
|---|---|---|
| `questions` | `id PK, source_type, source_id, type, stem, options_json, answer, explanation, difficulty, status, created_at` | 456 |
| `question_kps` | `(question_id FK, kp_id FK)` 复合 PK，`WITHOUT ROWID` | 461 |
| `question_ideology` | `(question_id FK, ideology_id FK)` 复合 PK，`WITHOUT ROWID` | 0 |
| `question_attempts` | `id PK, question_id FK, student_id, answer, feedback_json, score, created_at` | 0 |
| `question_bank` | `question_id PK, stem_hash(UNIQUE), stem, chapter_id, kp_ids_json, type, difficulty, source, usage_count, created_at, last_used_at` | 0 |

**调研 / BP / 画像 / 成长**

| 表 | 关键字段 | seed 行数 |
|---|---|---|
| `research_projects` | `id PK, student_id, brief, status, created_at, updated_at` | 0 |
| `research_artifacts` | `id PK, project_id FK, step, content_json, created_at` | 0 |
| `bp_projects` | `id PK, student_id, idea, status, created_at, updated_at` | 0 |
| `bp_sections` | `id PK, project_id FK, section, content, evidence_json, updated_at` | 0 |
| `student_profiles` | `id PK, name, cohort, created_at, profile_json, updated_at` | 1 |
| `competencies` | `id PK, name, definition, levels_json, observable_json, version, created_at` | 4 |
| `evidence` | `id PK, student_id FK, competency_id FK, level, strength, evidence_type, source_type, source_id, chapter_id, session_id, excerpt, rationale, confidence, method, review_status, review_note, occurred_at, created_at, metadata_json` | 9 |
| `growth_records` | `id PK, student_id FK, competency, level, evidence_json, created_at` | 0 |
| `growth_snapshots` | `id PK, student_id FK, chapter_id, checkpoint, competency_id FK, level, confidence, evidence_count, summary, created_at` | 8 |
| `learning_plan` | `id PK, student_id FK, chapter_id, phase, title, tasks_json, status, due_at, updated_at` | 39 |

**会话 / 记忆 / 产物 / 记账**

| 表 | 关键字段 | seed 行数 |
|---|---|---|
| `chat_sessions` | `id PK, student_id FK, chapter_id, title, created_at, updated_at` | 2 |
| `chat_messages` | `id PK, session_id FK, role, content, evidence_count, created_at, seq, turn_id, kind, payload_json`；`UNIQUE(session_id,seq)` | 8 |
| `turns` | `id PK, session_id, turn_id, status, plan_json, record_json, seq_start, seq_end, started_at, finished_at`；`UNIQUE(session_id,turn_id)` | 4 |
| `learning_states` | `(student_id, chapter_id) PK, phase, state_json, updated_at` | 0 |
| `memory_facts` | `id PK, student_id FK, kind, key, value_json, confidence, source, updated_at` | 10 |
| `memory_episodes` | `id PK, student_id FK, session_id, summary, decisions_json, open_questions_json, created_at` | 2 |
| `artifacts` | `id PK, student_id FK, session_id, skill_id, template_id, type, title, format, path, content, evidence_ids_json, created_at, content_json, schema_version, version, status, source_refs_json` | 4 |
| `skills` | `id PK, expert_id, name, description, input_schema_json, template_id, enabled, updated_at` | 0（服务构造时 upsert 内置定义，活库为 4） |
| `summary_ledger` | `(source_type, source_id) PK, source_seq, summarized_seq, source_hash, status, summary_id, attempts, last_error, updated_at` | 3 |
| `plugin_state` | `(plugin_id, key) PK, value_json, updated_at`，`WITHOUT ROWID` | 13 |
| `ingest_runs` | `id PK, source, started_at, finished_at, status, stats_json` | 4 |
| `kp_canonical_map` | `old_id PK, canonical_id, name, created_at` | 27 |
| `block_canonical_map` | `old_id PK, canonical_id, reason, created_at` | 327 |
| `source_runs` | **Python 侧建表**，活库独有：`id INTEGER PK, source, trigger, status, started_at, finished_at, duration_ms, fetched, inserted, updated, skipped, errors, failures` | 活库 0 行（表存在） |

### 4.3 seed 与历史快照实测基线（只读打开）

| 库 | 路径 | 大小 | user_version | journal_mode | 表数 | 备注 |
|---|---|---|---|---|---|---|
| 种子库 | `release/win-unpacked/resources/seed/learning.db` | 3,448,832 B | 7 | delete | 38 | 打包快照；目录内无 `-wal`/`-shm` 旁车文件 `[实测]` |
| 历史快照 A | `.scratch/desktop-20261019183452.db` | 2,588,672 B | 6 | delete | 38 | 旧 schema；可作升级/脏数据对照 `[实测]` |
| 历史快照 B | `.scratch/repo-20261019183452.db` | 3,072,000 B | 6 | delete | 38 | 旧 schema `[实测]` |
| 本机活库 | `.learning-agent/data/learning.db` | 6,074,368 B | 7 | wal | 39 | 含 `source_runs`；旁车 `-wal` 0 B、`-shm` 32,768 B `[实测]` |

> 只读打开方式（不写库、不复制覆盖）：Python `sqlite3.connect("file:<path>?mode=ro", uri=True)` + `PRAGMA query_only=ON`；或 Node `new DatabaseSync(path, { readOnly: true })`（参照 `.scratch/snapshot-db.mjs:3`）。禁止用 sqlite CLI 写库或把快照复制回 appHome。

### 4.4 配置与状态文件

| ID | 文件 | 结构 | 写入时机 / 编码 | 证据 |
|---|---|---|---|---|
| DATA-10 | `settings.json`：`<app.getPath('userData')>/settings.json`（Windows 默认 `%APPDATA%/<productName>/settings.json`，productName `营小商`；旧目录 `%APPDATA%/@learning-agent/desktop/settings.json` 仅作一次性迁移来源） | 存储形 `{apiKey, model}`；对外形 `{hasApiKey, model, apiKeySource:'env'|'stored'|'none', configError?}` | `learning:settings:set` → `SettingsStore.write`：`mkdirSync` 目录后写 `JSON.stringify(next,null,2)+"\n"`，**utf8 无 BOM**；读时先剥离首字符 BOM 再 `JSON.parse`；坏 JSON 不抛崩，记 `configError`，文件忽略 | `[源码:main/index.ts:58-65, settings.ts:19,37-45,67-84]`；BOM 断言见 `scripts/verify-settings-bom.ts:30-33,59` |
| DATA-11 | `window-state.json`：`<appHome>/window-state.json` | `{x:number,y:number,width:number,height:number,maximized:boolean}`；宽高下限 `MIN_WINDOW_WIDTH=760` / `MIN_WINDOW_HEIGHT=560` | resize/move 经 300ms debounce 保存；maximize/unmaximize/close 即时保存；读不到/损坏/不在任一显示器工作区内则返 `undefined` 回退默认边界；写失败静默忽略 | `[源码:main/window-state.ts:7-13,58-92,98-143]` |

**BOM / 编码结论（以 `scripts/verify-settings-bom.ts` 断言为准，不凭印象）**：

- 带 BOM 的合法 JSON 必须能读出 `apiKey`，且不报 `configError`（`verify-settings-bom.ts:30-33`）。
- 不带 BOM 老行为不坏（`:37-38`）；文件不存在不算错误、`hasApiKey=false`（`:41-43`）；坏 JSON 给 `configError` 且 `hasApiKey=false`（`:46-50`）。
- 写回一次后 BOM 必须消失、Key 保留（`:53-59`，断言 `raw.charCodeAt(0) !== 0xfeff`）；外部把坏文件改好后，下次读取 `configError` 被清掉（`:62-70`）。
- 注意例外：**题目导出 CSV 是故意带 BOM 的**（`packages/questions/src/index.ts:1023`，`\uFEFF` 前缀，Excel 兼容），不要按 settings 的「无 BOM」口径反推 CSV。

### 4.5 WAL/SHM 取证与清理

| ID | 规则 | 说明 |
|---|---|---|
| DATA-12a | 旁车文件名 | 主库 `learning.db` 同目录：`learning.db-wal`（写帧）、`learning.db-shm`（共享内存索引）；坏库重置时三者一并改名 `.broken-<ISO 时间戳>`（`main/index.ts:431-434`） |
| DATA-12b | 快照要带齐 | 取证复制时三件套一起拷；只拷主库可能漏掉尚未 checkpoint 的 WAL 帧，导致快照缺最新写入。最稳顺序：先正常关闭应用（触发连接关闭与 checkpoint），再复制目录；无法关应用时，连同 `-wal`/`-shm` 一起复制并标注「未 checkpoint」 |
| DATA-12c | 避免脏读 | 读快照用 `mode=ro`；活库正在被主进程/Python 子进程写入时，不要在另一进程直接拷贝主库后比对行数；需要一致性视图时等一轮写入结束（IPC resolve / 文件 mtime 变化）再读 |
| DATA-12d | 清理一并删 | 清理隔离 home 时，`data/` 下三件套全部删除；遗漏 `-wal`/`-shm` 会在下次打开时被旧帧复活，污染下一个用例 |
| DATA-15 | 清理与证据保留 | 用例结束先复制证据（db 三件套 + `artifacts/` + `exports/` + `window-state.json` + IPC 日志/截图），再删除整个隔离 home；`settings.json` 在 userData、不在 home，不随 home 删除（见 DATA-10 已知缺口）；可直接照抄的命令见第 5 节 |

### 4.6 产物与导出目录隔离

| ID | 目录 | 写入方 / 命名 | 测试隔离要点 |
|---|---|---|---|
| DATA-13a | `<appHome>/artifacts/<studentId>/<YYYY-MM>/<id>.<ext>` | `ArtifactService.create`；id `art_<Date.now 36 进制>_<uuid 前 8 位>`；`format=html` 直写 `.html`，否则先写 `.md`，`format=docx` 再写 `.docx`；落库 `artifacts.path` 记录实际路径 | 隔离 home 下整棵 `artifacts/` 随目录删除；断言用 `studentId` 子目录隔离用例；路径必须落在 `appHome/artifacts` 内，越界抛 `PATH_OUTSIDE_APP`（`artifacts/src/index.ts:114,178,191`） |
| DATA-13b | `<appHome>/exports/` | 题目：`questions-<ISO 时间戳，冒号点号替换为 ->.{json,csv,docx}`；BP：`bp-<safeId>-<ISO 时间戳>.{md,docx}`；`safeId` 把非 `[A-Za-z0-9_-]` 字符替换为 `_` | 文件名含时间戳，重复导出不覆盖；清理随 `exports/` 目录删除；CSV 带 BOM 属预期 |

## 5. 最小隔离运行组合（PowerShell，可直接照抄）（DATA-09、DATA-15）

> 前提：不在本仓库启动 GUI；以下只给环境坐标与临时目录建法，实际启动由测试 harness（Playwright/WebdriverIO/自定义驱动，见 `10-harness-strategy.md`）注入 electron 可执行文件。注释行按用例需要打开。

```powershell
# === 0. 隔离用例：所有路径落在临时目录，不碰 ~/.learning-agent 与真实 userData ===
$ErrorActionPreference = 'Stop'
$stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
$testHome = Join-Path $env:TEMP "yxs-test-$stamp"
New-Item -ItemType Directory -Force -Path $testHome, (Join-Path $testHome 'data') | Out-Null

# === 1. 数据根隔离（db / artifacts / exports / window-state.json 全部在此） ===
$env:LEARNING_AGENT_HOME = $testHome

# === 2. 新闻采集：禁止自动拉起子进程，固定空闲端口，只做健康检查 ===
$env:NEWS_CRAWLER_AUTOSTART = '0'
$env:NEWS_CRAWLER_PORT      = '8799'
$env:NEWS_CRAWLER_URL       = 'http://127.0.0.1:8799'
$env:LEARNING_AGENT_NEWS_REFRESH_MINUTES = '60'   # 调大，避免后台轮询干扰断言
# 以下仅在允许 autostart 时才有意义；隔离用例保持默认即可，不必设置：
# $env:NEWS_CRAWLER_DIR    = 'E:\Documents\GitHub\YingXiaoShang\services\news-crawler-py'
# $env:NEWS_CRAWLER_VENV   = 'E:\Documents\GitHub\YingXiaoShang\.venv'
# $env:NEWS_CRAWLER_PYTHON = ''
# $env:NEWS_CRAWLER_WORKERS = '2'

# === 3. 渲染层：打包/冒烟不设 ELECTRON_RENDERER_URL（走 loadFile）；dev 联调才设 ===
# $env:ELECTRON_RENDERER_URL = 'http://127.0.0.1:5173'

# === 4. LLM：离线用例不要设 Key；在线用例按需注入 ===
# $env:DEEPSEEK_API_KEY = 'sk-...'
# $env:DEEPSEEK_MODEL   = 'deepseek-chat'
# $env:DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

# === 5. 启动（由 harness 完成；坐标示例） ===
#   Playwright: _electron.launch({ args: ['.'], env: <上述环境变量> })
#   自定义驱动: spawn(electronPath, ['.'], { env: process.env, stdio: [...,'ipc'] })

# === 6. 取证（关闭应用之后再做；三件套带齐） ===
$evidence = Join-Path $env:TEMP "yxs-evidence-$stamp"
Copy-Item -Recurse $testHome $evidence
# 留存：$evidence\data\learning.db{,-wal,-shm}、artifacts\、exports\、window-state.json
# 另行留存：IPC payload 日志、截图、终端日志（由 harness 写进 $evidence）

# === 7. 清理 ===
# 7a. 删隔离 home（db 三件套、artifacts、exports、window-state.json 一并删除）
Remove-Item -Recurse -Force $testHome
# 7b. 证据目录默认保留；确认归档后再删：
# Remove-Item -Recurse -Force $evidence
```

**组合要点与含义**：

- `NEWS_CRAWLER_AUTOSTART=0`：主进程跳过 spawn，仅对 `NEWS_CRAWLER_URL` 做 1.5 秒超时健康检查；探活失败只告警，不阻塞启动（`news-backend.ts:97-115,19-29`）。只要设置了 `NEWS_CRAWLER_URL`，同样不会拉起子进程。
- 端口选择：避开默认 `8788`（桌面后端）与 news 包默认 `8787`；示例 `8799`。若本机已有旧测试进程占用，换 `8800` 等并同步改 `URL`。
- `LEARNING_AGENT_HOME` 同时被 db 与 window-state 读取；`homedir()` 回退只在未设该变量时生效，Windows 下取 `USERPROFILE`。
- **已知缺口**：`settings.json` 在 Electron `userData` 下，`LEARNING_AGENT_HOME` 不重定向它；隔离用例之间的 API Key / model 仍可能互相影响。当前源码未见 userData 环境覆盖入口 `[源码]`；验证方法见第 7 节。

## 6. 造数据方案对比（不启动 GUI 预置可用数据）

| ID | 方案 | 做法 | 可行性 | 风险 / 注意 |
|---|---|---|---|---|
| DATA-14a | 复制 seed 库 | 启动前把 `release/win-unpacked/resources/seed/learning.db` 拷到 `<testHome>/data/learning.db`（不带旁车文件）；应用见库已存在即不再复制 seed | **高**：schema v7、章节/KP/题目/思政点齐全；与冒烟健康断言（13 章 / 228 KP）对齐 | seed 自带 1 个 demo 画像、4 条产物、少量记忆/快照，不是空库；需要干净画像时另删 `student_profiles` 相关行（注意外键级联）；复制时目标目录 `data/` 须先建好；不要把 `.scratch` 旧 v6 快照当 seed 复制（会触发迁移，且行数口径不同） |
| DATA-14b | 直接 SQL 插入 | 对复制来的库（或空库迁移后的库）用 `node:sqlite` / Python sqlite3 写入：章节→小节→KP→题目→证据等按外键顺序；JSON 字段按字符串序列化；遵守 STRICT 类型与 `status/difficulty` 取值域 | 中：可控、可重复、不依赖 LLM；适合构造边界样本（缺选项题目、越界难度、悬空引用的反例） | 绕开服务层校验（`validateQuestion`、containment、id 规范、`profile_json` 形状），可能造出服务层视为非法的行；插入前确认 `application_id` 与 `user_version`；写后建议 checkpoint（关闭连接或 `PRAGMA wal_checkpoint(TRUNCATE)`）再交 harness 打开；关联表走复合 PK / `WITHOUT ROWID` |
| DATA-14c | 经 IPC / 服务方法生成 | 隔离 home 启动应用，通过 `learning:invoke` / `learning:chat` 调出题、调研、BP、证据抽取等方法落库 | 最贴近真实路径：行经过服务校验与默认值填充 | 依赖 LLM 可达（questions 有离线兜底，research/bp 无兜底）；内容不确定，只能断言结构；异步链路（news refresh 入队、backfill 补标注）有时序；成本最高，适合端到端冒烟，不适合批量 fixture |
| DATA-14d | 复用 pipeline 脚本重建 seed | `pipeline/seed-db.ts` 从 `data/normalized/*.json|jsonl` 重建库；`pipeline/seed-student.ts` 从 `data/students/student_demo/*.yaml` 写画像；`RESET_DB=1` 先清空领域数据 | 仅用于维护种子库本身，不建议测试时跑 | 依赖仓库 `data/normalized` 素材与 Node/tsx 环境；可能调 LLM 打标（`CONTENT_TAGS_LLM=1` 且有 Key 才开）；产物是开发库口径，不是用例 fixture |

## 7. 风险与坑

1. **`settings.json` 不在隔离 home 内**：`LEARNING_AGENT_HOME` 只重定向 db/产物/window-state；settings 走 `userData`。多个并行用例若都读写设置，会共享同一份 `apiKey/model`；当前源码未见覆盖 userData 的环境入口 `[源码:main/index.ts:58]`。
2. **无种子安装包的首启分叉**：`apps/desktop/seed/` 在仓库不存在，`electron-builder.yml` 却引用 `seed/learning.db`；若打包时资源缺失，首启复制不到 seed，`LearningDb` 建空库并迁移，章节/KP 为 0，界面能打开但 `startupHealth` 告警（`health.ts:26-30`）。重新打包后必须核对 `resources/seed/learning.db` 存在且 `user_version=7` `[源码 + 实测现状]`。
3. **双写同一 SQLite**：主进程与 Python 子进程共享 `<appHome>/data/learning.db`；`busy_timeout=5000` 之外，长时间写事务与读快照仍可能互相阻塞。隔离用例 `AUTOSTART=0` 可消除子进程写；在线用例断言新闻行数时要等写入信号，不能以 invoke resolve 为准 `[源码:db/index.ts:834, news-backend.ts:100]`。
4. **WAL 旁车遗漏导致脏复活**：清理只删主库、留下次打开时旧 `-wal`/`-shm` 会恢复旧帧；快照只拷主库则缺最新帧。取证与清理都必须三件套同进同出 `[源码:db/index.ts:833]`；`[实测: 活库 wal 0 B / shm 32768 B]`。
5. **迁移版本与快照版本错位**：`.scratch` 两份快照是 v6；直接拷进 v7 代码的 appHome 会走 M6→M7 迁移。迁移虽有事务包裹，但测试基线应固定用 v7 seed，旧快照只用于只读对照 `[源码:db/index.ts:915-938]`。
6. **CSV BOM 与 settings 无 BOM 是两套口径**：题目导出 CSV 故意带 BOM，settings 写回刻意去 BOM；断言文件编码时按目录/用途区分，不要统一套用 `[源码:questions/index.ts:1023, settings.ts:80]`。
7. **路径闸门外的目录越权**：artifacts/exports 都在 appHome 内做 `isPathUnder` 复核；但 fixture 脚本若直接 SQL 写 `artifacts.path` 字段，绕过了服务层校验，可能记录库外路径，读取侧 `files.preview` 仍按该路径读文件 `[源码:artifacts/index.ts:114,178]`；造数时 `path` 字段必须与实际落盘位置一致。

## 8. 未覆盖与待验证

1. **`userData` 在本机的真实解析目录未实测**：源码 `app.getPath('userData')` 默认取 `appData/<productName>`；本机 `%APPDATA%` 下未发现 `营小商` / `@learning-agent` 目录（未启动应用）。验证方法：隔离 home 启动一次后，检查 `%APPDATA%` 下新建目录名与 `settings.json` 落位；确认是否存在可重定向 userData 的环境变量入口。
2. **旧 v6 快照的升级路径未实跑**：只读核对了 `user_version=6` 与表结构；M6→M7 迁移（含 `news_articles` 哈希列与索引）在真实旧库上的结果未验证。验证方法：临时复制一份 `.scratch/repo-20261019183452.db` 到隔离 home 的 `data/`，启动后只读核对 `user_version=7`、`news_articles.tag_content_hash` 列与索引存在。
3. **空库首启（无 seed）路径未实跑**：源码推断为建空库 + 迁移 + 健康告警；未在隔离环境构造「两个 seed 候选都缺失」的打包产物验证界面与告警文案。验证方法：隔离 home 留空、指向无 seed 的 `resourcesPath` 启动，记录 `learning:health` 返回的 warnings/notices。
4. **Python 子进程建表 `source_runs` 的完整 DDL 与索引归属**：字段与索引来自活库只读观察；建表语句在 `services/news-crawler-py` 侧，本篇未展开（归 06 文档）。验证方法：对照 Python 侧迁移/建表代码核对列类型与 `source_runs_by_source/source_runs_by_started` 索引。
5. **并行用例的 settings 共享范围**：未验证两个隔离 home 同时跑时 `settings.json` 是否互相覆盖、`apiKeySource` 判定是否受环境变量影响。验证方法：双临时 home 并行启动，分别 `learning:settings:get` 对照 `hasApiKey/apiKeySource`。
6. **`resetDomainData()` 在测试中的可用性**：源码提供清空领域表方法，但桌面 IPC 未暴露对应通道；测试能否直接在 Node 侧实例化 `LearningDb` 调用来清库，取决于 harness 能否加载主进程模块。验证方法：在 harness 的主进程 evaluate 上下文里探测该方法可用性，再决定清理走「删目录」还是「服务清空」。

## 9. 交叉引用

- 启动装配、服务单例与坏库重置流程：`02-main-runtime-and-boot.md`
- IPC 通道与 `learning:settings:get/set`、`learning:health` 契约：`03-ipc-and-preload-contract.md`
- 打包资源、`extraResources` 与三条启动路径的路径差异：`05-build-package-and-first-run.md`
- Python 采集服务端口、健康检查、离线降级与同库双写：`06-news-sidecar-and-network.md`
- 领域服务输入输出与确定性分级：`07-domain-services-and-determinism.md#22-依赖面与确定性总表`
- 既有校验脚本（含 `verify-settings-bom.ts`）与历史驱动：`09-existing-verification-and-gaps.md`
- harness 启动配置、fixture/等待/截图/日志方案：`10-harness-strategy.md`
- 场景用例对 DATA 事实的引用：`11-scenario-catalog.md`
