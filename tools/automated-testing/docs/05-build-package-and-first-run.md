# 05 · electron-vite 构建、electron-builder 打包与首启自举

> 归属：构建/打包链路（`apps/desktop/`、`scripts/package-desktop.mjs`、`release/`）｜ 状态：已完成 ｜ 核对日期：2026-11-18
> 覆盖：`apps/desktop/electron.vite.config.ts`、`apps/desktop/electron-builder.yml`、`apps/desktop/package.json`、根 `package.json`、`scripts/package-desktop.mjs`、`scripts/verify-package.mjs`、`apps/desktop/out/`、`release/win-unpacked/` 实测目录
> 不覆盖：Python 采集服务打包与运行契约（见 `06-news-sidecar-and-network.md`）；DB 表结构与种子库内容（见 `08-data-fixtures-and-isolation.md`）；既有验证脚本清单（见 `09-existing-verification-and-gaps.md`）；测试驱动 launch 配置（见 `10-harness-strategy.md`）
> 行号截至 2026-11-18。证据等级：`[源码]` 读代码并附 `文件:行`；`[实测]` 本次在仓库目录真实观测；`[日志]` 取自仓库内既有日志；`[待验证]` 推断/未运行，附验证步骤。

## 1. 结论摘要（TL;DR）

1. electron-vite 分 main / preload / renderer 三段构建，产物落在 `apps/desktop/out/{main,preload,renderer}/`；`electron`、`playwright`、`playwright-core` 标为 external，不打进 bundle `[源码]`。
2. electron-builder 开 `asar: true`，`files` 只收 `out/**`、`templates/**`、`package.json`；种子库与提示词走 `extraResources` 放在 asar 外 `[源码]`。
3. dev / preview / packaged 三条路径的 `app.getAppPath()`、`process.resourcesPath()`、`process.cwd()`、`__dirname`、`LEARNING_AGENT_HOME` 缺省值、提示词根、renderer 加载方式各不相同；完整矩阵见 2.1，运行时路径字符串除产物目录外均未实测 `[待验证]`。
4. **`apps/desktop/seed/` 在仓库中不存在（实测 False），但 `release/win-unpacked/resources/seed/learning.db` 存在（实测 True，3,448,832 字节）**；种子库由 `scripts/package-desktop.mjs` 在打包前生成、打包后删除该目录 `[源码][实测]`。
5. 绕过 `package-desktop.mjs` 直接跑 `electron-builder` 时，种子源缺失；electron-builder 对缺失源是报错还是静默省略未实测 `[待验证]`；若省略，首启会走「空库建表」分叉，`startupHealth` 报章节 0 告警 `[源码]`。
6. 首启自举只有三分叉：已有 DB 不动种子；无 DB 且找到种子则复制；无 DB 且无种子则由 DB 构造器建空库并跑空 SCHEMA `[源码]`。
7. asar 内代码（main/preload/renderer/模板）不能用普通磁盘工具直接列目录；asar 外的种子库与提示词可直接磁盘读取。测试取证在 dev/preview 读 `out/`，在 packaged 必须先解 asar 或经主进程读取 `[源码][实测]`。
8. 工具链存在版本不一致：根声明 `packageManager: pnpm@11.28.5`，本机实测 pnpm 11.22.0、Node v22.23.2；Electron 实测 44.9.0、electron-vite 4.0.1、electron-builder 26.15.3 `[源码][实测]`。

## 2. 结构与流程

### 2.1 三启动路径路径解析差异矩阵（完整矩阵）

> 路径基准：仓库根 `E:\Documents\GitHub\YingXiaoShang`。「应用目录」指 Electron 解析 `app.getAppPath()` 时的基准目录。运行时具体字符串未在本机启动观察，凡未实测处标 `[待验证]`，验证方法见第 6 节。

