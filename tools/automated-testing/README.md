# automated-testing

营小商桌面应用的自动化测试模块。本文件只说明模块结构、命令与编写约束；用例是否通过由实际运行结果回填，这里不下“已验证通过”的结论。

## 六层结构

| 目录 | 职责 |
|---|---|
| `src/driver/` | 进程与环境层：唯一 Electron 启动入口 `launchElectron`，端口分配/释放、进程枚举与清理、环境变量注入、产物路径、子进程日志 |
| `src/client/` | `window.learning` 桥接的强类型封装，每次 IPC 调用记入调用日志；DB 只读探针 |
| `src/pages/` | 应用外壳（AppShell）的 UI 操作封装 |
| `src/fixtures/` | Playwright fixtures：为每个用例建独立 home + userDataDir，组装 app / client / ui / evidence |
| `src/scenarios/` | 用例 spec；`dependencies.ts` 是 TC → 实现侧 ID 的依赖台账 |
| `src/evidence/` | 单条用例取证（meta、日志、IPC、窗口、关闭报告、DB 快照）+ reporter 汇总索引 |

## 常用命令

在本目录（`tools/automated-testing`）下执行：

```powershell
# 全部用例（p0 + p1）
pnpm test

# 只跑 p0 / 只跑 p1
pnpm test:p0
pnpm test:p1

# 按标题跑单条 TC（grep 正则）
pnpm test -- -g TC-P0-01

# 静态自检：用例唯一性、结构规范、依赖台账、证据链（不启动应用）
pnpm verify

# 双实例隔离自检：并行拉起两个隔离实例，断言 home/端口/DB/窗口独立，关闭后复查残留进程
pnpm test:isolation

# 类型检查
pnpm typecheck
```

可调环境变量：`YXS_WORKERS`（并发数，默认 1）、`YXS_RETRIES`（重试次数，默认 0）、`YXS_PACKAGED_DIR`（打包产物临时拷贝目录）、`YXS_KEEP_HOMES=1`（失败后保留隔离目录）。模型网关配置复制 `.env.local.example` 为 `.env.local` 填写，仓库内不留真实地址。

## 隔离与证据落点

- **用例隔离**：每个用例一份独立 `LEARNING_AGENT_HOME`（DB、window-state、artifacts、exports）与 `--user-data-dir`（settings.json），端口由 `allocatePort` 分配；seed 模式从 `release/win-unpacked/resources/seed/learning.db` 复制种子库。
- **双实例自检**：`src/selftest/isolation.ts` 不经 Playwright TestInfo，自建两个 tmp home + userDataDir，各自分配端口、不启侧车；校验 health、appHome、窗口数、端口空闲、DB 独立，关闭后按 userDataDir 片段与 `services/news-crawler-py` 片段复查残留进程。
- **证据落盘**：每条用例的证据在 `.artifacts/<用例目录>/`（`meta.json`、`main.log`、`ipc.jsonl`、`windows.json`、`close.json`、`db.json`，失败时附 `failure.png`、`dom.html`）；索引追加到 `.artifacts/index.jsonl`，reporter 汇总出 `.artifacts/report.md` 与 `.artifacts/report.json`。

## 编写约束

- **TC 命名**：`TC-P0-NN` / `TC-P1-NN`，标题首段写 TC 编号；**一条 TC 一个 spec 文件**，文件名与编号对应（`p0-01-*.spec.ts` / `p1-01-*.spec.ts`）。
- **依赖台账**：每条 TC 至少在注释或断言文本中引用 `dependencies.ts` 台账里的一个实现侧 ID（如 `BOOT-01`、`IPC-27`）。
- **禁止固定等待**：不得使用 `waitForTimeout`、`setTimeout` 等待、`sleep`；等待状态变化走 Playwright 的 locator 断言 / `expect.poll` / 事件收集器。
- **禁止 spec 自己启动 Electron**：Electron 只能经 `src/driver` 的 `launchElectron` 启动；spec 不得直接 import `_electron` 或 `@playwright/test`，测试入口统一从 `../fixtures/test.js` 取 `test` / `expect`。
- 显式阻塞的用例必须在 annotation 或相邻注释里写明阻塞理由。
