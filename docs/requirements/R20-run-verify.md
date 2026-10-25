# R20 运行与验收

> 状态：MVP（本轮）
> 依赖：R01–R19（全部需求都靠这套命令跑起来验收）
> 代码：`package.json`、`apps/desktop/package.json`、`scripts/package-desktop.mjs`、`package.cmd`、`pipeline/`
> 上位原则：[`../principles/single-agent.md`](../principles/single-agent.md)

## 1. 要什么（学生可见结果）

- 一条命令装依赖，一条命令起桌面端，一条命令出安装包。
- 首次使用自动有课程数据和演示学生，不需要手工灌库。
- 装出来的软件双击就能开，第一次启动自动准备数据目录，不出现空白页。
- 出问题时能定位到「哪条命令、哪一步」；不需要读构建日志猜。

## 2. 落位（提示词 / 工具 / skill / 数据）

属于**工程流程**，不是产品功能。落位约束：

- 只保留三类脚本：启动（`dev:desktop`、`dev:web`）、构建（`build`、`build:desktop`、`typecheck`）、打包（`package:desktop`、`package.cmd`）。
- 数据准备属于流水线（`pipeline:*`），不在验收路径上；验收只需要 `db:seed` 与 `db:seed:student`。
- **不允许**用假模型/桩回复写「行为测试」：断言假回复等于测桩，不测产品（历史 `scripts/test-*.ts` 已全部删除）。
- 行为验收 = 真 Key 真跑一轮，看界面、看产物文件、看数据目录。

## 3. 行为（一轮里怎么发生）

1. `pnpm install`：按 `pnpm-workspace.yaml` 装 `packages/*`、`profiles/*`、`apps/*`；`packageManager` 固定 `pnpm@11.28.5`。
2. `pnpm run build`：`pnpm -r build`，把每个包编到 `lib/`；桌面端主进程从 `lib/` 引工作区包，所以必须先编包（`scripts/package-desktop.mjs:79-81` 注释）。
3. `pnpm run typecheck`：三面检查——根 `tsc -b`、`pipeline/tsconfig.json`、`apps/desktop` 的 `tsc --noEmit`（`package.json:11`）。
4. `pnpm run db:seed`：读 `data/normalized/` 灌课程、知识点、教材块、题库、新闻、意识形态；`pnpm run db:seed:student` 初始化演示学生、能力、计划、证据、记忆（`pipeline/seed-db.ts`、`pipeline/seed-student.ts`）。
5. `pnpm run dev:desktop`：`electron-vite dev` 起主进程 + 渲染层；开发态 `LEARNING_AGENT_HOME` 默认 `<repo>/.learning-agent`（`apps/desktop/electron.vite.config.ts:7`）。
6. `pnpm run build:desktop`：`electron-vite build`，产物在 `apps/desktop/out/`。
7. `pnpm run package:desktop`：编包 → 造种子库（`VACUUM INTO`）→ `electron-builder --win nsis` → 输出 `release/`；结束后删掉 `apps/desktop/seed/`（`scripts/package-desktop.mjs:32-86`）。
8. 安装包首次启动：从 `resources/seed/learning.db` 复制到 `~/.learning-agent/data/learning.db`（`apps/desktop/src/main/index.ts:66-76`）。

## 4. 契约（工具签名、数据结构、字段、命令）

**命令表（根目录执行）**

| 命令 | 作用 | 前置 | 可观察结果 |
|---|---|---|---|
| `pnpm install` | 装依赖 | Node `^22.19.0 \|\| >=24`、pnpm 11 | `node_modules/` 就绪 |
| `pnpm run typecheck` | 三面类型检查 | 依赖已装 | exit 0 |
| `pnpm run build` | 编译所有工作区包 | 依赖已装 | 各包 `lib/` 有产物 |
| `pnpm run build:desktop` | 编译桌面端 | 已跑 `build` | `apps/desktop/out/{main,preload,renderer}` |
| `pnpm run dev:desktop` | 开发态启动三栏界面 | 已灌库 | 窗口出现，左栏有章节 |
| `pnpm run db:seed` | 灌课程数据（非破坏） | `data/normalized/` 存在 | 打印 `{ appHome, db, chapters, ... }` |
| `pnpm run db:seed:student` | 初始化演示学生 | 已跑 `db:seed` | 打印 `{ student: 'student_demo', evidence_total, ... }` |
| `pnpm run package:desktop` | 出 Windows 安装包 | 依赖已装 | `release/营小商 Setup <version>.exe` |
| `package.cmd` | 双击等价于上一条 | 同左 | 同上，失败时暂停显示 exit code |
| `pnpm run dev:web` | DSH profile 调试 | — | 浏览器界面；不是产品入口 |