| 维度 | dev（`electron-vite dev`） | preview（`electron-vite preview`） | packaged（`win-unpacked` 与 NSIS 安装后） |
|---|---|---|---|
| 触发命令 | `pnpm --dir apps/desktop dev` → `electron-vite dev` `[源码 apps/desktop/package.json:10]` | `pnpm --dir apps/desktop start` → `electron-vite preview` `[源码 apps/desktop/package.json:12]` | 运行 `release/win-unpacked/营小商.exe`，或运行 NSIS 安装包后从快捷方式启动 `[实测 release/win-unpacked/营小商.exe 247,185,408 字节]` |
| `app.getAppPath()` | 入口为 `.`，应用目录为 `apps/desktop`（含 `package.json`，`main=out/main/index.js`）`[源码 electron-vite startElectron 传 entry '.'；待验证运行时字符串]` | 同 dev：`apps/desktop` `[源码；待验证]` | `resources/app.asar`（builder 把 `out/**` 打入 asar）`[源码 electron-builder.yml:7-10；待验证运行时字符串]` |
| `process.resourcesPath` | dev 下 Electron 二进制来自 `node_modules/electron/dist`，resourcesPath 为其 `resources/` 子目录 `[源码 Electron 约定；待验证]` | 同 dev `[源码；待验证]` | `resources/`（实测该目录含 `app.asar`、`seed/`、`prompts/`、`default_app.asar`、`elevate.exe`）`[实测]` |
| `process.cwd()` | 继承自 electron-vite 父进程，即 `apps/desktop`（spawn 未传 `cwd`）`[源码；待验证]` | 同 dev `[源码；待验证]` | 取决于启动器：资源管理器/快捷方式通常为安装目录；`verify-package.mjs:32` 显式以拷贝目录为 cwd spawn `[源码]`；安装后快捷方式的 cwd `[待验证]` |
| `__dirname` / 模块解析基准 | main bundle 位于 `apps/desktop/out/main/index.js`；ESM shim 由 `import.meta.url` 推导 `__dirname` → `out/main` `[源码 electron-vite esmShimPlugin；out 目录实测存在]` | 同 dev，`out/main` `[源码]` | asar 内 `app.asar/out/main`（asar-aware 路径，由 Electron asar 感知层解析）`[源码；待验证]` |
| `LEARNING_AGENT_HOME` 缺省值 | `electron.vite.config.ts:7` 配置加载时 `||= resolve('../../.learning-agent')`，相对 cwd `apps/desktop` 解析为仓库根 `.learning-agent` `[源码]`；主进程回退链 env || `~/.learning-agent` `[源码 window-state.ts:24-26]`；配置侧 env 经 spawn 继承到 Electron 子进程 `[待验证]` | preview 内 `build()` 会加载配置文件，第 7 行副作用在父进程执行后继承 `[源码；待验证]` | 无配置副作用；env || `~/.learning-agent` `[源码 window-state.ts:24-26]` |
| 提示词根集合（`LEARNING_AGENT_PROMPT_ROOTS` 实际拼接） | `[<resourcesPath>/prompts, <getAppPath>/../../packages/agent]`，`;` 分隔 `[源码 index.ts:52-55]`。第一根指向 electron dist/resources/prompts（仓库内不存在）；第二根解析为 `packages/agent`（实测存在）`[实测]` | 同 dev 拼接；第二根 `packages/agent` 存在 `[源码][实测]` | 第一根 `resources/prompts`（实测含 `agents/`、`references/`）；第二根 `app.asar/../../packages/agent` 即 `resources/packages/agent`，未打包、不存在 `[源码 index.ts:52-55；实测 resources 树]` |
| renderer 加载方式 | `loadURL(ELECTRON_RENDERER_URL)`，dev server `http://localhost:5173/` `[源码 index.ts:154-155；日志 .scratch/dev-desktop.log:48-50]` | 无 `ELECTRON_RENDERER_URL`（该变量仅 dev 流程设置）→ `loadFile(out/renderer/index.html)` `[源码 index.ts:157；electron-vite lib-B4dCEySN.js:67]` | `loadFile(app.asar/out/renderer/index.html)`；`verify-package.mjs:53-59` 实测断言 file:// URL 位于拷贝目录内 `[源码][实测]` |

补充事实：

- `ELECTRON_RENDERER_URL` 只在 electron-vite 的 dev 流程里，renderer dev server `listen()` 之后写入进程环境（`node_modules/.../electron-vite/dist/chunks/lib-B4dCEySN.js:67`）；preview 路径不创建 dev server（`lib-EqoA0Jso.js:15-22`）`[源码]`。
- 主进程选择加载方式的判定不看 `app.isPackaged`，只看 `process.env.ELECTRON_RENDERER_URL` 是否存在（`apps/desktop/src/main/index.ts:154-158`）`[源码]`。

### 2.2 electron-vite 三段构建

