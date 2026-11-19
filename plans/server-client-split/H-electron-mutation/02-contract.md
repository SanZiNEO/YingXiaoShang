# H · Electron mutation · 契约

> 轮次：H · Electron mutation 验证
> 文档角色：02-contract
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1 §11（H 临时 patch 例外，应用后必须还原）
> 写权：[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1、§5
> 一句话：5 个 patch 的锚点与改法、脚本参数与退出码、红绿判定口径、报告字段和还原保证全部写死，实现者照着写脚本与 patch，验收者照着判 killed / survived。

## 1 契约总览

| 层 | 冻结口径 | 本轮细化 |
|---|---|---|
| 桌面端兼容 | 冻结 §11：`apps/desktop` 除 H 临时 patch 外零改动；patch 只允许存在于 `tools/automated-testing/mutations/*.patch`，应用后必须还原；`git status --porcelain apps/desktop packages` 为空 | 5 个 patch 的目标文件、锚点行号、改坏方式（§2.2） |
| 文件写权 | 归属 §1：H 拥有 `mutations/**`、`scripts/run-mutation.ps1`、`mutation-report.md`；`packages/**`、`apps/desktop/**` 只读 | 脚本可写路径清单与只读依赖（§6） |
| Electron 互斥 | 归属 §5 第 3 条：`.scratch/run/electron.lock` 目录锁，退避 30s 跳过 | 锁获取/释放时序与报告字段（§5.2） |
| 基线用例 | 冻结 §11：31 条既有用例是回归基线，清单见 `dependencies.ts` | 5 条红例 ↔ TC ↔ 断言 ↔ 关键词映射（§7），其余 26 条只进证据索引 |
| 事件帧 | 冻结 §7.1：`TeamEvent.type` 五值 `round/text/tool/tool-end/session` | 本轮不新增事件名，patch 只打乱既有帧转发（§5.3） |

**契约稳定性**：本文件出现的 mutant 编号（M1–M5）、`status` 枚举值、关键词字符串、脚本参数名视为 v1 冻结。报告字段允许向后新增；删除或改名既有字段需要随轮次升版。mutation 验证采用「故障注入 → 用例捕获 → 存活/被杀」的二分口径 [R52]。

本轮不新增任何业务接口、错误码或端口；所有中文消息沿用桌面端既有 `friendlyError` 目录，patch 不改错误翻译层。

## 2 mutation 与脚本接口契约

### 2.1 `run-mutation.ps1` 参数

脚本路径：`tools/automated-testing/scripts/run-mutation.ps1`。所有命令在仓库根 `E:\Documents\GitHub\YingXiaoShang` 下执行。

| 参数 | 类型 | 必填 | 默认值 | 作用 |
|---|---|---|---|---|
| `-Case <string>` | string | 否 | — | 按 TC 编号（如 `TC-P1-03`）或 spec 文件名定位单个 mutant 闭环；脚本反查台账得到对应 patch id 与目标用例 |
| `-Apply <string>` | string | 否 | — | 只应用指定 patch：取值为 M1–M5 编号或 `mutations/` 下 patch 文件路径；不跑用例、不写报告 |
| `-Revert <string>` | string | 否 | — | 只还原指定 patch；取值同 `-Apply`；不跑用例 |
| `-All` | switch | 否 | `$false` | 按 M1→M2→M3→M4→M5 顺序逐条执行完整闭环 |
| `-DryRun` | switch | 否 | `$false` | 解析参数并打印将执行的命令、锚点与目标用例；不应用 patch、不启动 Electron、不写报告 |
| `-PatchDir <path>` | path | 否 | `tools/automated-testing/mutations` | patch 文件查找目录 |
| `-RepoRoot <path>` | path | 否 | 脚本位置上四级 | 仓库根；`git` 命令与测试入口均相对此路径解析 |

参数组合约束：

- `-Apply` 与 `-Revert` 互斥；同时出现按退出码 3 报参数错误。
- `-Case` 用于闭环；`-Apply` / `-Revert` 用于单边操作。三者都不给且非 `-All` 时，打印用法并退出码 3。
- `-DryRun` 与任意执行参数组合时，只输出计划，不产生副作用。

调用示例：

```powershell
cd E:\Documents\GitHub\YingXiaoShang

# 五条闭环全跑
pwsh tools\automated-testing\scripts\run-mutation.ps1 -All

# 单条闭环：按 TC 编号反查
pwsh tools\automated-testing\scripts\run-mutation.ps1 -Case TC-P1-03

# 单边应用 / 单边还原（排查时用）
pwsh tools\automated-testing\scripts\run-mutation.ps1 -Apply M1
pwsh tools\automated-testing\scripts\run-mutation.ps1 -Revert M1

# 干跑：只看计划
pwsh tools\automated-testing\scripts\run-mutation.ps1 -All -DryRun
```

测试入口复用既有 `pnpm test` 链路：单条用例按 spec 文件路径跑（`playwright test src/scenarios/<file>.spec.ts`），不绕过 `src/driver` 自起进程 [R34]。

### 2.2 五个 patch 逐条契约

| 编号 | patch 文件 | 目标文件:锚点 | 改成什么（diff 意图） | 红用例 TC / spec | 断言位置 | 期望失败关键词 |
|---|---|---|---|---|---|---|
| M1 | `mutations/cancel.patch` | `apps/desktop/src/main/index.ts:485` | `signal: turn.signal,` 改为 `signal: undefined,`：取消控制器不再把 AbortSignal 交进执行链，点停止只断回调、模型请求继续跑 | TC-P1-03 · `src/scenarios/p1-03-cancel.spec.ts` | `:25-26` `cancelled.cancelled` 为真；`:29-31` `waitQuiet` 后文本数不变；`:33-37` settled 为 Error 且消息匹配 `/已停止\|等太久/` | `没有静默`；备选 `toBeInstanceOf(Error)` |
| M1 备选 | 同上 | `apps/desktop/src/main/turn-canceller.ts:19` | `signal: controller.signal` 改为 `signal: new AbortController().signal`：控制器仍存在但永远不 abort | 同上 | 同上 | 同上 |
| M2 | `mutations/answer-set.patch` | `packages/agent/src/index.ts:856` | `results[index] = contentOf(result)` 改为 `results[index] = {}`：交卷结果丢掉 `questionId` / `score` 等判分字段 | TC-P0-06 · `src/scenarios/p0-06-answer-set.spec.ts` | `:50` attempts 20 条；`:53-54` score ∈ [0,1]；`:57-59` `feedback.correct` 为 boolean、`feedback.score` 与落库 score 对齐；`:66-67` 回读 20 条且 score 为 number；`:81-85` results 20 项、`questionId` 为 string、`score` 为 number | `toHaveLength(20)`、`score`、`questionId` |
| M3 | `mutations/streaming.patch` | `packages/agent/src/team.ts:157-160` | 删除 `tool-start` 转发分支（`type: 'tool'` 不再发出），或把 `tool` 与 `tool-end` 帧映射成同型，使工具帧序列错乱 | TC-P0-03 · `src/scenarios/p0-03-chat-stream.spec.ts` | `:23-27` `session` 事件存在且 `sessionId` 非空；`:29-31` `text(lead)` 非空；`:73-75` 第二轮 turnEvents 含 session 与非空 text | `必须收到 session 事件`；`toBeGreaterThan(0)` |
| M3 备选 | 同上 | `packages/agent/src/tool-loop.ts:313` | 移除 `emit({ type: 'tool-start', ... })`，工具开始帧不上抛 | 同上 | 同上 | 同上 |
| M4 | `mutations/packaged-boot.patch` | `apps/desktop/src/main/index.ts:157` | `loadFile(join(app.getAppPath(), 'out', 'renderer', 'index.html'))` 指向不存在的 `out/renderer/missing.html`；或改坏 `:143` preload 路径 | TC-P0-08 · `src/scenarios/p0-08-packaged-boot.spec.ts` | `:31` `app.kind` 为 packaged；`:32` `health.ok` 为真；`:34` 种子库存在；`:37-39` 窗口数 1 且标题含 `营小商`；`:42-44` URL 含 `app.asar`；`:50-51` `appPath` / `resourcesPath` 落 packaged 目录；`:53-56` 种子库 size>0 且 `user_version` 为 7 | `营小商`、`app.asar`、`user_version`、`learning.db` |
| M5 | `mutations/empty-question-set.patch` | `apps/desktop/src/renderer/src/question-set.ts:12` | `artifact.content.trim().length > 0 ? 'markdown' : 'retry'` 恒返回 `'markdown'`：空题集判定被打穿 | TC-P1-02 · `src/scenarios/p1-02-empty-question-set.spec.ts` | `:12` 有内容 → `markdown`；`:13` 空白 → `retry`；`:47-48` 兜底文案两条；`:59-61` 空题集下 `question-set` / `question-submit` 计数为 0 | `retry`、`question-set` |

patch 文件头注释必须包含：mutant 编号、目标文件、锚点行号、对应 TC、冻结参考版本；hunk 上下文只引用现状代码，不带修复、不带格式化改动。

### 2.3 单条闭环命令序列

以 M1 为例（其余编号替换即可）：

```powershell
cd E:\Documents\GitHub\YingXiaoShang

# 1. 预检工作区干净
git status --porcelain apps/desktop packages

# 2. 应用 patch
git apply --verbose tools/automated-testing/mutations/cancel.patch

# 3. 红跑：跑对应 spec
pnpm --dir tools/automated-testing test -- src/scenarios/p1-03-cancel.spec.ts

# 4. 还原（闭环 finally 内执行）
git apply -R --verbose tools/automated-testing/mutations/cancel.patch

# 5. 绿跑：同一 spec 复跑
pnpm --dir tools/automated-testing test -- src/scenarios/p1-03-cancel.spec.ts

# 6. 还原校验
git status --porcelain apps/desktop packages
```

### 2.4 stdout 契约

每个阶段输出一行，格式 `[<M-id>] <PHASE> <detail>`；脚本头与尾输出全局行。阶段标签枚举：

| PHASE | 含义 |
|---|---|
| `PRECHECK` | 工作区预检与基线状态快照 |
| `LOCK` | 取锁 / 锁已存在 / 释放 |
| `APPLY` | 应用 patch，贴 `git apply` 退出码 |
| `RED-RUN` | 红阶段跑用例，贴命令与退出码 |
| `REVERT` | 反向还原，贴退出码 |
| `GREEN-RUN` | 绿阶段复跑，贴命令与退出码 |
| `STATUS-CHECK` | 还原后工作区校验，贴 porcelain 输出（应为空） |
| `SKIP` | 前置不可用，该条跳过及原因 |

示例输出：

```text
[H] repo-root: E:\Documents\GitHub\YingXiaoShang
[H] lock: acquired
[M1] PRECHECK git status --porcelain apps/desktop packages -> clean
[M1] APPLY git apply tools/automated-testing/mutations/cancel.patch exit=0
[M1] RED-RUN pnpm --dir tools/automated-testing test -- src/scenarios/p1-03-cancel.spec.ts exit=1
[M1] RED keywords-hit=[没有静默] classification=assertion
[M1] REVERT git apply -R tools/automated-testing/mutations/cancel.patch exit=0
[M1] GREEN-RUN pnpm --dir tools/automated-testing test -- src/scenarios/p1-03-cancel.spec.ts exit=0
[M1] STATUS-CHECK git status --porcelain apps/desktop packages -> clean
[H] lock: released
SUMMARY killed=4 survived=1 skipped=0 apply-failed=0 revert-failed=0
```

stdout 不打印 token、口令、消息正文；失败输出摘要只取首条断言消息与分类，完整日志沿用既有 `.artifacts/` 取证目录。

## 3 数据结构

### 3.1 `mutation-report.md` 顶层结构

报告为 Markdown 人读件，分四节；字段约定同时作为后续可选 JSON 导出的结构基线。报告分栏（mutant 状态、命令、输出摘要、证据目录）参照成熟 mutation 工具的记录结构 [R60]：

| 字段 | 类型 | 可空 | 来源 | 说明 |
|---|---|---|---|---|
| `round` | string | 否 | 固定 `"H"` | 轮次标识 |
| `generatedAt` | string(ISO8601) | 否 | 脚本生成时刻 | 本地时间带时区偏移 |
| `repoRoot` | string | 否 | `-RepoRoot` | 报告生成时的仓库根路径 |
| `branch` | string | 否 | `git branch --show-current` | 基线分支 |
| `baselineCleanBefore` | boolean | 否 | `PRECHECK` 输出 | 应用 patch 前 `apps/desktop packages` 是否干净 |
| `lockAcquired` | boolean | 否 | `LOCK` 阶段 | 本轮是否取得 Electron 锁 |
| `scriptVersion` | string | 否 | ps1 头部注释版本 | 报告口径版本 |
| `baselineIndex` | `BaselineIndexRow[]` | 否 | 台账 + 既有 `.artifacts/` 索引 | 31 行，顺序按 TC 编号排序 |
| `mutations` | `MutantRecord[]` | 否 | 闭环执行记录 | 5 条，M1–M5 |
| `summary` | object | 否 | 统计 | `killed` / `survived` / `skipped` / `applyFailed` / `revertFailed` / `greenFailed` 计数 |

### 3.2 `MutantRecord` 字段

| 字段 | 类型 | 可空 | 来源 | 示例 / 说明 |
|---|---|---|---|---|
| `id` | string | 否 | 固定 M1–M5 | 与 patch 文件名一一对应 |
| `patch` | string | 否 | `-PatchDir` 相对路径 | `tools/automated-testing/mutations/cancel.patch` |
| `targetFile` | string | 否 | patch 头注释 | `apps/desktop/src/main/index.ts` |
| `anchorLine` | number | 否 | patch 头注释 | `485` |
| `defectSummary` | string | 否 | 契约 §2.2 | 一句话说明改坏了什么 |
| `targetCase` | object | 否 | 台账反查 | `{ "tc": "TC-P1-03", "spec": "src/scenarios/p1-03-cancel.spec.ts" }` |
| `status` | enum | 否 | 判定 §4 | `killed` / `survived` / `skipped` / `apply-failed` / `revert-failed` / `green-failed` |
| `apply.command` | string | 否 | 脚本 | `git apply --verbose <patch>` |
| `apply.exitCode` | number | 否 | 进程退出码 | 0 为成功 |
| `apply.appliedAt` | string(ISO8601) | 否 | 阶段时刻 | 应用完成时刻 |
| `red.command` | string | 否 | 脚本 | 红阶段测试命令 |
| `red.exitCode` | number | 否 | Playwright 退出码 | 非 0 才可能判红 |
| `red.outputExcerpt` | string | 是 | 测试输出首条断言消息 | 截断到单行，堆栈不进报告 |
| `red.keywordsHit` | string[] | 否 | 关键词匹配 | 命中的登记关键词列表，可为空 |
| `red.classification` | enum | 否 | 失败分类 | `assertion` / `env-error` / `timeout` / `ambiguous` |
| `revert.command` | string | 否 | 脚本 | `git apply -R --verbose <patch>` |
| `revert.exitCode` | number | 否 | 进程退出码 | 非 0 记 `revert-failed` |
| `revert.revertedAt` | string(ISO8601) | 否 | 阶段时刻 | 还原完成时刻 |
| `green.command` | string | 否 | 脚本 | 绿阶段测试命令，与红阶段同一用例 |
| `green.exitCode` | number | 否 | Playwright 退出码 | 0 为恢复绿色 |
| `green.outputExcerpt` | string | 是 | 测试输出 | 绿阶段非 0 时贴首条消息 |
| `cleanupCheck.command` | string | 否 | 脚本 | `git status --porcelain apps/desktop packages` |
| `cleanupCheck.clean` | boolean | 否 | 校验输出 | 输出为空才为 true |
| `cleanupCheck.output` | string | 否 | porcelain 原文 | 非空时原样贴出 |
| `notes` | string | 是 | 脚本 / 人工 | 覆盖缺口、跳过原因、人工介入说明 |

状态枚举口径：

| status | 含义 |
|---|---|
| `killed` | 红阶段符合红判据，还原后绿阶段为 0，工作区干净 |
| `survived` | 补丁应用后目标用例仍绿（退出码 0），mutant 未被捕获 |
| `skipped` | 前置不可用：锁未取得、packaged 产物缺失、种子库缺失 |
| `apply-failed` | `git apply` 失败，锚点漂移或上下文不匹配 |
| `revert-failed` | 反向还原失败，工作区可能残留本 patch 改动 |
| `green-failed` | 还原后绿阶段仍红：基线回归或还原不彻底 |

### 3.3 31 行基线索引字段

| 字段 | 类型 | 可空 | 来源 | 说明 |
|---|---|---|---|---|
| `tc` | string | 否 | `dependencies.ts:5-37` 键 | `TC-P0-01` … `TC-P1-18`，共 31 行 |
| `title` | string | 是 | 既有 spec 标题 / `.artifacts/index.jsonl` | 取不到标空，不臆造 |
| `deps` | string[] | 否 | `depsOf(tc)` | 实现侧 ID 列表 |
| `evidenceDir` | string | 是 | 既有 reporter 索引 | `.artifacts/<用例目录>/` 相对路径 |
| `baselineStatus` | enum | 否 | `.artifacts/report.md` 最近一次结果 | `passed` / `failed` / `blocked` / `unknown`；未跑过标 `unknown` |
| `runRef` | string | 否 | 固定命令模板 | `pnpm --dir tools/automated-testing test -- -g <tc>` |

索引只引用既有取证产物，不回写历史 `.artifacts/` 内容；H 本轮不要求 31 条全部重跑，基线索引状态取自最近一次既有报告。

### 3.4 关键词与枚举来源

- 关键词字符串取自既有 spec 的断言消息与 `chat-events.ts:83` 既有抛错文本，不自造英文断言。
- `classification` 枚举依据失败输出形态归类：断言库消息归 `assertion`；启动 / 端口 / 产物 / 网关归 `env-error`；`waitFor` / `waitQuiet` / 事件等待超时归 `timeout`；退出码非 0 但既不命中关键词也不归入前两类归 `ambiguous`。

## 4 错误与消息

### 4.1 退出码契约

| 退出码 | 含义 | 触发条件 | 报告记录 |
|---|---|---|---|
| 0 | 全部闭环符合预期 | 每条闭环 killed 或按约定 skipped；`-DryRun` 解析成功 | `summary` 计数齐全 |
| 1 | 存在 survived | 至少一条 mutant 应用后目标用例仍绿 | 该条 `status=survived`，贴绿阶段输出 |
| 2 | 前置不可用 | 锁 30s 内未取得；packaged 产物 / 种子库缺失；driver 启动环境不可用 | 该条 `status=skipped`，`notes` 写明缺失项 |
| 3 | 参数或 apply 失败 | 参数互斥 / 未识别；`git apply` 锚点漂移、上下文不匹配 | 该条 `status=apply-failed`，记录锚点与 patch |
| 4 | 还原失败或工作区脏 | `git apply -R` 非 0；`STATUS-CHECK` porcelain 非空 | 该条 `status=revert-failed`，贴残留文件清单，人工介入 |
| 5 | 绿阶段仍红 | 还原后同一用例退出码非 0 | 该条 `status=green-failed`，红/绿两段输出都贴 |

退出码不与桌面端产品错误码混用：脚本自身错误只用上述 0–5 编码，产品中文消息仍走 `friendlyError` 既有目录（`apps/desktop/src/main/errors.ts:13-67`）。

### 4.2 红 / 绿判定口径

**算红（候选 killed）**，三条同时成立：

1. 红阶段 Playwright 退出码非 0；
2. 失败输出命中该 mutant 登记关键词列表至少一条；
3. `classification=assertion`（断言失败，不是环境或超时）。

**算绿**：还原后绿阶段同一用例退出码 0，且无新的断言失败；`STATUS-CHECK` 干净。

**假红不计 killed**：

- `env-error`：driver 起不来、端口被占、种子库 / packaged 产物缺失、模型网关不可达；
- `timeout`：事件等待或静默等待超时，且输出不含登记关键词；
- `ambiguous`：退出码非 0 但关键词未命中，失败分类无法归入断言失败。

以上三类记 `skipped` 或在 `notes` 标 `ambiguous`，输出摘要保留备查，但不计入 killed 计数。环境类抖动的复核方法：绿阶段复跑通过即视为不稳定；绿阶段仍红转 `green-failed` 交人区分基线回归与还原不彻底 [R59]。

### 4.3 脚本自身消息

- 参数错误：中文一行说明哪个参数组合不合法，附用法示例；退出码 3。
- 锁未取得：`未取得 electron 锁，本轮 electron 目标未执行`；退出码 2。
- 工作区预检非空：`应用 patch 前工作区不干净，中止`；退出码 4，不应用任何 patch。
- 还原失败：`反向还原失败，工作区可能残留改动，请人工核对`；退出码 4，不自动丢弃文件。

## 5 事件与序列

### 5.1 闭环时序（文字版）

```text
脚本启动
  ├─ PRECHECK：git status --porcelain apps/desktop packages；非空 → 退出 4
  ├─ LOCK：New-Item .scratch/run/electron.lock（原子创建）
  │     已存在 → 每 2s 退避，共 30s → 仍失败：SKIP 本轮 electron 目标
  ├─ 对每个 mutant（-All）：
  │     ├─ APPLY：git apply --verbose <patch>；失败 → apply-failed，继续下一条
  │     ├─ RED-RUN：跑目标 spec；采集退出码 / 输出 / 关键词命中 / 分类
  │     ├─ 判定：按 §4.2 记 killed / survived / ambiguous
  │     ├─ REVERT：git apply -R --verbose <patch>（finally 块，异常也执行）
  │     ├─ GREEN-RUN：同一 spec 复跑；非 0 → green-failed
  │     └─ STATUS-CHECK：porcelain 为空；非空 → revert-failed
  ├─ 汇总 SUMMARY 计数
  └─ LOCK：Remove-Item .scratch/run/electron.lock（finally 块）
```

任何阶段抛出未捕获异常，脚本进入 finally：先尝试 revert 当前 patch，再释放锁，最后以对应退出码退出；不允许带着锁和残留改动结束。

### 5.2 锁时序

- 锁载体：目录 `.scratch/run/electron.lock`，`New-Item -ItemType Directory -ErrorAction Stop` 原子创建；已存在即视为占用。
- 退避：每 2s 重试一次，总等待 30s（约 15 次）；超时记 `skipped`，`lockAcquired=false`。
- 释放：闭环全部结束后 `Remove-Item -LiteralPath .scratch/run/electron.lock`；脚本异常退出路径同样执行释放。
- 禁止事项：不用 `git stash` 清场抢锁；不 kill 不明进程；占用者是自己历史进程时先记 PID 再按既有 driver 清理逻辑处理。

### 5.3 既有事件帧口径（本轮不新增）

- 帧类型集合冻结为 `packages/agent/src/team.ts:17-19` 的 `round | text | tool | tool-end | session`；patch 只能删除、重复或错序既有帧，不引入新类型。
- `session` 事件在会话建立时立即发出：`packages/agent/src/index.ts:413`；M3 的对照基线是该帧先于失败调用到达界面。
- 工具帧映射：`tool-start` → `tool`，`tool-end` → `tool-end`（`team.ts:157-169`）；loop 侧 `tool-start` 发于 `packages/agent/src/tool-loop.ts:313`，`tool-end` 发于 `:343-350`。
- H 不改动 SSE / IPC 通道名；通道清单仍以冻结 §7 与 `apps/desktop/src/main/index.ts:445-528` 既有注册为准 [R54]。

## 6 兼容与版本

- **既有测试资产只读**：spec、fixture、driver、client、pages、evidence 全部不改；脚本只通过 `pnpm test` / `playwright test` 入口调用，不复制一份启动逻辑。
- **patch 临时性**：patch 内容只存在于 `mutations/*.patch`；应用期间改动的源码文件在闭环内还原，交付物里不保留对 `apps/desktop`、`packages` 的修改建议 diff 之外的常驻改动。
- **构建产物范围**：还原校验只覆盖 `apps/desktop`、`packages` 的 git 跟踪文件；`out/`、`release/` 构建产物不在 porcelain 校验范围内。M4 观察 packaged 行为所需的重新构建属于前置准备，不在本轮交付物内。
- **字段版本**：报告字段允许新增；mutant 编号、`status` 枚举、关键词字符串、ps1 参数名 v1 冻结；后续轮次复用 H 报告时只允许读字段，不得改语义。
- **与 E 的隔离**：E 的服务端 mutation 落在 `tools/contract-tests/mutations/`，H 的桌面端 mutation 落在 `tools/automated-testing/mutations/`，两套目录互不借用、互不引用；E 跑 HTTP 目标不碰 Electron 锁，H 不调用 `apps/server`。
- **源码锚点漂移处理**：patch 头注释记录冻结参考版本与锚点行号；源码被别轮改动导致 apply 失败时，记 `apply-failed`，不自动重写 hunk 上下文，交人核对后更新 patch。

mutation 状态二分与「未被捕获的变异逃逸存活」语义沿用成熟工具的通行口径 [R53]。

## 7 测试映射

| Mutant | patch | TC | spec 文件 | 既有断言位置 | 命中关键词 | 基线索引条目 |
|---|---|---|---|---|---|---|
| M1 | `cancel.patch` | TC-P1-03 | `src/scenarios/p1-03-cancel.spec.ts` | `:25-37` | `没有静默` / `toBeInstanceOf(Error)` | 索引行 `TC-P1-03`，deps 来自 `dependencies.ts:21` |
| M2 | `answer-set.patch` | TC-P0-06 | `src/scenarios/p0-06-answer-set.spec.ts` | `:46-85` | `toHaveLength(20)` / `score` / `questionId` | 索引行 `TC-P0-06`，deps 来自 `dependencies.ts:11` |
| M3 | `streaming.patch` | TC-P0-03 | `src/scenarios/p0-03-chat-stream.spec.ts` | `:22-31`、`:73-75` | `必须收到 session 事件` / `toBeGreaterThan(0)` | 索引行 `TC-P0-03`，deps 来自 `dependencies.ts:8` |
| M4 | `packaged-boot.patch` | TC-P0-08 | `src/scenarios/p0-08-packaged-boot.spec.ts` | `:30-56` | `营小商` / `app.asar` / `user_version` / `learning.db` | 索引行 `TC-P0-08`，deps 来自 `dependencies.ts:13` |
| M5 | `empty-question-set.patch` | TC-P1-02 | `src/scenarios/p1-02-empty-question-set.spec.ts` | `:12-13`、`:47-61` | `retry` / `question-set` | 索引行 `TC-P1-02`，deps 来自 `dependencies.ts:20` |

其余 26 条基线用例（p0 其余 12 条 + p1 其余 17 条）不绑定 mutant，只出现在 `baselineIndex` 31 行索引中；它们的回归状态沿用既有报告，H 本轮不为它们注入故障。

测试组织上沿用既有约定：一条 TC 一个 spec 文件、标题首段写 TC 编号、断言走 locator / `expect.poll` / 事件收集器，不用固定等待 [R36]。M3 若执行后 `survived`，缺口是「tool 与 tool-end 配对顺序无直接断言」，该缺口写进报告 `notes`，作为后续补断言的输入，不在本轮 spec 里临时加断言。

## 参考

- [R52] Stryker JS — https://github.com/stryker-mutator/stryker-js — 支撑 §1 契约总览的 killed/survived 二分 — 借鉴 mutant 与用例对应的报告结构；不引入 AST 变异运行时。
- [R53] Stryker 文档 — https://stryker-mutator.io/docs/ — 支撑 §6 兼容与版本的状态术语 — 采用 killed / survived 命名；不照搬全量扫描与覆盖率联动。
- [R54] Playwright Electron — https://playwright.dev/docs/api/class-electron — 支撑 §5.3 既有事件帧与启动口径 — 复用 `_electron` 通道；不新增测试启动路径。
- [R34] Playwright 官方文档 — https://playwright.dev/docs/intro — 支撑 §2.1 测试入口与 fixture 复用 — 采用既有 test/expect 封装；不引入快照测试。
- [R36] JavaScript Testing Best Practices — https://github.com/goldbergyoni/javascript-testing-best-practices — 支撑 §7 测试映射的等待与断言约定 — 采用轮询断言、禁止 sleep；不引入其工具链。
- [R58] microsoft/playwright — https://github.com/microsoft/playwright — 支撑 §2.3 命令序列与配置复用 — 对照其 Electron 测试运行方式；不改既有 `playwright.config.ts`。
- [R59] infection — https://github.com/infection/infection — 支撑 §4.2 假红分类与存活判定 — 借鉴断言失败与环境错误的区分；不引入 PHP 框架绑定。
- [R60] mutmut — https://github.com/boxed/mutmut — 支撑 §3 报告字段分栏 — 借鉴 mutant 编号、状态、diff 与证据分栏；不引入 Python 运行时。
