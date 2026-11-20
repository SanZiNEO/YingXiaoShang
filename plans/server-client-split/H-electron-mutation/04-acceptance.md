# H · Electron 用例变红 · 验收

> 轮次：H · Electron mutation 验证
> 文档角色：04-acceptance
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1 §11
> 写权：[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1、§5
> 契约：[`./02-contract.md`](./02-contract.md) v1（AC 逐条追溯 §2.2 锚点、§3 报告字段、§4 退出码）
> 一句话：14 条 AC 全部可命令复现；每条 mutant 必须走完「应用 → 红 → 还原 → 绿」，工作区干净、报告口径可机器复核；任何只能靠「我觉得对」的判断都不算过。

## 1 验收口径

**过 = 下列四组同时成立**：

1. **五个闭环**：M1–M5 各自完成「patch 应用 → 指定用例变红（退出码非 0 且命中登记关键词且分类为断言失败）→ 强制还原 → 同一用例复跑变绿」；M4 受打包前置限制时允许 `skipped`，但必须写明缺失项，不得记 killed、不得假绿。
2. **工作区干净**：全部闭环结束后，`git status --porcelain apps/desktop packages` 输出为空；H 名下产物（`mutations/`、`scripts/`、`mutation-report.md`）之外无残留改动。
3. **报告口径**：`mutation-report.md` 含 5 条 mutant 记录，状态分类（killed / survived / skipped / apply-failed / revert-failed / green-failed）与退出码、关键词、证据目录齐全；31 行基线索引与 `tools/automated-testing/src/scenarios/dependencies.ts:5-37` 台账一一对应。
4. **证据可复盘**：每个 mutant 的红阶段、绿阶段输出与退出码都落在 `.scratch/run/H/` 下，可用同一命令复跑。

不可替代项（不能用「手工点了一遍」或「看截图」代替）：关键词命中判定、还原后复跑为绿、工作区干净校验、锁未取得时的 skipped 标记。

「断言必须写成可执行检查、状态必须二分可判」这条口径来自测试实践与成熟 mutation 工具的报告约定 [R1]。

## 2 前置条件

```powershell
# 在仓库根执行（clone 到哪台机器都适用，不写死本机路径）

# 1) 基线工作区必须干净（H 开工前）
git status --porcelain apps/desktop packages

# 2) dev/out 构建产物（dev/out 目标用例依赖）
Test-Path apps\desktop\out\main\index.js
Test-Path apps\desktop\out\renderer\index.html

# 3) packaged 产物（M4 依赖；缺失时 M4 记 skipped）
Test-Path release\win-unpacked\营小商.exe
Test-Path release\win-unpacked\resources\seed\learning.db

# 4) 模型网关配置（M1、M3 对话类用例依赖；缺文件则复制示例再填）
Test-Path tools\automated-testing\.env.local

# 5) 既有依赖已安装（复用现有 node_modules，不新增安装）
Test-Path tools\automated-testing\node_modules\@playwright\test
```

| 前置项 | 缺失时处理 |
|---|---|
| `out/` 构建产物缺失 | dev/out 目标用例无法启动；先按既有构建流程产出，本轮不新写构建命令 |
| `release/win-unpacked` 缺失 | M4 记 `skipped`，写明缺失路径；M1/M2/M3/M5 照常验收 |
| `.env.local` 网关配置缺失 | M1、M3 记 `env-error`（环境类），不计 killed；非对话类不受影响 |
| Electron 锁被 E 或他人占用 | 按 §3 AC-H-09 走 skipped 分支，不抢锁、不 kill 进程 |
| 既有 `node_modules` 损坏 | 回到 `tools/automated-testing` 按既有方式恢复；H 不跑根 `pnpm install` |

用例启动与环境注入全部复用既有 driver 链：Electron 只经 `launchElectron` 启动，spec 不直接 import `_electron`（`tools/automated-testing/README.md:54`）；隔离 home、端口、环境变量由既有 fixture 与 `buildEnv` 装配（`tools/automated-testing/src/fixtures/home.ts:58-86`、`tools/automated-testing/src/driver/env.ts:55-83`）[R3]。

## 3 用例清单

每条 AC 可由 `tools/automated-testing/scripts/run-mutation.ps1` 直接复跑；契约点列指向 `02-contract.md` 的对应章节（§2.2 锚点表、§3 报告字段、§4 退出码与判定口径、§5.2 锁时序）。

| 编号 | 操作步骤 | 期望输出 | 失败判据 | 证据文件 | 契约点 |
|---|---|---|---|---|---|
| AC-H-01 | 不应用任何 patch，先跑 5 条目标用例（TC-P1-03、TC-P0-06、TC-P0-03、TC-P0-08、TC-P1-02）做基线 | 5 条全部退出码 0；基线输出落盘 | 任一用例退出码非 0 即中止本轮，后续 AC 不执行 | `.scratch/run/H/baseline/` | §4.2 基线对照；§3.3 基线索引 |
| AC-H-02 | M1 `cancel.patch` 闭环：apply → 跑 TC-P1-03 → 断言 → revert → 复跑 TC-P1-03 | 红阶段退出码非 0 且命中 `没有静默` 或 `toBeInstanceOf(Error)` 之一；分类 `assertion`；绿阶段退出码 0 | 红阶段退出码 0（survived 不算过）；红阶段非 0 但无关键词；绿阶段非 0 | `…/M1/red/`、`…/M1/green/` | §2.2 M1 锚点 `index.ts:485`；§4.2 红判据 |
| AC-H-03 | M2 `answer-set.patch` 闭环：apply → 跑 TC-P0-06 → 断言 → revert → 复跑 TC-P0-06 | 红阶段退出码非 0 且命中 `toHaveLength(20)` / `score` / `questionId` 之一；绿阶段退出码 0 | 20 条 attempts 与 results 结构仍全绿；绿阶段非 0 | `…/M2/red/`、`…/M2/green/` | §2.2 M2 锚点 `packages/agent/src/index.ts:856`；§7 测试映射 |
| AC-H-04 | M3 `streaming.patch` 闭环：apply → 跑 TC-P0-03 → 断言 → revert → 复跑 TC-P0-03 | 按契约锚点 `team.ts:157-160` 执行时**预期 survived**：红阶段退出码 0（`tool` 帧缺陷在 p0-03 无断言），脚本记 `survived` 并写入覆盖缺口 `notes`；绿阶段退出码 0 | 把 survived 改成 killed（例如把锚点挪到 `session` 帧删除处）；红阶段因环境/超时非 0；绿阶段非 0 | `…/M3/red/`、`…/M3/green/` | §2.2 M3 锚点 `team.ts:157-160` 与「M3/M4 预期结果」表；§5.3 事件帧口径 |
| AC-H-05 | M4 `packaged-boot.patch` 闭环：核对打包产物 → 备份基线 → apply → 环境侧重建临时打包目录 → 跑 TC-P0-08 → revert → 恢复基线 → 复跑 TC-P0-08 | 按契约锚点 `index.ts:157` 执行时预期 `skipped`：driver 等 `learning.health` 超时，分类 `timeout`（§4.2 不计 killed），`notes` 写明环境原因；产物缺失或重建链不可用时同样记 `skipped`；基线 unpacked 必须恢复且备份目录清理 | 把 skipped 记成 killed（含改成页面标题换 killed）；绿阶段非 0；基线 unpacked 被覆盖未恢复；备份目录遗留未标注 | `…/M4/red/`、`…/M4/green/` | §2.2 M4 锚点 `index.ts:157` / `:143` 与「M3/M4 预期结果」表；§6 重建前置口径 |
| AC-H-06 | M5 `empty-question-set.patch` 闭环：apply → 跑 TC-P1-02 → 断言 → revert → 复跑 TC-P1-02 | 红阶段退出码非 0 且命中 `retry` / `question-set` 之一；绿阶段退出码 0 | 纯函数两种形态仍分别返回 `markdown` / `retry`；绿阶段非 0 | `…/M5/red/`、`…/M5/green/` | §2.2 M5 锚点 `question-set.ts:12` |
| AC-H-07 | 全部闭环结束后执行 `git status --porcelain apps/desktop packages` | 输出为空（无临时 patch 残留、无文件改动） | 任一文件出现在清单中；残留 `.orig` / `.rej` 补丁副产物 | 报告 `cleanupCheck.output` 贴命令原文输出 | 冻结契约 §11；§3.2 `cleanupCheck.clean` |
| AC-H-08 | 检查 `mutation-report.md` 的 5 条 mutant 记录 | 状态分类齐全；有效红例记 `killed`；`survived` / `skipped` / `apply-failed` / `revert-failed` / `green-failed` 单列，不混入 killed 计数；每条含退出码、关键词、证据目录 | 环境类失败被记成 killed；缺少红/绿任一阶段输出；状态字段缺失 | `tools/automated-testing/mutation-report.md` | §3.2 `MutantRecord` 字段；§4.2 假红不计 killed |
| AC-H-09 | 预置占用 `.scratch/run/electron.lock` 后跑脚本 | 30s 退避（每 2s 一次）后仍取不到锁 → 记 `skipped`，报告 `lockAcquired=false`，中文原因「未取得 electron 锁，本轮 electron 目标未执行」，退出码 2 | 取不到锁仍跑用例并记 killed；用 `git stash` 清场抢锁；kill 不明进程 | `…/lock-skip/` 记录与报告 skipped 行 | §5.2 锁时序；§4.1 退出码 2 |
| AC-H-10 | 预检阶段人为让基线用例变红（或保留未登记改动） | 工作区非空 → 退出码 4，消息「应用 patch 前工作区不干净，中止」；基线 spec 已红 → 退出码 2，标记 baseline-red；均不应用 patch | 基线红仍继续 apply；把基线失败算成 mutant killed | `.scratch/run/H/baseline/` | §4.1 退出码 4 / 2；§4.3 预检消息 |
| AC-H-11 | 以 `-DryRun -All` 运行 | 只打印将执行的 apply / 跑测 / revert 命令、锚点与目标用例；不建锁目录、不改源码、不跑用例、不写报告 | 工作区出现 patch 应用痕迹；锁目录被创建；证据目录写入红/绿输出 | 终端打印文本 + `git status` 为空 | §2.1 `-DryRun` 语义 |
| AC-H-12 | 逐条核对证据目录完整性 | 每个跑过的 mutant 在 `.scratch/run/H/<mutant>/red/` 与 `…/green/` 下有 `stdout.txt`、`exit-code.txt`、`failure-summary.txt`、`meta.json`（含时间戳与 `durationMs`） | 缺红阶段或绿阶段任一文件；退出码未记录；失败摘要为空 | `.scratch/run/H/**` | §3.2 证据字段；§2.4 stdout 契约 |
| AC-H-13 | 演练还原失败：人为让 `git apply -R` 失败后跑脚本 | 先重试一次反向 apply；再失败用预检快照恢复；仍失败退出码 4 + 中文消息「反向还原失败，工作区可能残留改动，请人工核对」，保留现场与证据并在报告报警 | 静默吞掉还原错误；删除现场证据；用 `git stash` 收尾 | `.scratch/run/H/<mutant>/pre/` 快照 + 报告 `cleanupCheck` | §4.1 退出码 4；§4.3 还原消息 |
| AC-H-14 | 隔离与配置核对：`CI=1` 运行；核对超时、并发与数据目录 | `CI=1` 下无交互提示；`YXS_WORKERS=1`、`YXS_RETRIES=0`；无进程指向 `%APPDATA%` / `.learning-agent` 真实目录；用例超时沿用 180000 ms | 出现交互确认弹窗；并发起多个 Electron；临时 home 落到真实数据目录 | `.scratch/run/H/` 各 `meta.json` 环境字段 | §2.1 参数表；§5.2 既有配置继承 |

用例写法遵循「一条 AC 一个可观察结果 + 明确失败判据」，不使用「看起来正常」这类不可判定描述 [R4]。

### 3.1 演练项的执行方式（AC-H-09 / H-11 / H-13 / H-14）

这四条不靠人工摆现场，脚本内置 `-Drill` 子命令自行构造前置并核对结果，每条把 `result.json`（含逐项期望值与实际值）与 `stdout.txt` 写进 `.scratch/run/H/drills/<name>/`：

| 演练 | 命令 | 脚本怎么构造现场 | 核对什么 |
|---|---|---|---|
| `dryrun` | `-Drill dryrun` | 直接调子进程跑 `-All -DryRun` | 退出码 0、打印 M3/M4 契约锚点、未建锁目录、未新建证据目录、工作区干净 |
| `lock` | `-Drill lock` | 先手动创建 `.scratch/run/electron.lock` 并写 `holder.txt`，再跑 `-Case M5`，结束后删锁 | 退出码 2、stdout 含「未取得 electron 锁」、报告 `lockAcquired=False`、M5 记 `skipped`、工作区干净 |
| `revert` | `-Drill revert` | 起一个看门狗子进程，等 patch 落地后把 mutant 那一行改成别的文本，使 `git apply -R` 的 hunk 上下文失配 | 退出码 4、stdout 含「反向还原失败」、报告 M5 记 `revert-failed`、看门狗确实注入过改动、目标文件被快照恢复、工作区干净 |
| `isolation` | `-Drill isolation` | 扫描本轮 `.scratch/run/H/**/meta.json` 与 `playwright.config.ts` | `YXS_WORKERS=1`、`YXS_RETRIES=0`、起止时间戳齐全、无真实数据目录引用、超时 180000、无残留临时 home 进程 |

一次跑全部：`-Drill all`。演练退出码：0 全部符合预期；5 有演练项未满足（不静默放过）；3 参数错。演练结果同时进 `mutation-report.md` 的「AC 演练记录」节。

`isolation` 只校验本轮格式的 `meta.json`（带 `env` 字段）。旧版脚本（1.0.x）写的证据缺这些字段，属历史产物，脚本跳过并单独计数，不拿旧格式冒充本轮结论。

## 4 证据落点

- **根目录**：`.scratch/run/H/`，本轮所有运行证据只落在这里；不回写 `tools/automated-testing/.artifacts/` 既有历史证据。

```text
.scratch/run/H/
  baseline/                     # AC-H-01 基线跑：5 条目标用例原始输出
  M1/  red/  green/  pre/       # 每个 mutant：红跑、绿跑、应用前快照
  M2/  red/  green/  pre/
  M3/  red/  green/  pre/
  M4/  red/  green/  pre/  baseline-unpacked/   # baseline-unpacked 仅闭环期间存在，恢复成功后删除
  M5/  red/  green/  pre/
  drills/                       # AC-H-09 / H-11 / H-13 / H-14 演练结果（result.json + stdout.txt）
    dryrun/  lock/  revert/  isolation/
```

`baseline-unpacked` 是 M4 的临时基线备份（约 365 MB）。脚本在恢复成功后立即删除；恢复失败时保留并在报告「残留与清理」节标注大小与人工处理方式，不会静默堆积。

- **每个阶段目录内文件**：
  - `stdout.txt`：Playwright 原始 stdout / stderr 合并输出；
  - `exit-code.txt`：该阶段进程退出码（单值）；
  - `failure-summary.txt`：脚本提取的失败断言行与命中关键词列表；
  - `meta.json`：mutant 编号、patch 名、spec / TC 编号、开始与结束时间戳、`durationMs`、`lockAcquired`、环境字段。
- **复跑命令**（仓库根）：

```powershell
# 在仓库根执行（clone 到哪台机器都适用，不写死本机路径）

# 单条闭环：按 TC 编号反查
powershell -NoProfile -ExecutionPolicy Bypass -File tools\automated-testing\scripts\run-mutation.ps1 -Case TC-P1-03

# 全量串行
powershell -NoProfile -ExecutionPolicy Bypass -File tools\automated-testing\scripts\run-mutation.ps1 -All

# 干跑：只看计划不动文件
powershell -NoProfile -ExecutionPolicy Bypass -File tools\automated-testing\scripts\run-mutation.ps1 -All -DryRun

# AC 演练：锁跳过 / DryRun / 还原失败 / 隔离核对（结果落 .scratch/run/H/drills/）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\automated-testing\scripts\run-mutation.ps1 -Drill all
```

脚本只需 Windows 自带的 `powershell.exe`（5.1）即可运行，不要求 `pwsh`；在 PowerShell 7 下同样可用。脚本文件本身是 UTF-8 带 BOM，因为 5.1 读取无 BOM 的 `.ps1` 会按 ANSI 解码，中文关键词会变乱码。

- **报告索引**：`mutation-report.md` 的 31 行基线索引只引用既有 `.artifacts/` 证据目录路径；本轮新产生的截图 / trace 不在本轮交付范围内（既有配置 `trace: 'off'`、`screenshot: 'off'`，见 `tools/automated-testing/playwright.config.ts:16-20`）。

证据存成「命令原文 + 退出码 + 失败摘要」而不是截图，是为了失败能在 CI 里复盘；结构化事件落盘的口径与既有 evidence 链路一致 [R8]。

## 5 反向验证

反向验证专门抓「脚本判定口径本身被放松」的情况：每条写清「改坏哪一处 → 哪条 AC 必须变红」。

| # | 改坏哪里 | 预期变红的 AC | 还原后 |
|---|---|---|---|
| N1 | 把 `mutations/answer-set.patch` 改成空 patch（只留 diff header、无 hunk 改动行），应用后源码不变 | 用例不变红 → 脚本必须判 `survived`（退出码 1），AC-H-08 报该项不计 killed；若脚本把退出码 0 记成 killed，AC-H-08 红 | 恢复完整 patch，M2 回到 killed |
| N2 | 在 M2 闭环里注释掉 revert 步骤（故意不还原） | 绿跑前 `git status --porcelain apps/desktop packages` 非空 → AC-H-07 红；`cleanupCheck` 非空 → AC-H-13 红（退出码 4） | 恢复 finally 还原逻辑，工作区复跑为空 |
| N3 | 把红判据里的「关键词命中」去掉、只看退出码非 0；或把绿判定放宽成「退出码 0」而跳过 `git status` 干净校验 | 环境类 flaky 被误判 killed → AC-H-02/H-03/H-04/H-06 的关键词列失守；残留改动被当成绿 → AC-H-07 失守；两类失守都必须在对应 AC 上报红 | 恢复「退出码非 0 且关键词命中且分类 assertion」与「绿跑退出码 0 + 工作区干净」双闸门 |

反向验证的状态二分与存活判定口径参照成熟 mutation 工具：用例没被打红就是 mutant 存活，不能为了报告好看改成 killed [R2]。

## 6 排查表

| 症状 | 最可能原因 | 一条命令确认 |
|---|---|---|
| 脚本退出码 3，提示 patch 无法应用 | 源码被别轮改动，hunk 上下文漂移 | `git apply --check -v tools\automated-testing\mutations\<name>.patch`；对照 `03-implementation.md` §3.2 锚点行号 |
| 红跑退出码 0，报告记 survived | 锚点没打到执行链，或该缺陷用例本就覆盖不到 | 看 `…/red/stdout.txt` 事件序列；对照 spec 断言位置（如 `tools/automated-testing/src/scenarios/p0-03-chat-stream.spec.ts:22-31`、`:73-75`） |
| 红跑非 0 但无关键词，记 ambiguous | 网关抖动、首窗超时等环境错误 | 分类字段对照 `02-contract.md` §3.4；重跑一次确认是否复现；不计 killed |
| 绿阶段仍红（green-failed，退出码 5） | 还原不彻底，或基线本身回归 | 对比 `…/red/` 与 `…/green/` 两份摘要；`git diff apps/desktop packages` 看残留 |
| 锁目录残留 `.scratch/run/electron.lock` | 上次脚本异常退出，finally 未执行 | 按 `holder.txt` 记录的进程片段查 Electron 进程；确认无残留后人工删除锁目录 |
| M4 被跳过 | `release/win-unpacked` 或种子库缺失 | `Test-Path release\win-unpacked\营小商.exe`；`Test-Path release\win-unpacked\resources\seed\learning.db` |
| 对话类用例报网关错误 | `.env.local` 未配置或模型不在列表 | 对照 `tools/automated-testing/.env.local.example:2-4` 检查三项变量；网关探测逻辑见 `tools/automated-testing/src/driver/env.ts:92-113` |
| 端口被占用 | 上一轮 Electron 进程未清理干净 | 按 userDataDir 片段枚举进程：`Get-CimInstance Win32_Process \| Where-Object { $_.CommandLine -like '*yingxiaoshang-tests*' }` |
| DryRun 后工作区出现改动 | 脚本在 DryRun 分支误执行了 apply / 建锁 | `git status --porcelain apps/desktop packages`；检查脚本 DryRun 分支是否绕过了命令打印 |

排查表按「症状 → 最可能原因 → 一条确认命令」组织；环境类症状必须落到原始输出与退出码上，不凭平均值或印象判断 [R5]。

## 7 自检输出

文档自检是交活前的机器闸：只查结构、引用与占位词，查不到语义对错；语义由 §3 的 14 条 AC 负责。形式机器校验、语义人工验收的分工，与测试实践的底线要求一致 [R7]。

```powershell
# 在仓库根执行（clone 到哪台机器都适用，不写死本机路径）
python plans\server-client-split\00-master\check-docs.py --round H
```

```text
仓库根：<clone 后的仓库根绝对路径>
检查轮次：H
行数统计：
  H-*: 1035 行 / 4 份

全部通过：轮次齐全、节数达标、每节有引用、参考清单与本地行号引用都对得上。
退出码：0
```

本轮为文档撰写阶段，未运行 Playwright、未应用任何 patch；上表为 `check-docs.py --round H` 在四份文档齐备后的真实输出，不填写虚构的命令运行结论。

## 参考

- [R1] Stryker JS — https://github.com/stryker-mutator/stryker-js — 支撑 §1 验收口径与红/绿闭环 — 借鉴「改坏一处必须被测试杀死」的基本判据；不引入其变异运行时。
- [R2] Stryker 文档 — https://stryker-mutator.io/docs/ — 支撑 §5 反向验证的 killed / survived 口径 — 采用状态二分；不照搬全量 mutant 矩阵。
- [R3] Playwright Electron — https://playwright.dev/docs/api/class-electron — 支撑 §2 前置条件的启动边界 — 复用既有 `_electron.launch` 通道与 driver 装配。
- [R4] JavaScript Testing Best Practices — https://github.com/goldbergyoni/javascript-testing-best-practices — 支撑 §3 用例写法 — 采用可执行断言与明确失败判据；不引入其工具链。
- [R5] infection — https://github.com/infection/infection — 支撑 §6 排查表的存活 / 环境不可判分类 — 借鉴失败归类思路；不引入 PHP 栈。
- [R6] microsoft/playwright — https://github.com/microsoft/playwright — 支撑 §3 既有配置继承 — 对照其 Electron 测试组织；H 不改既有 Playwright 配置项。
- [R7] mbj/mutant — https://github.com/mbj/mutant — 支撑 §7 自检与存活判定纪律 — 借鉴「存活即覆盖缺口、不凑数」的原则；不引入 Ruby 运行时。
- [R8] Playwright 官方文档 — https://playwright.dev/docs/intro — 支撑 §4 证据落盘形态 — 采用既有 fixture 取证与报告目录约定；不引入快照测试。