| 段 | 配置位置 | 产物（实测） | 备注 |
|---|---|---|---|
| main | `electron.vite.config.ts:35-43`，output `es`，external = `EXTERNAL` | `out/main/index.js`（实测 2,518,028 字节，bundle 70,232 行）；`out/package.json`（25 字节） | `emitMainPackageJson()` 在 `closeBundle` 写出 `out/package.json`（仅版本号），供依赖包 `createRequire(import.meta.url)` 读版本 `[源码 electron.vite.config.ts:14-23]` |
| preload | `electron.vite.config.ts:44-50`，external `electron` | `out/preload/index.mjs`（实测 998 字节） | 源文件 `src/preload/index.ts` 44 行，`contextBridge.exposeInMainWorld('learning', …)`，暴露面归 03 文档 `[源码]` |
| renderer | `electron.vite.config.ts:51-53`，React 插件 | `out/renderer/index.html` + `assets/index-DKLC_uR-.js`（1,049,891 字节）+ `assets/index-CkzcuoPp.css`（3,206 字节） | HTML 内资源引用为相对路径 `./assets/…`，支持 file:// 加载 `[实测 out/renderer/index.html]` |

`EXTERNAL = ['electron', 'playwright', 'playwright-core']` `[源码 electron.vite.config.ts:32]`；playwright 在应用内懒加载，缺浏览器时需优雅降级（行为细节见 `07-domain-services-and-determinism.md` 与 `10-harness-strategy.md`）。

### 2.3 electron-builder / NSIS 产物布局

| 配置项 | 值 | 位置 |
|---|---|---|
| appId / productName | `com.learningagent.yingxiaoshang` / `营小商` | `electron-builder.yml:2-3` |
| 输出目录 / buildResources | `../../release` / `build` | `electron-builder.yml:4-6` |
| `files` | `out/**`、`templates/**`、`package.json` | `electron-builder.yml:7-10` |
| `extraResources` | 三条，见 2.4 | `electron-builder.yml:12-20` |
| asar / 压缩 | `asar: true` / `compression: maximum` | `electron-builder.yml:21-22` |
| 语言 | 仅 `zh-CN`、`en-US` | `electron-builder.yml:24-26` |
| NSIS | `oneClick: false`、`allowToChangeInstallationDirectory: true`、`shortcutName: 营小商` | `electron-builder.yml:27-33` |

实测 `release/`：`营小商 Setup 0.1.0.exe`（113,441,714 字节）、`win-unpacked/`、`builder-debug.yml`；`win-unpacked/resources/` 实测含 `app.asar`（65,354,162 字节）、`default_app.asar`、`elevate.exe`、`seed/`、`prompts/` `[实测]`。

### 2.4 `extraResources` 逐条一致性核实

| # | yml `from`（相对 `apps/desktop`） | yml `to`（相对 `resources/`） | 仓库源实测 | 打包产物实测 | 证据等级 |
|---|---|---|---|---|---|
| 1 | `seed/learning.db` | `seed/learning.db` | `apps/desktop/seed/learning.db` **不存在**（`Test-Path` = False） | `release/win-unpacked/resources/seed/learning.db` **存在**，3,448,832 字节 | 源缺失 `[实测]`；产物存在 `[实测]`；yml 条目 `[源码 electron-builder.yml:13-14]` |
| 2 | `../../packages/agent/agents` | `prompts/agents` | `packages/agent/agents` 存在 | `resources/prompts/agents/mentor.md` 等存在 | `[源码 electron-builder.yml:17-18][实测]` |
| 3 | `../../packages/agent/references` | `prompts/references` | `packages/agent/references` 存在 | `resources/prompts/references/` 下 7 个 md（artifact-schemas / case-playbook / competency-rubric / counterexample-playbook / question-playbook / research-bp-playbook / teaching-playbook） | `[源码 electron-builder.yml:19-20][实测]` |

**种子库为什么仓库里没有、产物里却有（三段式结论）**

- **影响面**：种子库不是仓库静态文件，而是打包流水线产物。`scripts/package-desktop.mjs:18` 把目标写为 `apps/desktop/seed/learning.db`；`buildSeedDatabase()`（`package-desktop.mjs:32-61`）优先用 `.scratch/sample-home/data/learning.db`（实测存在），否则跑 `db:seed` + `db:seed:student` 生成；经 `VACUUM INTO` 写出一致副本；electron-builder 跑完后，`package-desktop.mjs:84` 删除 `apps/desktop/seed` 目录。因此干净检出里永远看不到 seed 目录，现有 `release/win-unpacked` 是经该脚本产出的。
  - 分叉 A（走 `node scripts/package-desktop.mjs`）：先建种子库 → 打包 → 清理 seed 目录；产物含种子库 `[源码 package-desktop.mjs:81-84]`。
  - 分叉 B（走 `apps/desktop/package.json:13` 的 `dist`：`electron-vite build && electron-builder --win nsis`，或直接调用 `electron-builder`）：不经过 `buildSeedDatabase()`，`seed/learning.db` 源缺失。electron-builder 对缺失 `extraResources` 源是构建报错还是静默省略，本次未实测 `[待验证]`；若省略，首启自举的两个候选（`resourcesPath/seed`、`getAppPath/seed`，`index.ts:73-76`）都找不到种子。
