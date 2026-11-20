# H · Electron 用例变红 · 实现方案

> 轮次：H · Electron mutation 验证
> 文档角色：03-implementation
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1 §11
> 写权：[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1、§5
> 契约：[`./02-contract.md`](./02-contract.md) v1（mutant 编号、锚点、退出码、参数名冻结）
> 一句话：一个 PowerShell 编排脚本 + 5 个手写最小 patch + 一份人读报告，每条 mutant 走「预检 → apply → 红跑 → finally 还原 → 绿跑 → 记录」闭环，结束后桌面端与包目录工作区必须干净。

## 1 目录与模块

本轮产物全部落在 `tools/automated-testing/` 下，不新增第二条测试启动路径，也不改既有 `src/` 六层结构。既有六层（driver / client / pages / fixtures / scenarios / evidence）的职责见 `tools/automated-testing/README.md:7-15`，H 只在既有结构旁边挂「故障编排层」。

```text
tools/automated-testing/
  scripts/
    run-mutation.ps1              # H 新建：闭环编排（取锁、预检、apply、跑测、断言、还原、绿跑、出报告）
  mutations/
    cancel.patch                  # M1 取消：去掉主进程到执行链的 signal 接线
    answer-set.patch              # M2 交卷：results 组装丢掉判分字段
    streaming.patch               # M3 流式：事件转发层打乱既有工具帧
    packaged-boot.patch           # M4 打包启动：窗口加载 / preload 路径缺陷
    empty-question-set.patch      # M5 空题集：纯函数判定恒返回 markdown
  mutation-report.md              # H 新建：5 条 mutant 记录 + 31 条基线用例证据索引
```

| 模块 | 一句话职责 | 边界（谁不许干别人的活） |
|---|---|---|
| `scripts/run-mutation.ps1` | 编排闭环：解析参数、取 Electron 锁、预检基线、逐个 apply/revert、调用既有 Playwright 入口跑指定 spec、按退出码 + 关键词判红、汇总写报告 | 不 import 被测业务代码，不复写 driver 的端口分配与进程清理，不直接 `_electron.launch`；进程启动一律经既有 fixture → `launchElectron` 链路 [R3] |
| `mutations/*.patch`（5 个） | 唯一允许落地的故障载体：统一 diff 格式，每个 patch 只改坏一处实现，不带修复、不夹带格式化改动 | patch 只允许命中 `apps/desktop/**` 或 `packages/**` 里的既有源码行；不允许改 spec、fixture、driver、client、evidence；不允许新增依赖 |
| `mutation-report.md` | 人读报告：每个 mutant 的状态（killed / survived / skipped / apply-failed / revert-failed / green-failed）、应用与还原命令、红阶段失败摘要、绿阶段结果、关键词命中列表、时间戳；另附 31 条基线用例索引 | 报告只引用既有 `.artifacts/` 证据路径，不回写历史证据；不把环境类失败包装成 killed |

模块切分参照成熟 mutation 工具的「编排器 + 手工 mutant + 报告」三层形态，但本轮不引入任何 AST 级变异运行时，patch 由人写、由脚本机械应用与撤销 [R1]。

## 2 依赖与构建

### 2.1 复用既有工具链，不新增根依赖

H 复用 `tools/automated-testing` 现有 `node_modules`：`@playwright/test` 1.64.1、`tsx`、`typescript` 已在 `tools/automated-testing/package.json:15-19` 登记；Playwright 浏览器与 Electron 可执行文件按既有方式安装，本轮不重新下载。

| 项 | 口径 | 依据 |
|---|---|---|
| 包管理器 | 在 `tools/automated-testing` 目录内复用既有安装；**不**跑仓库根 `pnpm install`，**不**改根 `pnpm-lock.yaml` 与根 `package.json` | 归属矩阵 §1：根 lockfile 只归 A；`tools/` 不在 pnpm workspace glob 内 |
| 测试运行时 | 既有 `pnpm test`（`playwright test`）入口，单条 spec 按文件路径过滤，命令模板见 `02-contract.md` §2.3 | `tools/automated-testing/package.json:7-13`；project 划分见 `tools/automated-testing/playwright.config.ts:22-25` |
| 不引入的依赖 | Stryker、mutmut 一类变异运行时；不新增断言库、不新增 HTTP 客户端 | 本轮只维护 5 个定向 patch，范式借鉴而非引入运行时 [R2] |
| 被测构建产物 | dev/out 目标读 `apps/desktop/out/main/index.js` 与 `out/renderer/index.html`；packaged 目标读 `release/win-unpacked` | `tools/automated-testing/src/driver/paths.ts:61-70`（out 校验）、`tools/automated-testing/src/driver/paths.ts:16-22`（packaged 目录解析） |

### 2.2 开工前的构建前置

```powershell
# 在仓库根执行（clone 到哪台机器都适用，不写死本机路径）

# 1) out/ 构建产物是否完整（dev/out 目标用例依赖）
Test-Path apps\desktop\out\main\index.js
Test-Path apps\desktop\out\renderer\index.html

# 2) packaged 产物是否存在（M4 依赖；缺失则 M4 记 skipped，不阻塞其余 4 条）
Test-Path release\win-unpacked\营小商.exe
Test-Path release\win-unpacked\resources\seed\learning.db
```

- 缺 `out/`：先按桌面端既有构建流程产出（`apps/desktop/package.json:11` 的 `build` 脚本）；H 不在本轮交付新的构建命令。
- 缺 `release/win-unpacked`：由 `scripts/package-desktop.mjs:78-86` 的既有打包流程产出；H 只复用产物，不产出安装包。
- 模型网关配置：对话类用例（M1、M3）需要 `.env.local` 填入 `YXS_LLM_BASE_URL` / `YXS_LLM_API_KEY` / `YXS_LLM_MODEL`，格式见 `tools/automated-testing/.env.local.example:2-4`；配置缺失时相关 mutant 按环境类失败处理，不计 killed。

测试组织与断言形态沿用 Playwright 既有 fixture / locator 断言体系，不引入快照测试 [R4]。

## 3 关键实现

### 3.1 `run-mutation.ps1` 总流程

脚本按 `-RepoRoot`（默认脚本位置上四级）定位仓库根，所有相对路径都从仓库根解析，避免在别的目录被粘出来时写错落点。单个 mutant 的闭环伪代码：

```text
对每个待跑 mutant（M1..M5，顺序按 02-contract §2.2 登记表）：
  1. PRECHECK：git status --porcelain apps/desktop packages；非空 → 退出码 4，不应用任何 patch。
  2. 基线跑：未打 patch 先跑该 mutant 登记的 spec，退出码必须 0；
     非 0 → baseline-red，退出码 2，不进故障阶段。
  3. LOCK：取 Electron 互斥锁（见 §3.3）；取不到 → 记 skipped，退出码 2，跳过本 mutant。
  4. APPLY：git apply --check <patch> 预检 hunk 能否套上；
     失败 → apply-failed，退出码 3，记录锚点与 patch 名，不强行打补丁。
  5. git apply <patch>
  6. RED-RUN：调用既有 Playwright 入口跑登记 spec，stdout/stderr 落盘；
     记录退出码与失败摘要。
  7. 判红：退出码非 0 且输出命中登记关键词且 classification=assertion → killed；
     退出码 0 → survived；非 0 但未命中关键词 → ambiguous（环境错误 / 超时）。
  8. REVERT：try/finally 强制 git apply -R <patch>（见 §6 兜底）；
     还原后 STATUS-CHECK 跑 git status --porcelain 校验残留。
  9. GREEN-RUN：同一 spec 复跑，退出码必须 0；非 0 → green-failed，退出码 5。
 10. 记录该 mutant 的状态、命令、两段输出摘要、时间戳与证据目录。
收尾：释放锁（finally 删除锁目录）；汇总写 mutation-report.md。
```

三条不可让步的顺序约束：

1. **基线先于故障**：基线跑不绿，后面的红没有对照意义，必须中止而不是继续 apply。
2. **还原在 finally**：无论红跑通过、断言失败、脚本异常还是超时，还原动作都必须执行；不允许把「下次手动清」留给现场。
3. **绿跑是闭环闸门**：还原后不复跑一遍绿色，就不能在报告里写「已还原」。

闭环的「改坏一处 → 用例必须红 → 还原 → 必须绿」是 mutation 测试的基本循环，状态二分 killed / survived 术语沿用成熟工具口径 [R2]；环境类失败单列 ambiguous，不混进存活统计 [R6]。

### 3.2 五个 patch 的生成方式

每个 patch 都是对既有源码的最小改动：一行或一个 hunk，只删/只改一处语义，不带注释清理、不带格式化。patch 用 `git diff` 风格的 unified diff，路径相对仓库根，能被 `git apply --check` 与 `git apply -R` 成对套用；patch 文件头注释必须含 mutant 编号、目标文件、锚点行号、对应 TC、冻结参考版本（`02-contract.md` §2.2）。

| patch | mutant | 目标文件与锚点 | 最小改动 | 对应红例 spec | 红阶段命中关键词（取自既有断言文案） |
|---|---|---|---|---|---|
| `cancel.patch` | M1 | `apps/desktop/src/main/index.ts:485`（`signal: turn.signal,` 接线行） | 改为 `signal: undefined,`：取消控制器不再把 AbortSignal 交进执行链，点停止只断回调、模型请求继续跑 | `tools/automated-testing/src/scenarios/p1-03-cancel.spec.ts:25-37` | `没有静默`（`tools/automated-testing/src/client/chat-events.ts:83`）；备选 `toBeInstanceOf(Error)`；消息不匹配 `/已停止|等太久/`（`apps/desktop/src/main/errors.ts:20-21`、`:53-55`） |
| `answer-set.patch` | M2 | `packages/agent/src/index.ts:856`（`results[index] = contentOf(result)`） | 改为 `results[index] = {}`：丢掉判分结果里的 `questionId` / `score` 字段；DB 落库链路不动 | `tools/automated-testing/src/scenarios/p0-06-answer-set.spec.ts:46-85` | `toHaveLength(20)`、`score`、`questionId`；`question_attempts` 回读条数不符 |
| `streaming.patch` | M3 | `packages/agent/src/team.ts:157-160`（tool-start → `tool` 帧转发分支） | 删除该转发分支，`type: 'tool'` 帧不再发出；不新增事件类型 | `tools/automated-testing/src/scenarios/p0-03-chat-stream.spec.ts:22-31`、`:73-75` | `必须收到 session 事件`；`toBeGreaterThan(0)`（text 非空断言） |
| `packaged-boot.patch` | M4 | `apps/desktop/src/main/index.ts:157`（`loadFile` 渲染页路径）；备选 `:143`（preload 路径） | 把 `index.html` 指向不存在的 `out/renderer/missing.html`，或改坏 preload 路径；只动启动分支，不改窗口类本身 | `tools/automated-testing/src/scenarios/p0-08-packaged-boot.spec.ts:30-56` | `营小商`、`app.asar`、`user_version`、`learning.db` |
| `empty-question-set.patch` | M5 | `apps/desktop/src/renderer/src/question-set.ts:12`（`emptyQuestionSetAction` 三元） | 判定恒返回 `'markdown'`，空题集不再走 `'retry'` 兜底分支 | `tools/automated-testing/src/scenarios/p1-02-empty-question-set.spec.ts:12-13`、`:47-61` | `retry`、`question-set` |

锚点选择原则：被打坏的对象必须是被测实现链路上的代码，而不是测试代码、fixture 或 driver；否则用例变红证明的是「测试被改坏」，不是「实现缺保护」。M3 的覆盖缺口登记在 `01-scope.md` §7 风险 6：tool / tool-end 配对顺序当前没有序列断言，若 tool-start 分支删除后用例仍绿，如实记 survived，缺口写进报告 `notes`，不凑 killed。

两条备选锚点（`02-contract.md` §2.2）：

- M1 备选：`apps/desktop/src/main/turn-canceller.ts:19`，`signal: controller.signal` 改为 `signal: new AbortController().signal`——控制器仍存在但永远不 abort。主接线行因别轮改动导致 hunk 漂移时切换到此锚点，两条锚点服务同一个缺陷语义：「停止是否真中断在途请求」。
- M3 备选：`packages/agent/src/tool-loop.ts:313`，移除 `emit({ type: 'tool-start', ... })`，工具开始帧不上抛。

### 3.3 Electron 互斥锁的获取与释放

H 与 E 的 electron 目标共用一把目录锁，规则沿用归属矩阵 §5 第 3 条与 `02-contract.md` §5.2：

```powershell
# 获取：原子创建目录；已存在说明有人在用
New-Item -ItemType Directory -Path ".scratch\run\electron.lock" -ErrorAction Stop

# 释放：finally 中删除
Remove-Item -LiteralPath ".scratch\run\electron.lock" -Force
```

- **获取退避**：锁已存在时，每 2s 重试一次，累计 30s（约 15 次）；仍拿不到 → 本 mutant（或本轮）记 `skipped`，报告写 `lockAcquired=false` 与中文原因「未取得 electron 锁，本轮 electron 目标未执行」，退出码 2；**不**判 killed，**不**假绿。
- **释放保证**：锁在 `try/finally` 里删除；脚本异常退出、红跑失败、还原失败都走 finally。锁目录内写一个 `holder.txt`（记录脚本路径与开始时间戳），便于排查残留锁是谁留下的。
- **禁止事项**：禁止用 `git stash` 清场抢锁；禁止 kill 不明进程；残留锁只在人工确认没有对应 Electron 进程后删除（排查表见 `04-acceptance.md` §6）。
- **锁粒度**：一把目录锁保护整个 Electron 运行窗口（含红跑与绿跑），不按 mutant 反复抢锁；H 内部 5 条串行，不并发起 Electron。

### 3.4 打包用例（p0-08）的前置准备

M4 与其余四条最大的不同：packaged 目标跑的是 `release/win-unpacked` 里已打进 `app.asar` 的编译产物（`apps/desktop/electron-builder.yml:7-21`：`files: out/**` + `asar: true`），对 `apps/desktop/src/**` 的临时源码改动不会自动进已打包目录。因此 M4 闭环必须自己完成「备份基线 → 重打包 → 红跑 → 还原 → 恢复基线」，否则跑的是旧 asar，绿跑会假绿。脚本按下列四步执行：

1. **基线核对**：确认 `release/win-unpacked/营小商.exe` 与 `resources/seed/learning.db` 存在；任一缺失 → M4 记 `skipped`，消息指明缺失项与既有打包命令（`scripts/package-desktop.mjs:78-86`），不阻塞 M1/M2/M3/M5。
2. **基线备份**：robocopy `/MIR` 把 `release/win-unpacked` 备份到 `.scratch/run/H/baseline-unpacked/`（退出码 0-7 视为成功）；备份前先删上一轮残留，避免把旧基线当本轮基线。
3. **重打包**：把 `release/win-unpacked/resources/seed/learning.db` 复制到 `apps/desktop/seed/learning.db`（`electron-builder.yml` 的 `extraResources` 需要它，而 `scripts/package-desktop.mjs:84` 打包后会删掉该目录），再跑 `pnpm --dir apps/desktop exec electron-builder --dir --publish never`；`apps/desktop/node_modules/electron/dist/electron.exe` 存在时追加 `-c.electronDist=<绝对路径>` 走离线，不联网等下载。
4. **asar 探针 + 还原恢复**：重打包后用「asar 哈希变化 + mutant marker 出现在 asar 字节里」双条件确认改动真的进包，未进包记 `skipped(asar-stale)` 且不跑红例；闭环结束后 robocopy 反向 `/MIR` 恢复基线，恢复成功后删除备份目录与临时 `apps/desktop/seed`。

**重建链不可用的兜底**：重打包失败（工具链缺失、超时、产物被占用）时 M4 记 `skipped` 并写明缺失环节；该状态在报告中与 killed 分列，不计入 killed 总数。恢复失败时保留备份并在报告「残留与清理」节标注路径、大小与人工处理方式。

`baseline-unpacked` 约 365 MB，只在闭环期间存在；脚本不再让它在磁盘上静默堆积。

打包产物的真实存在性与种子库 `user_version` 由 p0-08 自己断言（`tools/automated-testing/src/scenarios/p0-08-packaged-boot.spec.ts:34-56`），脚本只负责准备目录与环境，不重复实现这些断言。

### 3.5 报告写入

`mutation-report.md` 由脚本在闭环结束后刷新，字段口径按 `02-contract.md` §3：顶层含 `round` / `generatedAt` / `repoRoot` / `branch` / `baselineCleanBefore` / `lockAcquired` / `mutations`（5 条 `MutantRecord`）/ `baselineIndex`（31 行）/ `summary` 计数。

- **mutant 表（5 行）**：`id` / `patch` / `targetFile` / `anchorLine` / `defectSummary` / `targetCase` / `status` / `apply` / `red`（命令、退出码、输出摘要、关键词命中、分类）/ `revert` / `green` / `cleanupCheck` / `notes`。
- **基线索引（31 行）**：从 `tools/automated-testing/src/scenarios/dependencies.ts:5-37` 的 `TC_DEPS` 台账派生，每行含 TC 编号、标题、依赖 ID、既有 `.artifacts/` 证据目录引用；台账导出入口见 `tools/automated-testing/src/scenarios/dependencies.ts:39`。

状态枚举：`killed` / `survived` / `skipped` / `apply-failed` / `revert-failed` / `green-failed`；失败分类 `assertion` / `env-error` / `timeout` / `ambiguous`。报告不编造未执行过的运行结论，本轮文档阶段不填写任何「已跑通」数字。

## 4 数据读写

### 4.1 只读范围

| 读什么 | 来源 | 说明 |
|---|---|---|
| 被测源码 | `apps/desktop/**`、`packages/**` | 仅作为 patch 上下文与锚点核对；H 不读不改业务库 |
| 既有 spec 与台账 | `tools/automated-testing/src/scenarios/**`、`tools/automated-testing/src/scenarios/dependencies.ts:5-37` | 只读；5 条红例从 31 条台账内挑选 |
| 既有证据 | `tools/automated-testing/.artifacts/**` | 报告索引只引用路径，不回写、不删除历史证据 |
| 打包基线 | `release/win-unpacked/**` | M4 只读拷贝源；改动前先备份到 `.scratch/run/H/` |
| 种子库 | `packagedSeedPath()` 指向的 seed 副本 | fixture 复制到隔离 home 后读取，见 `tools/automated-testing/src/fixtures/home.ts:76-83` |

### 4.2 只写范围

| 写什么 | 落点 | 边界 |
|---|---|---|
| 故障载体 | `tools/automated-testing/mutations/*.patch` | H 唯一常驻的改动文件类型 |
| 编排脚本 | `tools/automated-testing/scripts/run-mutation.ps1` | 新建 |
| 人读报告 | `tools/automated-testing/mutation-report.md` | 新建，脚本刷新 |
| 运行证据 | `.scratch/run/H/<mutant>/red/`、`…/green/`、`…/baseline/` | stdout、退出码、失败摘要、元信息；闭环结束后保留供复盘 |
| 锁 | `.scratch/run/electron.lock/`（含 `holder.txt`） | 用完删除；目录在 `.scratch/` 内，不进仓库 |

### 4.3 禁止写入与隔离口径

- **不写真实数据目录**：`%APPDATA%`、`~/.learning-agent`、仓库内 `.learning-agent` 一律不碰；每个用例的 home 由 fixture `createHome` 建在系统 tmpdir 下并强制注入 `LEARNING_AGENT_HOME`（`tools/automated-testing/src/fixtures/home.ts:58-71`），脚本不另设指向真实目录的环境变量。
- **不写业务库**：DB 探针（`tools/automated-testing/src/client/db-probe.ts`）只做只读查询；M2 的故障在结果组装层，不直接改 `learning.db` 写入逻辑。
- **临时 home 清理**：复用既有 fixture 收尾（`tools/automated-testing/src/fixtures/home.ts:88-91` 删根目录；`tools/automated-testing/src/driver/electron-driver.ts:140-180` 关进程、复查端口与 DB 可删除），H 不自造清理流程。
- **WAL / 并发**：本轮 5 条串行（`YXS_WORKERS=1`），不并发写同一隔离库；端口由 `allocatePort` 随机分配（`tools/automated-testing/src/driver/ports.ts:3-18`），不写死端口。

只读用例与源码、只写 `.scratch/run/H/` 与 H 名下产物目录，这条边界与隔离测试实践中「测试夹具与被测产品分离」的要求一致 [R5]。

## 5 配置

### 5.1 脚本参数表

参数名与互斥关系按 `02-contract.md` §2.1 冻结。

| 参数 | 类型 | 默认 | 作用 | 非法取值处理 |
|---|---|---|---|---|
| `-Case` | 字符串 | 空 | 按 TC 编号（如 `TC-P1-03`）或 spec 文件名定位单个 mutant 闭环；脚本反查台账得到对应 patch id 与目标用例 | 编号不在登记表 → 退出码 3，打印可用列表 |
| `-Apply` | 字符串 | 空 | 只应用指定 patch：取值 M1–M5 编号或 `mutations/` 下 patch 路径；不跑用例、不写报告 | 文件不存在 / `git apply --check` 失败 → 退出码 3；与 `-Revert` 同时给 → 退出码 3 |
| `-Revert` | 字符串 | 空 | 只还原指定 patch；取值同 `-Apply`；不跑用例 | 无已应用记录 → 提示无东西可还原，退出码 0；与 `-Apply` 互斥 |
| `-All` | 开关 | 关 | 按 M1→M2→M3→M4→M5 顺序串行跑完全部 5 个 mutant | 与 `-Case` 同时给 → 退出码 3 |
| `-DryRun` | 开关 | 关 | 只打印将执行的 apply / 跑测 / revert 命令、锚点与目标用例；不建锁、不改源码、不跑用例、不写报告 | — |
| `-PatchDir` | 路径 | `tools/automated-testing/mutations` | patch 文件查找目录 | 目录不存在 → 退出码 3 |
| `-RepoRoot` | 路径 | 脚本位置上四级 | 仓库根；`git` 命令与测试入口均相对此路径解析 | 路径下无 `.git` → 退出码 3 |

三者都不给且非 `-All` 时，打印用法并退出码 3。

### 5.2 环境变量与既有配置继承

| 变量 / 配置 | 取值 | 来源 | 说明 |
|---|---|---|---|
| `CI` | `1` 时非交互 | 既有 CI 约定 | `CI=1` 下脚本不弹任何确认提示，所有决策靠退出码与报告；缺前置直接记 skipped / 失败 |
| 用例级超时 | 180000 ms | `tools/automated-testing/playwright.config.ts:9` | 单条 spec 的 Playwright 超时；脚本不覆盖该值 |
| 断言超时 | 30000 ms | `tools/automated-testing/playwright.config.ts:10` | locator 断言默认等待 |
| `YXS_WORKERS` | `1` | `tools/automated-testing/playwright.config.ts:3,12` | H 串行跑，禁止并发起多个 Electron |
| `YXS_RETRIES` | `0` | `tools/automated-testing/playwright.config.ts:4,13` | mutation 闭环不重试：重试会把 flaky 藏进绿阶段 |
| `YXS_PACKAGED_DIR` | M4 临时打包目录 | `tools/automated-testing/src/driver/paths.ts:16-19` | 仅 M4 重打包流程使用；其余用例走默认解析 |
| `YXS_KEEP_HOMES` | 不置位 | `tools/automated-testing/src/fixtures/home.ts:89` | 失败现场需要保留时由排查者手工置位，脚本默认不保留临时 home |

环境变量注入沿用既有 `buildEnv`：隔离 home、端口、sidecar 开关在子进程环境里固定，网关配置只从 `.env.local` 读取（`tools/automated-testing/src/driver/env.ts:55-83`）。脚本不在源码里写第二份默认配置表 [R8]。

## 6 失败处理

失败路径的判定原则：能被命令量到的失败才下结论；环境类、超时类失败不计 killed；每条路径都有明确退出码与一行中文消息。退出码枚举按 `02-contract.md` §4.1 冻结（0 全部符合预期 / 1 存在 survived / 2 前置不可用 / 3 参数或 apply 失败 / 4 还原失败或工作区脏 / 5 绿阶段仍红）。

| 失败路径 | 判定与分类 | 退出码 | 中文消息（逐字口径） | 兜底 / 是否重试 |
|---|---|---|---|---|
| patch 预检失败（`git apply --check` 非 0） | `apply-failed` | 3 | `patch <文件名> 无法应用：上下文与当前源码不匹配，请先核对锚点行号。` | 不强行 apply、不手工改上下文；记录目标文件、锚点行号、patch 名；若已取锁则在 finally 释放 |
| 基线工作区不干净（预检 `git status --porcelain apps/desktop packages` 非空） | `revert-failed` 类预检脏 | 4 | `应用 patch 前工作区不干净，中止` | 不应用任何 patch；交由人裁决是否外部改动（归属矩阵 §5 第 1 条） |
| 基线用例本来就红（未打 patch 跑 spec 退出码非 0） | 前置不可用（baseline-red） | 2 | `基线用例 <TC 编号> 在未打 patch 时已失败，请先修复基线再跑 mutation。` | 中止本轮；不进故障阶段；保留基线输出到 `.scratch/run/H/baseline/` |
| 红跑退出码 0（patch 没打坏或锚点未到执行链） | `survived` | 1 | `mutant <编号> 存活：用例未变红，覆盖不到这条缺陷。` | 如实记 survived；不调整断言去凑红 |
| 红跑退出码非 0 但未命中登记关键词 | `ambiguous`（notes 单列） | 0 | `mutant <编号> 失败原因无法归类：环境错误或超时，未命中登记关键词，不计 killed。` | 分类记录失败摘要；需要时人工复核 |
| 还原失败（`git apply -R` 非 0） | `revert-failed` | 4 | `反向还原失败，工作区可能残留改动，请人工核对` | 先重试一次反向 apply；仍失败则用预检时备份的 diff 快照恢复；再失败保留现场、不删证据，报告 `cleanupCheck` 贴 `git status` 原文 |
| 绿阶段复跑仍红 | `green-failed` | 5 | `还原后用例仍然失败：可能是还原不彻底，也可能是基线回归，请对比红/绿两份输出。` | 不自动二次还原；同时贴红阶段与绿阶段摘要，交人区分两类原因 |
| 锁超时（30s 退避后仍未取得） | `skipped` | 2 | `未取得 electron 锁，本轮 electron 目标未执行` | 不抢锁、不 kill 进程；报告 `lockAcquired=false` |
| 网关不可达 / 缺模型配置 | `env-error`（环境类） | 2 | `模型网关不可用：请检查 .env.local 的 YXS_LLM_BASE_URL / YXS_LLM_API_KEY / YXS_LLM_MODEL。` | 对话类 mutant 不计 killed；非对话类不受影响 |
| 用例超时 | `timeout`（超时类） | 2 | `用例 <TC 编号> 超时，无法判定 mutant 状态。` | 不计 killed；超时输出落盘供排查 |
| M4 打包产物缺失 | `skipped` | 2 | `打包产物不存在：<路径>（先按既有流程完成打包再跑 M4）。` | 跳过 M4，不阻塞其余 4 条 |

还原兜底的快照时机：每个 mutant 在 `git apply` 之前，先把 `git diff -- apps/desktop packages` 与被命中文件的副本存到 `.scratch/run/H/<mutant>/pre/`；反向 apply 失败时按快照逐文件恢复，恢复后再次跑 `git status --porcelain` 校验。任何兜底动作都不用 `git stash` 完成。

环境类失败与断言失败必须分开归类：前者是测试环境没准备好，后者才是 mutant 被捕获；混在一起会让 killed 计数虚高 [R6]。

## 7 性能与资源

本轮是串行 Electron 闭环，不做并发压测；性能口径以「单条用例耗时 + 闭环总时长 + 进程 / 磁盘残留」三项可量指标为准。

| 指标 | 预期量级 | 怎么量 |
|---|---|---|
| 单条 dev/out 用例 | 启动 Electron + 首窗就绪 + 一轮交互，秒级到分钟级；用例超时上限 180s（`tools/automated-testing/playwright.config.ts:9`） | `.scratch/run/H/<mutant>/green/meta.json` 记录开始/结束时间戳与 `durationMs` |
| 单条对话类用例额外耗时 | 受模型网关往返影响，首 token 与流式收口时间不写死数字 | 红/绿两段输出里的事件时间线对照；网关不可达时按 §6 环境类处理 |
| 5 条串行总时长 | 待实测：等于 5 ×（红跑 + 绿跑 + apply/revert 开销），M4 另加环境侧重建 / 重打包耗时 | `-All` 跑完后在报告汇总总时长；首轮实测值回填报告，文档阶段不预估具体分钟数 |
| 进程残留 | 闭环结束后无指向 H 临时 userDataDir 的 Electron 进程 | driver 收尾按 userDataDir 片段复查（`tools/automated-testing/src/driver/electron-driver.ts:160-168`）；脚本收尾再按 home 路径复查一次 |
| 磁盘占用 | 临时 home 在系统 tmpdir，用例结束即删；`.scratch/run/H/` 只留本轮证据 | `YXS_KEEP_HOMES` 不置位；证据目录大小在报告登记 |
| 端口 | 随机空闲端口，无固定占用 | `allocatePort` 分配（`tools/automated-testing/src/driver/ports.ts:3-18`）；收尾 `waitPortFree` 复查（`tools/automated-testing/src/driver/electron-driver.ts:169`） |

串行而非并发的原因：Electron 单实例约束、driver 的进程清理口径都是按单实例设计的；并发只会增加端口与 userDataDir 互踩概率，不缩短本轮需要的总墙钟太多 [R5]。M4 的重建 / 重打包是环境侧前置步骤，若实测发现其耗时不可接受，备选方案是只在 dev/out 等价启动分支上验证启动断言，该取舍在报告备注里写明，不静默切换目标。

## 8 实施顺序

每一步都有可执行的验证点，做到哪一步停在哪一步都能说明「已完成什么」。

1. **目录与脚本骨架**：建 `mutations/`、`scripts/` 目录；`run-mutation.ps1` 完成参数解析、仓库根定位、登记表读取。验证：`-DryRun -All` 只打印 5 条计划与落点，`git status --porcelain apps/desktop packages` 为空。
2. **锁与基线预检**：实现目录锁的原子创建、2s/30s 退避、finally 释放；实现工作区干净预检与基线跑校验。验证：预置锁目录后脚本记 `skipped`（退出码 2）；人为弄脏 `apps/desktop` 后预检退出码 4。
3. **闭环骨架先接 M5**：M5 是纯函数判定、不依赖模型网关，最快跑通「apply → 红跑 → 断言 → revert → 绿跑」主链路。验证：M5 红阶段退出码非 0 且命中 `retry` 关键词，绿阶段退出码 0，工作区干净。
4. **接入 M1 / M2 / M3**：逐条写 patch、登记锚点与关键词，跑通各自闭环；M3 若 tool 帧缺陷未被捕获，按 survived 如实登记并写入 `notes`。验证：三条红阶段各命中登记关键词，绿阶段全绿。
5. **接入 M4 打包链路**：核对 `release/win-unpacked` 基线 → 备份到 `.scratch/run/H/baseline-unpacked/` → 环境侧重建 / 临时目录重打包 → 跑 p0-08 → 还原恢复。验证：M4 红→绿；产物缺失时走 skipped 分支且不假绿。
6. **报告生成**：脚本刷新 `mutation-report.md` 的 5 行 mutant 表与 31 行基线索引，补齐状态、命令、摘要、时间戳与证据目录。验证：报告字段齐全，索引与 `tools/automated-testing/src/scenarios/dependencies.ts:5-37` 台账一一对应。
7. **失败路径演练**：人为制造 apply 上下文漂移、还原失败、基线红、锁占用、网关缺失五种场景，核对退出码与中文消息逐条对上 §6 表。验证：每条失败路径都能在报告里找到分类记录。
8. **全量复跑与自检**：`-All` 串行复跑一遍；校验工作区干净；跑文档自检 `python plans/server-client-split/00-master/check-docs.py --round H`；证据与报告归档到 `.scratch/run/H/`。验证：自检退出码 0（或仅报 01/02 由并行子代理补齐），`git status --porcelain apps/desktop packages` 为空。

分步实施、每步可回退的顺序安排，与「先把闭环骨架跑通、再逐挂 mutant」的渐进集成做法一致 [R7]。

## 参考

- [R1] Stryker JS — https://github.com/stryker-mutator/stryker-js — 支撑 §1 三层模块划分与 §3.1 闭环范式 — 借鉴「编排器 + 手工 mutant + 报告」结构与改坏一处必须变红的循环；不引入其 AST 变异运行时。
- [R2] Stryker 文档 — https://stryker-mutator.io/docs/ — 支撑 §2.1 状态口径与 §3.5 报告字段 — 采用 killed / survived 术语与报告分栏；不照搬全量 mutant 矩阵与覆盖率联动。
- [R3] Playwright Electron — https://playwright.dev/docs/api/class-electron — 支撑 §1 启动边界与 §3.1 进程链路 — 复用既有 `_electron.launch` 通道；spec 不直接 import `_electron`。
- [R4] Playwright 官方文档 — https://playwright.dev/docs/intro — 支撑 §2.1 测试形态复用 — 采用既有 fixture / 断言 / 证据落盘；不引入快照测试。
- [R5] JavaScript Testing Best Practices — https://github.com/goldbergyoni/javascript-testing-best-practices — 支撑 §4.3 夹具隔离与 §7 串行等待口径 — 采用测试夹具与产品分离、禁止固定等待；不引入其全部工具链。
- [R6] infection — https://github.com/infection/infection — 支撑 §3.1 与 §6 的状态二分 — 借鉴「被测试杀死 / 逃逸存活 / 环境不可判」分类；不引入 PHP 栈与其框架绑定。
- [R7] mbj/mutant — https://github.com/mbj/mutant — 支撑 §8 渐进集成顺序 — 借鉴「小步跑通闭环再逐个挂 mutant」的推进方式；不引入 Ruby 变异运行时。
- [R8] microsoft/playwright — https://github.com/microsoft/playwright — 支撑 §5.2 配置继承与 §7 进程清理口径 — 对照其 Electron 测试组织与配置项；H 不改动既有 Playwright 配置。