**环境变量**

- `LEARNING_AGENT_HOME`：数据目录。命令行与桌面端要共享进度必须显式设同一个值。
- `DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`、`DEEPSEEK_BASE_URL`：见 [R18](R18-model-runtime.md)。
- `LEARNING_AGENT_SAMPLE_HOME`：打包时优先取用的录制示例库（`scripts/package-desktop.mjs:34`）。

**产物位置**

- 开发编译：`apps/desktop/out/`
- 安装包与解包目录：`release/`（`electron-builder.yml:5` 的 `output: ../../release`）
- 运行时数据：`<LEARNING_AGENT_HOME>/{data,artifacts,exports,raw,spill}`（见 [R17](R17-local-data.md)）

**`scripts/` 保留清单**

| 文件 | 用途 |
|---|---|
| `scripts/package-desktop.mjs` | 打包入口（构建 + 种子库 + NSIS） |
| `scripts/dev-web.ts` | DSH web 调试启动 |
| `scripts/install-profile.ts` | 把 `profiles/learning-agent` 装到 `~/.dsh/profiles`（`profile:install`） |

没有测试脚本、没有假模型脚本、没有一次性迁移脚本。

## 5. 边界（不做什么、失败怎么表现）

- 不做 CI 矩阵、不做快照测试、不做覆盖率；只验「能编译 + 真跑一轮」。
- 不在仓库里提交 `release/`、`.learning-agent/`、`apps/desktop/out/`、`apps/desktop/seed/`（均在 `.gitignore`）。
- 容器部署、Linux/macOS 安装包不在本轮范围。
- 失败表现：
  - `typecheck` 失败：非 0 退出，报文件与行号；不生成产物。
  - `build:desktop` 在未跑 `build` 时失败：报找不到工作区包入口；先 `pnpm run build`。
  - `db:seed` 在 `data/normalized/chapters.json` 为空时直接报错并提示先跑 `pipeline:resources`（`pipeline/seed-db.ts:74-76`）。
  - 打包失败：`package-desktop.mjs` 抛错并带命令与退出码；`package.cmd` 暂停显示 exit code。
  - 没配 Key：桌面端能启动、能读课程，聊天给中文提示（见 [R18](R18-model-runtime.md) 第 5 节）。

## 6. 验收（场景 → 期望）

1. **冷启动可复现**：
   ```sh
   pnpm install
   pnpm run db:seed
   pnpm run db:seed:student
   pnpm run dev:desktop
   ```
   期望：窗口出现，左栏有 13 章、第 4 章可选；发送一句话能收到流式回答（真 Key）；数据写在 `<repo>/.learning-agent/data/learning.db`。

2. **编译门禁**：`pnpm run typecheck` 与 `pnpm run build` 均 exit 0；`pnpm run build:desktop` 在 `build` 之后 exit 0，`apps/desktop/out/renderer/index.html` 存在。

3. **安装包可交付**：`pnpm run package:desktop`（或双击 `package.cmd`）→ `release/` 出现 `营小商 Setup 0.1.0.exe` 与 `win-unpacked/`；双击安装后启动，首次自动生成 `~/.learning-agent/data/learning.db`，界面能打开已有课程。

4. **命令行与桌面端共享进度**：
   ```sh
   LEARNING_AGENT_HOME="$PWD/.learning-agent" pnpm run db:seed:student
   LEARNING_AGENT_HOME="$PWD/.learning-agent" pnpm run dev:desktop
   ```
   期望：桌面端看到同一份学生档案与记忆；不设变量时种子脚本写 `<repo>/.learning-agent`（`pipeline/env.ts:10-11`），桌面端开发态也是同一目录，因此默认也能对上。

5. **真跑一轮行为**（不用假模型）：要一份「能带走的」产物 → 右栏出现 HTML 附件，`<home>/artifacts/<studentId>/<YYYY-MM>/` 下出现文件；要一组题 → 题目集附件可作答并落 `question_attempts`。