- **首启后果**：无种子时 DB 由 `LearningDb` 构造器建空文件并跑空 SCHEMA（`packages/db/src/index.ts:825-836`）；`learning:health` 自检在章节为 0 时推告警「安装包可能不完整」（`health.ts:26-29`）。此时不能把「章节数 >0」当作 packaged 冒烟的硬断言，除非确认种子库已随包发布 `[源码]`。
- **验证方法（可直接执行）**：
  1. `Test-Path apps/desktop/seed/learning.db`（已测 False）；`Test-Path release/win-unpacked/resources/seed/learning.db`（已测 True）。
  2. `npx asar list release/win-unpacked/resources/app.asar`：确认 `out/main/index.js`、`out/renderer/index.html` 在 asar 内，`seed/`、`prompts/` 不在 asar。
  3. 拷贝 `win-unpacked` 到临时目录，设隔离 `LEARNING_AGENT_HOME`，按 `scripts/verify-package.mjs:25-71` 启动并轮询 `$home/data/learning.db` 是否由种子库复制而来；比对种子库与自举库的页数/大小。
  4. 干净环境重跑 `pnpm --dir apps/desktop dist`（或直接 electron-builder），检查 `release/win-unpacked/resources/seed/` 是否存在，并记录 electron-builder 的警告/报错原文（打包运行需主代理批准，本次未执行）。

### 2.5 首启自举三分叉

```text
appHome/data/learning.db
  ├─ 已存在 → 不动种子库（index.ts:72 仅在不存在时复制）
  ├─ 不存在，找到种子候选
  │     候选 1: <resourcesPath>/seed/learning.db
  │     候选 2: <getAppPath>/seed/learning.db
  │     → mkdir(data) → copyFileSync(种子, db)        (index.ts:77-80)
  └─ 不存在，两个候选都缺失
        → LearningDb 构造器 openSync('wx') 建空文件
          → PRAGMA → application_id 校验 → migrate() 空 SCHEMA
          (packages/db/src/index.ts:825-836)
```

种子库内容来源（打包期，非运行期）：优先录制示例库 `.scratch/sample-home/data/learning.db`，否则流水线种子脚本生成（`package-desktop.mjs:34-48`）；含示例对话与否取决于是否存在录制库 `[源码]`。

### 2.6 asar 内外与测试取证差异

| 位置 | 内容（实测/源码） | 取证方式 |
|---|---|---|
| asar 内（`app.asar`） | `out/main/index.js`、`out/preload/index.mjs`、`out/renderer/`、`templates/*.md`（bp_outline / growth_card / question_set / research_design）、`package.json` `[源码 electron-builder.yml:7-10；实测 out/ 与 templates/]` | 普通磁盘工具/资源管理器无法直接列 asar 内部目录；需 `npx asar extract` 解包，或在主进程内 `evaluate` 读取；代码里的 `__dirname`/相对资源路径由 Electron asar 感知层解析，直接在磁盘按同路径找会找不到 |
| asar 外（`resources/`） | `seed/learning.db`、`prompts/agents/`、`prompts/references/` `[实测]` | 可直接磁盘读取；SQLite 文件可用只读方式打开核查表/行数 |

dev/preview 取证直接读 `apps/desktop/out/`；packaged 取证不要假设能在磁盘上按 `out/main/...` 路径找到主进程 bundle `[源码][实测]`。

## 3. 关键代码位置

