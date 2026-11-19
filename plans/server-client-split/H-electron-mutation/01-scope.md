# H · Electron 用例变红 · 范围与边界

> 轮次：H · Electron mutation 验证
> 文档角色：01-scope
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1 §11
> 写权：[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1、§5
> 一句话：在既有 31 条 Electron 自动化用例上手工维护 5 个最小 patch，每条走「改坏一处 → 指定用例必须红 → 还原 → 必须绿」的闭环，结束时桌面端与包目录工作区必须干净。

## 1 目标

1. **5 个手工 mutant 各自形成可重复的红→还原→绿闭环**：每个 patch 只改坏一处实现，应用后对应用例必须按断言变红，反向还原后同一用例必须恢复绿色。
   判断标准：`scripts/run-mutation.ps1 -All` 对 M1–M5 逐条输出闭环记录；每条记录同时包含红阶段退出码、关键词命中、还原命令与绿阶段退出码；本轮只定义闭环口径，实际跑通结果待执行，验证方法见 §7 与 `02-contract.md` §4。
2. **patch 只存在于 H 自己的 mutations 目录**：5 个 `.patch` 文件是唯一允许落地的故障载体；`apps/desktop/**`、`packages/**` 里不留下任何常驻改动。
   判断标准：闭环结束执行 `git status --porcelain apps/desktop packages`，输出必须为空；patch 文件本身位于 `tools/automated-testing/mutations/`，不进被改源码目录。
3. **复用既有 31 条 Playwright Electron 用例作为红绿判据**：不另起测试栈、不新增 spec 断言；红例从既有台账里挑，故障打在被测实现链路上，而不是测试代码里。
   判断标准：5 条红例的 spec 文件名、TC 编号、依赖 ID 与 `dependencies.ts` 台账一一对应；脚本只调既有 `pnpm test` 入口，不绕过 `src/driver` 自起进程 [R34]。
4. **产出 mutation 报告与 31 条基线证据索引**：`mutation-report.md` 记录每个 mutant 的状态（killed/survived）、应用与还原命令、失败输出摘要、还原校验结果、时间戳；另附 31 条基线用例的证据索引，指向既有 `.artifacts/` 取证目录。
   判断标准：报告中 mutant 记录 5 条、基线索引 31 行；索引行包含 TC 编号、标题、依赖 ID、证据目录与基线状态引用。
5. **与 E 的 Electron 目标互斥运行**：H 启动 Electron 前先取目录锁，拿不到锁按退避策略跳过并写明原因；临时 home 与进程清理全部复用既有 fixture 与 driver 机制。
   判断标准：锁目录 `.scratch/run/electron.lock` 的创建与释放成对出现；报告记录 `lockAcquired` 布尔值；无残留 Electron 进程指向 H 的临时 userDataDir。
6. **红绿判定口径可机器复核**：红 = 用例退出码非 0 且断言消息命中该 mutant 登记的关键词；环境类失败、超时抖动不算有效红。
   判断标准：报告每条红例标注关键词命中列表与失败分类（断言失败 / 环境错误 / 超时）；未命中关键词的非零退出不计入 killed 统计。
7. **闭环可复跑、可追溯**：每条 mutant 记录保留应用命令、还原命令、红/绿两次测试命令与时间戳，验收者能按报告原样复跑同一条闭环。
   判断标准：报告 `MutantRecord` 中四条命令字段齐全；`-Case <TC>` 可单独复跑某一条；`-DryRun` 可在不碰工作区的前提下核对计划。

目标排序是「先钉死写权与还原保证，再定义 5 条故障链路，最后出报告口径」：故障注入只是手段，工作区干净与判据可信才是本轮交付物 [R52]。

本轮开工可直接粘贴的基线命令（仓库根执行）：

```powershell
cd E:\Documents\GitHub\YingXiaoShang

# 既有基线静态自检（不启动应用）
pnpm --dir tools/automated-testing verify

# 既有基线全量（p0 + p1，31 条）；H 闭环不依赖本次全量结果
pnpm --dir tools/automated-testing test

# H 闭环（本轮交付脚本，后续轮次落地）
pwsh tools\automated-testing\scripts\run-mutation.ps1 -All -DryRun
```

> 本轮文档阶段不执行上述测试命令；任何「已跑通 / 已变红」的结论都必须等脚本与 patch 落地后实测回填，文档里只写口径与验证方法。

**读者与受益方**：

- 实现者：照本份范围与 `02-contract.md` 的锚点、参数、退出码写脚本与 patch，不用反向猜意图。
- 验收者：按报告里的 killed / survived 记录与还原校验闸门核对闭环是否成立，不依赖口头确认。
- 并行各轮：从 §6 边界表确认 H 只读哪些路径、占用哪些运行时资源，避免同时抢 Electron 锁与临时 home。
- 基线维护者：报告里的 survived 条目与覆盖缺口备注，作为后续补断言、加固既有 spec 的输入。

## 2 非目标

| 不做 | 为什么 |
|---|---|
| 不引入 Stryker 运行时，不做全量 mutant 扫描 | 本轮只手工维护 5 个定向 patch；AST 级变异会产生大量与产品语义无关的噪音，也超出既有用例的覆盖能力 [R53] |
| 不改 `packages/**`、`apps/desktop/**` 的常驻代码 | 归属矩阵中这两个路径无人有写权；H 的临时 patch 例外仅在「应用后必须还原」前提下成立（冻结 §11），结束后不保留一行改动 |
| 不新增、不修改 31 条既有 spec 的断言 | 基线用例是回归判据本身；H 若改编译断言，红例就验不到被测实现的缺陷，mutation 失去杀伤力 |
| 不做服务端 HTTP / RPC 契约测试 | 那是 E 轮 `tools/contract-tests/**` 的范围；H 只打本地 Electron 链路，不起 `apps/server`，不跑 docker compose |
| 不把重打包 release 产物作为常态交付 | 打包用例依赖既有 `release/win-unpacked` 拷贝；H 不产出安装包，只在需要观察 packaged 行为时复用既有构建产物，前置缺失则登记跳过 |
| 不写真实数据目录（`%APPDATA%`、`~/.learning-agent`、仓库内 `.learning-agent`） | 隔离约定见归属矩阵 §3；所有 home 走 fixture 的 tmpdir 隔离目录 |
| 不 `git commit` / `git push` / `git stash` | 禁区见写作手册 §6；清场只能靠脚本化 revert，禁止用 stash 把临时 patch 藏起来抢锁 |
| 不实现新的 SSE 事件类型或 RPC 方法 | 本轮只验证既有实现对故障的敏感度；事件名与方法名以冻结契约 §5、§7 为准，H 不扩接口面 |
| 不为 mutant 补写新的断言 spec | 覆盖缺口（如 M3 缺 tool 配对顺序断言）如实记为 survived 与备注，不在本轮临时往基线 spec 里加断言；补断言属于基线维护者的后续工作 |
| 不接入新闻侧车验收与数据库迁移 | 侧车健康、新闻入库、PG 迁移分别是 B/C/D/G 的范围；H 的 Electron 用例按既有 fixture 策略决定是否自起侧车，脚本不额外编排容器 |
| 不清理或改写历史 `.artifacts/` 证据 | 既有取证目录是基线历史记录；H 报告只索引引用，不删除、不覆盖、不重命名历史产物 |

## 3 真实依据（现状代码）

| # | 位置 | 现在是什么 | 为什么本轮必须以它为准 |
|---|---|---|---|
| 1 | `tools/automated-testing/src/scenarios/dependencies.ts:5-37` | `TC_DEPS` 台账登记 13 条 p0（`TC-P0-01` 至 `TC-P0-13`）与 18 条 p1（`TC-P1-01` 至 `TC-P1-18`），共 31 条；`:39` 导出 `ALL_TCS` | 5 条红例只能从这 31 条里挑；报告的 31 行基线索引也从同一份台账生成，不另造编号表 |
| 2 | `tools/automated-testing/README.md:54` | 编写约束：Electron 只能经 `src/driver` 的 `launchElectron` 启动；spec 不得直接 import `_electron` 或 `@playwright/test`，测试入口统一从 `../fixtures/test.js` 取 | H 的编排脚本调测试入口必须走既有 fixture 链；若脚本自起 Electron 进程，就绕过了 driver 的端口分配、日志附着与进程清理 |
| 3 | `tools/automated-testing/src/driver/electron-driver.ts:82-98` | `launchElectron` 是唯一启动入口：解析目标、装配环境变量、附着进程日志、`electron.launch` 后等首窗与 `learning.health` | 红例与绿例都必须经同一入口启动，否则两次运行的环境不一致，红/绿对比不可信 [R54] |
| 4 | `tools/automated-testing/src/fixtures/test.ts:62-81` | `app` fixture 分配端口、调 `launchElectron`、绑定证据、收尾时捕获现场、关闭进程并复查端口与 DB 可删除 | H 不复写生命周期管理；每条闭环复用同一 fixture，失败取证沿用既有 evidence 链路 |
| 5 | `tools/automated-testing/src/fixtures/home.ts:58-86` | `createHome` 为每个用例建独立 `home` / `userDataDir`，seed 模式从 `packagedSeedPath()` 复制种子库并重映射产物路径 | H 的临时数据边界继承这套隔离；脚本不需要再设计一套 home 目录，只在 `.scratch/run/H/` 下登记本轮运行标记 |
| 6 | `packages/agent/src/team.ts:17-35` | `TeamEvent.type` 只有 `'round' | 'text' | 'tool' | 'tool-end' | 'session'` 五种；`:157-169` 把 loop 的 `tool-start` / `tool-end` 转发成界面帧 | M3 的故障锚点落在事件转发层；事件名集合不得新增，patch 只能打乱既有帧的转发或顺序 |
| 7 | `apps/desktop/src/main/index.ts:448-451` | `learning:cancel` 通道委托 `TurnCanceller.cancel(requestId)` 返回 `{ cancelled }` | M1 表面断点在 cancel 通道；但真正的缺陷风险在信号接线，单看 `cancelled: true` 验不到中断是否进执行链 |
| 8 | `apps/desktop/src/main/turn-canceller.ts:15-36` | `begin` 给每轮一个 `AbortController`，`cancel` 调 `controller.abort()` 并注销条目 | M1 的备选锚点：若主进程接线行不可改，可在控制器返回的 signal 上做缺陷；两种落点都服务于「停止是否真中断在途请求」 |
| 9 | `apps/desktop/src/main/index.ts:478-485` | `onEvent` 把步骤推给渲染层；`:485` 把 `turn.signal` 交给执行链，注释写明「只测 `runAgentLoop` 测不到这条接线」 | M1 的主锚点：去掉 signal 接线后，界面回调仍返回取消成功，但模型请求继续跑——这正是历史上出过的假停缺陷 |
| 10 | `apps/desktop/src/main/index.ts:509-527` | `learning:answer-set` 通道调 `agentRuntime.answerQuestionSet`，失败经 `friendlyError(context:'answer')` 翻成中文 | M2 的故障在 agent 层结果组装；通道文案口径保持不变，patch 不碰错误翻译 |
| 11 | `packages/agent/src/index.ts:706-752` | `answerQuestionSet` 做答卷非空、格式、去重、归属与题目存在性校验，再转交 `submitAnswerSet` | M2 锚点落在结果组装而非入口校验：入口校验缺陷会抛结构化错误，与「回读不到判分记录」是两类不同故障 |
| 12 | `packages/agent/src/index.ts:808-809`、`:856` | `results` 按题组装判分结果；新交卷分支 `results[index] = contentOf(result)` | M2 的直接改坏处：丢掉 `questionId` / `score` 字段后，交卷回读与 DB 探针断言同时落空 |
| 13 | `apps/desktop/src/renderer/src/question-set.ts:11-13` | 纯函数 `emptyQuestionSetAction`：`content.trim().length > 0` 返回 `'markdown'`，否则 `'retry'` | M5 锚点：空题集判定是可单测的纯函数，patch 把判定恒置 `'markdown'`，UI 兜底分支与纯函数断言同时被打穿 |
| 14 | `tools/automated-testing/src/driver/paths.ts:49-71` | `resolveTarget` 区分 `out` 与 `packaged`：packaged 走 `YXS_PACKAGED_DIR` 或 `release/win-unpacked` 的 exe 与资源目录 | M4 跑 packaged 目标；driver 解析规则是既有基线，H 不改路径解析代码 |
| 15 | `apps/desktop/src/main/errors.ts:13-67` | `friendlyError` 把底层错误翻成中文目录；`已停止` 与 `超时/aborted` 两类消息分别落不同分支 | M1 红例断言消息匹配 `/已停止|等太久/`；脚本关键词必须从这套既有文案里取，不自造错误文本 |
| 16 | `tools/automated-testing/src/client/chat-events.ts:70-83` | `waitQuiet` 在静默窗口内反复比对事件数，超时抛 `事件流在 ${timeoutMs}ms 内没有静默` | M1 红例的主关键词来源；取消后继续吐字会先撞这条静默断言，而不是等到轮次结束 |
| 17 | `tools/automated-testing/src/scenarios/p1-03-cancel.spec.ts:25-37` | 取消后断言 `cancelled.cancelled` 为真、事件数静默、settled 为 Error 且消息匹配取消口径 | M1 红例断言位置，关键词逐条对齐到这里 |
| 18 | `tools/automated-testing/src/scenarios/p0-06-answer-set.spec.ts:46-85` | DB 探针核对 20 条 attempts 与 `feedback_json` 结构，再回读 `questions.attempts` 与 answer-set 结果结构 | M2 红例断言位置：条数、score 类型、results 字段三处回读 |
| 19 | `tools/automated-testing/src/scenarios/p0-03-chat-stream.spec.ts:22-31` | 采集事件后断言 `session` 事件存在且 `sessionId` 非空、`text(lead)` 非空 | M3 红例断言位置；该用例未直接断言 tool/tool-end 配对顺序，覆盖缺口登记在 §7 |
| 20 | `tools/automated-testing/src/scenarios/p0-08-packaged-boot.spec.ts:30-56` | packaged 目标下断言首窗标题、URL 含 `app.asar`、资源路径、种子库存在且 `user_version` 为 7、health 为真 | M4 红例断言位置；打包产物前置缺失时该用例只能跳过 |
| 21 | `tools/automated-testing/src/scenarios/p1-02-empty-question-set.spec.ts:12-13` | 先对纯函数断言两种内容形态分别返回 `markdown` / `retry`，再走 DB 写入与 UI 兜底 | M5 红例断言位置；纯函数分支先于 UI 断言失败 |
| 22 | `tools/automated-testing/playwright.config.ts:22-25` | `p0` / `p1` 两个 project，分别按文件名正则匹配 spec | 单条红例可按 spec 文件路径直接跑，不必整轮 31 条全量复跑 |
| 23 | `tools/automated-testing/src/driver/env.ts:55-83` | `buildEnv` 固定注入隔离 home、新闻端口、sidecar 策略，并清掉 `ELECTRON_RENDERER_URL` 等 dev 残留变量；模型网关配置仅在 `.env.local` 存在时注入 | H 脚本不另造环境装配；红/绿两次运行的环境变量由同一函数装配，对比才成立 |
| 24 | `tools/automated-testing/src/driver/env.ts:92-113` | `probeGateway` 开跑前确认网关可达且模型在列；配置缺失或不可达直接报错，不静默降级 | 对话类红例（M1、M3）的前置不可用属于环境错误，按 `skipped` 登记，不计假红 |
| 25 | `tools/automated-testing/src/driver/ports.ts:3-18`、`:20-35` | `allocatePort` 从操作系统取随机空闲端口；`isPortFree` 收尾复查端口释放 | H 不写死端口号；进程清理后端口可复用，下一条闭环不受影响 |
| 26 | `tools/automated-testing/src/driver/processes.ts:19-44`、`:46-56` | 按命令行片段枚举 Windows 进程，`killTree` 沿进程树强杀，`waitProcessGone` 等待退出 | 残留进程复查沿用这套按 userDataDir 片段匹配的逻辑，脚本不自行 taskkill |
| 27 | `tools/automated-testing/src/client/learning-client.ts:104-122`、`:154-170` | 强类型封装 `health` / `chat` / `cancel` / `answerSet` / `artifactsList` / `artifactGet` / `sessions` / `messages` | 五条红例的调用面都在这层；M1 验 `cancel`、M2 验 `answerSet` 回读、M5 验 `artifactGet` 兜底 |
| 28 | `tools/automated-testing/src/evidence/reporter.ts:56-85`、`:94-119` | reporter 按 TC 汇总结局、耗时、错误消息，汇总出 `.artifacts/report.md` 与 `report.json` | 31 行基线索引的状态与证据目录从既有 reporter 产物读取，H 不重写索引逻辑 |
| 29 | `tools/automated-testing/verify.ts:1-12` | 静态自检：用例唯一性、fixture 入口约束、台账引用、证据链，不启动应用 | H 不改 spec 结构；脚本闭环之外不重复实现这套静态校验，发现台账漂移只登记不修复 |
| 30 | `tools/automated-testing/src/evidence/evidence.ts:37`、`:154-160` | 证据落在 `testInfo.outputDir`，逐条写 meta / 日志 / IPC / 窗口 / DB 快照，并向 `index.jsonl` 追加 TC 与证据目录索引 | 报告 31 行索引的 `evidenceDir` 取自这套既有索引；H 不另造取证目录，也不回写历史快照 |

这 30 条证据按测试六层归组，便于核对每条红例走在哪一层：

- **进程与环境层**（driver）：`electron-driver.ts`、`env.ts`、`ports.ts`、`processes.ts`、`paths.ts` 负责启动、环境变量、端口、清理与目标解析；H 闭环的两次运行（红 / 绿）必须经同一层装配。
- **fixture 层**：`test.ts`、`home.ts` 组装 app / client / ui / evidence 与隔离 home；patch 不碰这一层，避免把测试夹具本身改成被测对象。
- **客户端层**：`learning-client.ts`、`chat-events.ts` 封装 IPC 调用与事件采集；断言消息与关键词从这一层的既有方法和采集器文本里取。
- **用例层**：`scenarios/*.spec.ts` 与 `dependencies.ts` 台账；5 条红例的编号、标题、依赖 ID 全部可回溯到台账条目。
- **agent 层**：`packages/agent/src/team.ts`、`tool-loop.ts`、`index.ts` 承载事件转发、工具帧与交卷结果组装，是 M2、M3 的锚点所在。
- **桌面主进程 / 渲染层**：`apps/desktop/src/main/**`、`apps/desktop/src/renderer/src/**` 承载通道接线、窗口加载与纯函数判定，是 M1、M4、M5 的锚点所在。

这 30 条证据的共同判据是「被打坏的对象必须是被测实现，而不是测试代码或 fixture」——mutation 范式要求故障落在产品链路、由既有用例捕获 [R52]。

## 4 与现行为的差异（有意变更）

| 项 | 现状 | H 轮契约 | 影响谁 |
|---|---|---|---|
| 工作区代码 | 基线只读，所有 spec 期望全绿 | 临时 patch 应用期间允许 `apps/desktop` / `packages` 出现一次性改动，闭环结束必须还原到干净状态 | 并行各轮；E 跑 electron 目标时需确认 H 已还原 |
| 用例性质 | 31 条都是回归基线，失败即退化 | 红例是「故意打坏」的预期失败，带 mutant 编号登记；还原后复跑变绿才算闭环成立 | 验收者判读报告时区分预期红与真实回归 |
| 故障注入手段 | 仅有 `verify-cancel-wiring.ts` 一类源码级静态断言 | 文件级 patch + 运行时用例变红 + 还原后复绿，故障可被脚本重复应用与撤销 | 实现者排查时按 patch 锚点定位，不靠手工改代码 |
| 还原手段 | 无（基线工作区保持不动） | 每个闭环先记预检状态，`git apply -R` 成对还原，再跑 `git status --porcelain` 校验 | 现场安全；还原失败按 `02-contract.md` §4 退出码 4 处理 |
| 测试报告 | 既有 reporter 出 `.artifacts/report.md` 与 `report.json`，按 TC 汇总基线状态 | `mutation-report.md` 另出 5 条 mutant 记录 + 31 行基线索引；既有无 reporter 产物不改写 | 验收者两份报告对照：基线看 `.artifacts/`，mutant 看 H 报告 |
| 进程启动 | spec 经 fixture → driver 启动 | 脚本编排同一入口，不新增第二条启动路径 | 端口、日志、清理口径与基线一致 [R36] |
| 网关配置 | 对话类用例经 `.env.local` 取 `YXS_LLM_BASE_URL` / `YXS_LLM_API_KEY` / `YXS_LLM_MODEL`，缺失由 `probeGateway` 报错 | H 不写网关配置、不注入 mock Key；配置缺失时对话类闭环记 `skipped`，不伪造成功 | 对话类红例 M1、M3；环境前置登记进报告 |
| 端口分配 | `allocatePort` 随机取空闲端口，收尾 `isPortFree` 复查 | H 不分配固定端口，不与其他轮次的端口表冲突 | 并行期 E/F 各自端口；H 走随机端口 |
| 证据落盘 | 既有 reporter 写 `.artifacts/<用例目录>/` 与 `index.jsonl` | H 的 `mutation-report.md` 只引用这些路径，不回写、不迁移历史证据 | 验收者对照两份报告 |
| 静态自检 | `verify.ts` 核对用例唯一性、fixture 入口、台账引用 | H 闭环前后可选跑一次 `pnpm verify` 确认基线结构未被 patch 破坏；不修改校验规则 | 台账漂移时登记为风险，不在本轮改 spec |

> 这些差异只发生在 H 的运行期窗口内；交付物（脚本、patch、报告）落盘后，被改源码目录不留痕迹。

## 5 产物清单

```text
tools/automated-testing/mutations/
  cancel.patch              M1 取消静默：去掉主进程到执行链的 signal 接线
  answer-set.patch          M2 交卷回读：results 组装丢掉判分字段（questionId/score）
  streaming.patch           M3 工具帧序列：tool-start 转发分支被打乱或删除
  packaged-boot.patch       M4 打包启动：主进程窗口加载 / preload 路径缺陷
  empty-question-set.patch  M5 空题集判定：纯函数恒返回 markdown
tools/automated-testing/scripts/
  run-mutation.ps1          编排：取锁 → 预检 → apply → 红跑 → revert → 绿跑 → 状态校验 → 释放锁
tools/automated-testing/
  mutation-report.md        5 条 mutant 记录 + 31 条基线用例证据索引
```

**写权对齐**（归属矩阵 §1）：

| 产物 | 唯一 owner | 性质 |
|---|---|---|
| `tools/automated-testing/mutations/**` | H | 新建，5 个 patch + 目录内说明 |
| `tools/automated-testing/scripts/run-mutation.ps1` | H | 新建，编排脚本 |
| `tools/automated-testing/mutation-report.md` | H | 新建，人读报告 |
| `apps/desktop/**`、`packages/**` | 无人 | 只读；patch 应用是临时例外，还原后必须无残留 |
| `tools/automated-testing/src/**` | 既有基线 | 只读；H 不改 spec、fixture、driver、client、evidence |

**不产出**：不新增 npm 依赖、不改 `package.json` 与 lockfile、不生成安装包、不改动 `.artifacts/` 下既有取证目录的既有内容（报告索引只引用路径，不回写历史证据）。

**H 读取的既有资产（只读）**：

| 资产 | 路径 | 用途 |
|---|---|---|
| 用例台账 | `tools/automated-testing/src/scenarios/dependencies.ts` | 31 条 TC 编号、标题反查、依赖 ID 索引 |
| 启动 driver | `tools/automated-testing/src/driver/electron-driver.ts`、`env.ts`、`ports.ts`、`processes.ts`、`paths.ts` | 进程启动、环境装配、端口与清理口径 |
| fixtures | `tools/automated-testing/src/fixtures/test.ts`、`home.ts` | home 隔离、app/client/ui fixture 组装 |
| 客户端封装 | `tools/automated-testing/src/client/learning-client.ts`、`chat-events.ts` | 调用面与事件采集 |
| 证据 reporter | `tools/automated-testing/src/evidence/reporter.ts`、`evidence.ts` | 基线状态与证据目录索引来源 |
| 被测实现 | `apps/desktop/src/main/**`、`apps/desktop/src/renderer/src/**`、`packages/agent/src/**` | patch 锚点所在；只读引用，临时改动必须还原 |

**脚本职责边界**（`run-mutation.ps1` 内部步骤，细化到实现方案见后续 `03-implementation.md`）：

1. 解析参数与 patch 清单，`-DryRun` 时只输出计划；
2. 预检工作区干净、取 Electron 锁；
3. 逐条：`git apply` → 跑目标 spec → 按关键词与分类判定 → `git apply -R` → 复跑同一 spec → `git status` 校验；
4. 异常路径在 finally 内完成 revert 与锁释放；
5. 汇总计数并写 `mutation-report.md`，引用既有 `.artifacts/` 取证路径。

脚本不做：不编译桌面端、不打包 release 产物、不修改 spec 与 fixture、不启动 `apps/server`、不读写真实数据目录。

报告条目组织方式（mutant 状态、差异、证据目录分栏）参照成熟 mutation 工具的报告结构，但不引入其运行时 [R60]。

## 6 并行边界

### 6.1 五条并行自证

1. **只读依赖**：`packages/**`（db/agent/questions/profile/artifacts 等全部 workspace 包）与 `apps/desktop/**`（main / renderer / preload）在 H 轮只读引用；唯一例外是 5 个 patch 临时应用于其中文件，且必须随闭环还原。脚本不 import 任何 H 新建模块之外的代码路径改动。
2. **写权唯一**：H 可新建/修改的路径只有 `tools/automated-testing/mutations/**`、`tools/automated-testing/scripts/run-mutation.ps1`、`tools/automated-testing/mutation-report.md`；其余目录出现 H 写入即越权。报告引用既有 `.artifacts/` 路径但不回写。
3. **运行时资源**：Electron 进程由 driver 启动并在 fixture 收尾时清理；本轮临时 home 落在 `.scratch/run/H/` 标记的隔离目录内；端口由既有 `allocatePort` 分配；互斥锁为目录 `.scratch/run/electron.lock`。H 不绑定固定端口、不写共享 DB 副本。
4. **不依赖他轮产物**：31 条用例是仓库既有基线，红/绿对比不依赖 A 的 `apps/server`、E 的契约测试工具、F 的压测产物；M4 复用既有 packaged 构建产物，若产物缺失则该条跳过并写明前置，不阻塞其余 4 条。
5. **冲突裁决**：与 E 的 electron 目标抢同一把锁时，拿不到锁退避重试 30s（每 2s 一次），仍失败则跳过该轮 electron 用例并在报告写明「未取得 electron 锁，本轮 electron 目标未执行」；禁止 `git stash` 清场抢锁，禁止 kill 不明进程。

### 6.2 资源分配表

| 项 | H 轮取值 | 依据 |
|---|---|---|
| 端口 | driver 既有 `allocatePort` 随机空闲端口，不写死 | 归属矩阵 §3 H 行：由 Playwright 分配 |
| 临时数据 | `.scratch/run/H/` 运行标记 + fixture tmpdir 隔离 home | 归属矩阵 §3：不写真实数据目录 |
| 进程名 | 复用既有 Electron 可执行文件；按 userDataDir 片段复查残留 | `electron-driver.ts:160-168` 既有清理逻辑 |
| 锁 | `.scratch/run/electron.lock` 目录原子创建，用完删除 | 归属矩阵 §5 第 3 条 |
| 与 E 的边界 | 两套 mutations 目录互不借用；E 跑 HTTP 目标不碰 Electron 锁 | E 轮 01-scope §6 同口径 |

### 6.3 边界自检命令

```powershell
cd E:\Documents\GitHub\YingXiaoShang

# 工作区干净闸门：闭环前预检、闭环后校验都跑这条；输出必须为空
git status --porcelain apps/desktop packages

# 运行期锁目录：闭环中存在、闭环结束后应不存在
Test-Path .scratch\run\electron.lock

# H 写权范围核对：本轮新增只应出现在这三个路径下
git status --porcelain tools/automated-testing/mutations tools/automated-testing/scripts tools/automated-testing/mutation-report.md

# 残留进程复查：按 H 临时 userDataDir 片段枚举，不应有存活 Electron 进程
# 枚举逻辑复用既有 driver：tools/automated-testing/src/driver/processes.ts:19-44
```

跨轮接口只落在「锁 + 工作区干净状态」两个稳定面上，不发生进程调用或文件互写，这与跨团队只共享薄契约边界的做法一致 [R58]。

## 7 未知与风险

| # | 风险 | 怎么验证这个风险是否发生 |
|---|---|---|
| 1 | patch 应用后未还原：脚本崩溃、终端中断、revert 命令失败导致 `apps/desktop` / `packages` 残留改动 | 每个闭环在 `finally` 块执行 revert；闭环末尾强制跑 `git status --porcelain apps/desktop packages`，输出非空即判失败（退出码 4）并保留现场；报告 `cleanupCheck` 字段记录该命令原文输出 |
| 2 | Electron 抢锁：E 的 electron 目标与 H 同时启动，端口 / userDataDir / 单实例约束互相干扰 | 启动前 `New-Item -ItemType Directory` 原子创建锁目录；已存在则每 2s 退避一次共 30s，仍失败记 `skipped` 并写明未取得锁；收尾时按 userDataDir 片段复查残留进程 |
| 3 | 用例本身不稳定导致假红：模型网关抖动、首窗超时、事件等待超时、偶发 flaky，使 patch 没打坏也变红 | 红例必须同时满足「退出码非 0」与「命中登记关键词」；失败输出分类为断言失败 / 环境错误 / 超时；环境类与超时类不计 killed，记 `ambiguous` 或 `skipped`；绿阶段复跑仍红才判基线回归 |
| 4 | 打包用例依赖 release 产物：源码 patch 改的是 `apps/desktop` 与 `packages` 源文件，packaged asar 是既有构建产物，临时源码改动不进已打包目录 | 跑 M4 前先核对 `release/win-unpacked` 与种子库存在；若需要观察 packaged 行为必须先重新构建拷贝，构建不在本轮交付内；前置缺失时 M4 记 `skipped` 并写明缺失项与验证命令 |
| 5 | patch 锚点漂移：源码被别轮改动后 hunk 上下文不匹配，`git apply` 失败 | apply 前预检工作区干净；apply 失败记 `apply-failed`（退出码 3），报告记录目标文件、锚点行号与 patch 文件名，不强行打补丁、不手工改上下文 |
| 6 | M3 覆盖缺口：`p0-03-chat-stream.spec.ts` 未直接断言 tool / tool-end 配对与顺序，tool 帧转发缺陷可能不被捕获（mutant survived） | 执行后如实登记 `survived`，在报告备注里写明缺口：缺一条「同一工具 tool 先于 tool-end、两帧成对」的事件序列断言；不把 survived 凑成 killed |
| 7 | 真实数据目录被误写：隔离 home 装配失败，进程落到 `%APPDATA%` 或仓库内 `.learning-agent` | fixture `createHome` 强制设置 `LEARNING_AGENT_HOME` 指向 tmpdir 目录并预写空 settings.json；脚本不设置指向真实目录的环境变量；收尾时按 home 路径复查无指向真实目录的进程 |
| 8 | 绿阶段假象：revert 后用例仍然失败，但被误判为基线本身退化 | 绿阶段退出码必须为 0 才算闭环；非 0 记 `green-failed`（退出码 5），报告同时贴红阶段与绿阶段输出摘要，交人区分「还原不彻底」与「基线回归」 |
| 9 | 模型网关未配置或不可达：对话类用例（M1、M3）在红/绿两阶段都跑不到断言 | 闭环前走 `probeGateway` 同等检查；缺失时该条记 `skipped` 并写明缺哪个环境变量，不把网关错误记成 mutant 存活；其余非对话类闭环不受影响 |
| 10 | 台账或 spec 结构漂移：`dependencies.ts` 与 spec 文件对不上，报告 31 行索引缺项 | 闭环前可跑既有 `pnpm verify` 静态自检；索引缺项在报告标 `unknown`，不臆造标题与证据目录；结构问题登记交基线维护者处理 |
| 11 | patch 文件名与 TC 映射对不上：脚本反查台账时找不到目标用例，或一条 mutant 绑了两条 spec | 参数解析阶段校验 `id ↔ patch ↔ TC` 三元组唯一；对不上记 `apply-failed` 类参数错误（退出码 3），不挑默认用例凑数 |
| 12 | 闭环中途断电 / 终端关闭：锁目录残留、patch 未还原 | 下次开工预检先查 `.scratch/run/electron.lock` 是否为残留锁；残留时由人工确认无存活 Electron 进程后再清理；脚本不自动删除他人持有中的锁 |

**基线口径说明**：31 条用例的既有状态以最近一次 `.artifacts/report.md` 为准，H 本轮不承诺把 31 条全部重跑一遍；报告索引里取不到最近结果的条目标 `unknown`，不填通过 / 失败。5 条闭环用例在红、绿两个阶段各跑一次，其余 26 条只登记索引，不注入故障。

风险 1 与 8 的验证都依赖「能被命令量到」：状态校验命令与绿阶段退出码是硬闸门，不能靠人工确认工作区看起来干净 [R59]。

## 参考

- [R52] Stryker JS — https://github.com/stryker-mutator/stryker-js — 支撑 §1 目标 1 与 §3 末尾的 mutation 范式 — 借鉴「改坏一处、用例必须变红」的基本循环与报告思路；不引入 Stryker 运行时，不做 AST 全量变异扫描。
- [R53] Stryker 文档 — https://stryker-mutator.io/docs/ — 支撑 §2 非目标与 §7 风险 6 — 采用 killed / survived 状态术语；不照搬其全量 mutant 矩阵与覆盖率联动。
- [R54] Playwright Electron — https://playwright.dev/docs/api/class-electron — 支撑 §3 证据 3 与 §4 进程启动口径 — 复用既有 `_electron.launch` 通道；spec 不直接 import `_electron`。
- [R34] Playwright 官方文档 — https://playwright.dev/docs/intro — 支撑 §1 目标 3 与 §5 产物清单 — 采用既有 fixture / 断言 / 证据落盘形态；不引入快照测试。
- [R36] JavaScript Testing Best Practices — https://github.com/goldbergyoni/javascript-testing-best-practices — 支撑 §4 进程启动与等待口径 — 采用「禁止固定等待、用轮询断言」的既有约束；不引入其全部工具链。
- [R58] microsoft/playwright — https://github.com/microsoft/playwright — 支撑 §6.2 跨轮边界与配置复用 — 对照其 Electron 测试组织方式；H 不改动 Playwright 配置项。
- [R59] infection — https://github.com/infection/infection — 支撑 §7 风险 1、8 的还原与存活判定 — 借鉴「被测试杀死 / 逃逸存活」的状态二分；不引入 PHP 栈与其测试框架绑定。
- [R60] mutmut — https://github.com/boxed/mutmut — 支撑 §5 产物清单的报告分栏 — 借鉴 mutant 编号、状态、差异与证据分栏结构；不引入 Python 变异运行时。