6. **`scripts/` 干净**：`ls scripts` 只有 3 个文件；全仓搜 `test-` 无假模型测试脚本。

## 7. 现状与差距（代码事实）

| 事实 | 位置 |
|---|---|
| 根命令清单（build / typecheck / dev / seed / package） | `package.json:9-25` |
| `typecheck` 覆盖三面 | `package.json:11` |
| `build` 递归编所有包 | `package.json:10` |
| `build:desktop` 只编桌面端 | `package.json:22`、`apps/desktop/package.json:11` |
| `dev:desktop` 走 electron-vite dev | `package.json:21` |
| 打包脚本先 `pnpm build` 再 seed 再 electron-builder | `scripts/package-desktop.mjs:79-84` |
| 种子库用 `VACUUM INTO` 取一致副本 | `scripts/package-desktop.mjs:52-58` |
| 打包后删除 `apps/desktop/seed/` | `scripts/package-desktop.mjs:84` |
| 安装包输出目录 `release/` | `apps/desktop/electron-builder.yml:5` |
| 当前 `release/` 已有 `营小商 Setup 0.1.0.exe`、`win-unpacked/` | 本地实测（2026-10-25） |
| `scripts/` 只剩 3 个工具 | `scripts/` 目录 |
| 无假模型测试脚本 | `scripts/` 无 `test-*`；`README.md` 的 Verification 节有说明 |

差距：

1. **`build:desktop` 单独跑会踩空**：它不编工作区包，而主进程从各包 `lib/` 引入；新克隆仓库必须先 `pnpm run build`。README 的 Run 一节没写这个前置。
2. **`dev:desktop` 前置没写**：没灌库时界面能开但没章节，容易被当成 bug；应在 README 与本文都强调先跑两条 seed。
3. **打包依赖本地 `.scratch`**：`package-desktop.mjs:34-47` 优先用 `.scratch/sample-home` 的录制库；没有录制库时新 seed，**不含示例对话**，但构建仍成功——同一个命令产出两种内容，验收时容易误判。
4. **打包仍收死资产**：`electron-builder.yml:9` 的 `templates/**` 与 `apps/desktop/templates/` 对应已无活调用方的 `ArtifactService.renderTemplate()`。
5. **临时配置文件残留**：`apps/desktop/electron.vite.config.1792592624345.mjs` 存在（被 `.gitignore` 的 `electron.vite.config.*.mjs` 覆盖），属于构建工具残留。
6. **没有一条命令做完整验收**：`typecheck` 与 `build` 分离，打包不跑 typecheck；需要人工按第 6 节顺序执行。
7. **`README.md` 的 Verification 与 `package.json` 有漂移风险**：README 写 `pnpm run db:seed` 默认灌到哪、`dev:desktop` 用哪个 home，依赖读者自己拼 `electron.vite.config.ts:7` 与 `pipeline/env.ts:10-11` 两条默认值。
8. **安装包版本号来自 `apps/desktop/package.json:4`**（`0.1.0`），文件名随之变化；验收时不要写死文件名，按 `release/*.exe` 匹配。

## 8. MVP 范围与后续

**MVP 做到哪**

- 六条命令（install / typecheck / build / build:desktop / dev:desktop / package:desktop）与两条种子命令可复现。
- `scripts/` 只留启动与打包工具，无假模型测试。
- 安装包输出到 `release/`，首启自动准备数据目录。
- 行为验收靠真跑，见第 6 节六条。

**后续**

- 一条 `pnpm run verify` 串起 typecheck + build + 打包冒烟（只检查产物存在与首启能开，不做假模型断言）。
- 打包时把「是否含示例对话」写进产物元数据（或在控制台明确标注），避免两种种子库混淆。
- 清理 `templates/**` 打包项与临时 config 文件，缩小安装包。
- 在 README 的 Run 一节补上 `pnpm run build` 前置与 `LEARNING_AGENT_HOME` 对齐说明。

**明确不做**

- CI 服务、自动化 UI 测试、覆盖率门槛。
- 假模型/桩回复的「行为测试」。
- 容器化、自动更新、多平台安装包（本轮只做 Windows NSIS）。

相关：[R17 本地数据](R17-local-data.md)、[R18 模型运行时](R18-model-runtime.md)、[R19 品牌与文案](R19-brand-copy.md)。