| 职责 | 文件:行 | 说明 |
|---|---|---|
| dev/preview/build 脚本 | `apps/desktop/package.json:10` | `dev` / `build` / `start`(preview) / `dist` 四脚本 `9-14` |
| 三段构建与 external | `apps/desktop/electron.vite.config.ts:32` | `EXTERNAL`；main `35-43`、preload `44-50`、renderer `51-53` |
| dev 数据目录缺省注入 | `apps/desktop/electron.vite.config.ts:7` | `LEARNING_AGENT_HOME \|\|= resolve('../../.learning-agent')` |
| 主包 package.json 落盘 | `apps/desktop/electron.vite.config.ts:14` | `emitMainPackageJson()` closeBundle 写 `out/package.json` |
| 打包 files/extraResources | `apps/desktop/electron-builder.yml:7` | files `7-10`；extraResources `12-20`；asar `21` |
| NSIS 选项 | `apps/desktop/electron-builder.yml:30` | 非一键安装、可选目录、快捷方式名 |
| 种子库生成 | `scripts/package-desktop.mjs:32` | `buildSeedDatabase()`；录制库优先 `34-40`；否则种子脚本 `42-48`；`VACUUM INTO` `56` |
| 打包后清理 seed 目录 | `scripts/package-desktop.mjs:84` | electron-builder 结束后 `rmSync(desktopDir/seed)` |
| 首启种子候选 | `apps/desktop/src/main/index.ts:71` | 复制逻辑 `71-81`；候选 `73-76` |
| DB 空库建表 | `packages/db/src/index.ts:819` | 建文件 `827`；打开 `831`；迁移 `836` |
| packaged 冒烟断言 | `scripts/verify-package.mjs:17` | asar/seed 存在性 `17-22`；renderer URL 断言 `53-59`；首启自举轮询 `65-71` |
| renderer 加载分支 | `apps/desktop/src/main/index.ts:154` | `loadURL` / `loadFile` 判定 `154-158` |
| 空库自检 | `apps/desktop/src/main/health.ts:23` | 章节/知识点 0 告警 `26-30`；新闻 0 仅提示 `31-33` |

## 4. 可测点

| ID | 触发方式 | 观测点（文件/进程/IPC/日志） | 前置条件 |
|---|---|---|---|
| PKG-01 | dev / preview / 干净 build 后分别检查 `out/` | 三段产物是否齐全；`out/package.json` 版本号；bundle 大小与行数 | 不污染真实 home；build 产物可重建 |
| PKG-02 | 检查 `release/win-unpacked/resources/` | asar 内外边界：`seed/`、`prompts/` 在 asar 外；`out/` 在 asar 内 | 用 `asar list` 核实，不靠目录猜测 |
| PKG-03 | 在隔离 `LEARNING_AGENT_HOME` 下启动 packaged exe | 轮询 `$home/data/learning.db` 是否由种子库复制；`learning:health` 返回章节/知识点计数 | 参照 `verify-package.mjs:25-71`；断言区分「种子复制」与「空库建表」 |
| PKG-04 | 比对打包期种子库与首启自举库 | 字节大小、表行数、章节数；确认首启没有覆盖用户已写数据 | 只读比对；样本库先备份 |
| PKG-05 | 干净环境执行 `pnpm --dir apps/desktop dist`（需批准） | `resources/seed/learning.db` 是否存在；electron-builder 对缺失源的警告/报错原文 | 与走 `package-desktop.mjs` 的产物对照 |
| PKG-06 | 启动 packaged 后在主进程 evaluate 读取 `app.getAppPath()`、`process.resourcesPath`、`process.cwd()`、`__dirname` | 回填 2.1 矩阵中 `[待验证]` 的运行时字符串 | 经 `--remote-debugging-port` 或 Playwright Electron 通道 |
| PKG-07 | dev 与 packaged 分别读取提示词目录解析结果 | dev 第二根解析到 `packages/agent`；packaged 第一根解析到 `resources/prompts`；确认 packaged 不依赖 `resources/packages/agent` | 提示词加载失败的表现归 07 文档 |
| PKG-08 | 核对本机工具链版本 | `node -v`、`pnpm -v`、`electron --version`、锁定文件内版本；与根 `package.json` 声明对照 | 记录不一致项，不作为环境健康唯一判据 |

## 5. 风险与坑

1. **种子库只存在于打包流水线，静态检出必然缺失**：直接看仓库会误判「打包配置引用了不存在的文件」。真正风险在分叉 B（绕过 `package-desktop.mjs`）：种子源缺失时打包是否仍产出可用安装包，取决于 electron-builder 对缺失源的处理策略，当前未实测 `[待验证]`。
2. **首启空库与种子库分叉不能靠 UI 区分**：空库应用照样开窗，只是章节/知识点为 0；`learning:health` 是主要信号（`health.ts:26-30`）。冒烟用例若只断言「窗口打开」，会漏掉不完整安装包 `[源码]`。
3. **packaged 取证不能照搬 dev 路径**：asar 内文件在磁盘上没有独立路径；`__dirname` 指向 asar 内虚拟路径。测试脚本若用 `fs.readFileSync(out/main/...)` 直接读 packaged 产物会失败，必须先解 asar 或走主进程通道 `[源码][实测]`。
4. **cwd 随启动器变化**：dev/preview 的 cwd 是 `apps/desktop`；packaged 的 cwd 取决于快捷方式/资源管理器/自动化脚本。代码里 `loadDotEnv` 第一搜索根是 `process.cwd()`（`index.ts:47`），cwd 不同会影响 `.env` 查找；测试启动时应显式固定 cwd 或显式注入环境变量 `[源码]`。
5. **版本基线不一致本身是可测点**：根 `package.json:5` 声明 `packageManager: pnpm@11.28.5`，本机实测 pnpm 11.22.0；`engines.node` 要求 `^22.19.0 || >=24.0.0`（`package.json:7-8`），实测 Node v22.23.2 满足区间但低于 pnpm 声明版本。复现打包前应先对齐包管理器，避免 lockfile/node_modules 状态漂移 `[源码][实测]`。
6. **提示词根在 packaged 只靠 asar 外 `resources/prompts`**：第二根 `getAppPath/../../packages/agent` 在打包后解析到 asar 外不存在的位置；若后续把提示词改回 `packages/agent` 布局而未同步 `extraResources`，packaged 会找不到提示词，dev 下却正常 `[源码 index.ts:52-55；实测 resources 树]`。
7. **playwright 被 external 且懒加载**：bundle 不打包 playwright；packaged 机器无浏览器/未安装驱动时，相关能力需优雅降级，不能假设 `require('playwright')` 一定成功 `[源码 electron.vite.config.ts:32]`。

## 6. 未覆盖与待验证

1. **三路径运行时路径字符串**：2.1 矩阵中 `app.getAppPath()`、`process.resourcesPath`、`process.cwd()`、`__dirname` 的实际取值除产物目录实测外，均未启动进程读取。验证方法：dev/preview/packaged 分别经调试端口在主进程 `evaluate` 读取这四项与 `LEARNING_AGENT_HOME`、`LEARNING_AGENT_PROMPT_ROOTS` 实际拼接值，回填矩阵。
2. **electron-builder 缺失 extraResources 源的行为**：干净检出下直接 `electron-builder --win nsis`，观察是构建失败、告警省略，还是把空目录打入；本次按契约未执行打包。验证方法：见 2.4 验证步骤 4，记录命令输出与 `resources/seed/` 实际内容。
3. **preview 是否复用既有 `out/`**：`preview` 不传 `--skipBuild` 时会先 `build()`（`lib-EqoA0Jso.js:16-18`）；若 `out/` 是旧产物，preview 与 build 产物的一致性未实测。验证方法：删除 `out/` 后分别跑 build 与 preview，比对产物哈希。
4. **NSIS 安装后与 `win-unpacked` 的路径差异**：`verify-package.mjs` 验证的是拷贝的 `win-unpacked`；安装到 Program Files 类目录后，`resourcesPath` 符号化路径、userData 位置、可写性未实测。验证方法：批准后运行安装包，在隔离 home 下启动并读取路径与可写目录。
5. **种子库与用户库的版本兼容性**：种子库 `user_version` 与当前 `SCHEMA_VERSION=7` 是否一致、旧种子库经迁移打开是否丢数据，未核对。验证方法：只读打开 `release/win-unpacked/resources/seed/learning.db`，查 `PRAGMA user_version`，与 `packages/db/src/index.ts:74` 对照。
6. **`builder-debug.yml` 与当前 yml 的对应**：该文件是上次打包产物（`release/builder-debug.yml`），本次未逐条比对其文件收集规则与 `electron-builder.yml` 当前内容是否漂移；`files` 清单以当前 yml 为准 `[源码]`。

## 7. 交叉引用

- 主进程生命周期、`initServices()` 装配顺序、失败重置与窗口状态：`02-main-runtime-and-boot.md`
- IPC 通道与 preload 暴露面：`03-ipc-and-preload-contract.md`
- 新闻子进程目录/解释器/端口在打包后的解析：`06-news-sidecar-and-network.md`
- 数据目录隔离、种子库表结构、`window-state.json`/settings 文件与造数清理：`08-data-fixtures-and-isolation.md`
- 既有 `verify-*.ts`、`.scratch` 历史驱动与日志覆盖矩阵：`09-existing-verification-and-gaps.md`
- 四种测试驱动的 launch 配置、隔离环境与等待信号：`10-harness-strategy.md`
