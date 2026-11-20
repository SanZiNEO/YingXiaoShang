# E 轮 mutation 回放（apply / revert）

本目录是 3 条临时变异（mutation）的声明式规格与回放驱动。对应 `plans/server-client-split/E-contract-tests/02-contract.md` §10、`04-acceptance.md` §5、`01-scope.md` §7。

## 1. 三条 mutation 一览

| 编号 | 规格模块 | 落点（A 轮路径） | 临时改动 | 应变红用例 | 目标命令 |
|---|---|---|---|---|---|
| M1 | `m1-drop-done.mjs` | `apps/server/src/chat/stream.ts` | 移除 SSE 终态 `done` 帧发送 | `E-070` | `node run.mjs --target http --only E-070` |
| M2 | `m2-loosen-limit.mjs` | `apps/server/src/rpc/validate.ts` | 放开 `limit` 整数 / 上下限校验，越界值放行 | `E-034` | `node run.mjs --target http --only E-034` |
| M3 | `m3-enum-29.mjs` | `docs/contracts/openapi.yaml` | method 枚举删 1 项，30 → 29 | `E-077` | `node coverage.mjs` |

状态口径（借鉴 Stryker 术语，04-acceptance §5）：

- `killed`：应用变异后目标用例变红（目标命令退出码 1），说明该用例覆盖到了这条契约；
- `survived`：应用变异后目标用例仍为绿色（退出码 0），或命令以非断言失败口径退出（2/3）未形成变红证据，按 survived 保守记录；
- `not-run`：准入未通过，本轮不回放；reason 分两类原样记录：目标文件不存在（A 轮未交付）；或文件存在但单文件 git 状态不干净（`??` 未跟踪 / ` M` 已修改 / `D` 删除等，其它轮次改动中）；
- `anchor-miss`：文件存在，但所有锚点候选都无法在文件里唯一定位，未改动文件；
- `revert-failed`：还原后字节不一致或 `git status` 仍有改动，必须人工介入。

## 2. 为什么是声明式规格，而不是静态 `.patch`

计划文档（01-scope §5、02-contract §10）早期写法是 `mutations/*.patch` 静态补丁文件；本切片按验收要求改为声明式规格模块（`*.mjs`），理由：

1. **不能硬编码不存在的 diff**。A 轮产物虽已落盘，但整体仍是未跟踪目录（`?? apps/server/`、`?? docs/contracts/`），并行隔离准入拦截、工作区不干净；静态 `.patch` 的上下文行无法从干净工作区取出，若手写一份补丁固化进仓库，验收时也无法证明它真的能 apply。
2. **diff 在运行时生成并落盘**。回放时先备份原字节，再按规格里的 `anchor → replace` 写出变异内容，由 `src/patch.mjs` 自己按行比对生成 unified diff，存到 `<reportDir>/mutations/<id>.diff`；落盘的是「本次真实发生过的改动」，不是预置文本。
3. **原字节还原 + 干净状态复查**。回放窗口结束前把备份字节写回原文件，读回后逐字节 `Buffer.equals` 复核，再跑 `git status --porcelain <file>` 确认为空；还原失败记 `revert-failed`，退出码非 0。整个过程不使用 `git checkout` / `git stash` / `git reset`。
4. **规格可审计**。每条规格只声明 `id / title / file / targetCase / targetCommand / redExpectation / edits / notRunWhenMissing`，不写死「已杀死 / survived」结论，也不预置结果；变红还是变绿只由目标命令的实际退出码决定。

## 3. 回放机制（`src/patch.mjs`）

导出：

- `MUTATIONS`：三条规格数组，按 id 排序；
- `inspectAll({ repoRoot })`：只读检查，返回每条的 `status: runnable | not-run`、`reason`、`missingPaths`；
- `runMutations({ repoRoot, reportDir, only })`：逐条回放，流程为
  1. **准入（两条同时成立才允许 apply）**：目标文件存在；且该文件的单文件 `git status --porcelain -- <文件>` 为空。文件不存在 → `not-run`（A 轮未交付）；状态非空（`??` 未跟踪 / ` M` 已修改 / `D` 删除等任何标记）→ `not-run`（其它轮次改动中），不写入被测文件；
  2. 准入通过后解析锚点：`anchor` 优先，其后按 `anchorAlternatives` 顺序尝试，只接受全文恰好命中 1 次的候选；全部不唯一或不存在 → `anchor-miss`，文件不动；
  3. 备份原字节（内存）→ 写入变异内容 → 生成 unified diff 落盘；
  4. `spawn` 目标命令（cwd = `tools/contract-tests`），捕获 stdout / stderr / 退出码；
  5. 还原：只用 apply 前保存的原字节备份写回 → 逐字节复核 → 再对同一单文件跑 `git status --porcelain`，确认与 apply 前快照一致；
  6. 按退出码判 `killed`（1）/ `survived`（0 或其他）。任一步失败不强行继续，`finally` 内保证还原；
- `summarizeForReport({ repoRoot })`：供 `run.mjs` 汇总 `report.json` 的只读快照，未跑过时 `applied: false`、`status: not-run`；not-run 原因分两类原样保留：文件不存在（A 轮未交付）/ 文件存在但状态不干净（其它轮次改动中）。

CLI（`node src/patch.mjs` 直接调用；被 import 时不执行副作用）：

```powershell
cd tools\contract-tests
node src/patch.mjs --inspect                      # 只读检查
node src/patch.mjs --run                          # 回放全部
node src/patch.mjs --run --only M1 --only M3     # 只回放选中项
node src/patch.mjs --run --report <目录>          # 指定 diff 落盘目录
```

PowerShell 驱动：

```powershell
powershell -NoProfile -File mutations\apply-revert.ps1
powershell -NoProfile -File mutations\apply-revert.ps1 -Only M1 -Report .scratch\run\E\mutations-report
```

## 4. 锚点策略与 A 轮落地后的验证方式

### M1 · `apps/server/src/chat/stream.ts`

- 规格现有候选：首选 SSE 事件名字面量 `event: done`；兜底为辅助函数调用 `sendEvent(res, 'done',` / `writeEvent(res, 'done',` / `emitSse(res, 'done',`。
- **2026-11-20 只读干跑实测**：四个候选在 `stream.ts` 均 0 命中；文件内也没有 `'done'` 字符串字面量。
- 真实形态（只读核实）：`stream.ts` 经 `SseWriter` 辅助类发帧，done 终态调用在 **L120 `writer.done({`**（载荷 L120–129）；辅助类实现在 `apps/server/src/http/sse.ts` L54–58 的 `done(payload)`，内部调 `this.send('done', payload)`。L66、L137 的 `turns.done(meta.requestId)` 是注册表清理，语义不同，不能当 done 帧锚点。
- **入库后预判：预计 anchor-miss**。现有候选在真实实现里全部 0 命中；回放前需把锚点刷新为整段 `writer.done({ ... })` 调用语句——单行只替换函数头会留下悬空对象字面量导致编译错误，故规格里暂不补半成品候选。锚点刷新后回放 `E-070`，缺 `done` 时 `eventOrder` 断言必须变红，还原后复跑恢复 `passed`。

### M2 · `apps/server/src/rpc/validate.ts`

- 规格候选：首选逐字消息 `limit 必须是 1 到 200 的整数。`；其后 `limit < 1 || limit > 200`、`limit > 200 || limit < 1`、`Number.isInteger(limit)`；兜底两条是 A 轮通用校验器内的真实守卫：上下限整句、整数判定整句。
- **2026-11-20 只读干跑实测（第二轮已刷新）**：前四个候选在 `validate.ts` 均 0 命中；兜底候选各唯一命中：
  - `if (value < options.min || value > options.max) fail(options.message, key)`（上下限守卫，1 次）；
  - `if (!Number.isInteger(value)) fail(INTEGER_MESSAGE(key), key)`（整数守卫，1 次）。
- 真实形态（只读核实）：`validate.ts` 是通用数字校验器，范围消息由调用方经 `options.message` 传入，类型错消息由本文件按参数名拼（`${key} 必须是整数。`）；`news.list` 的 `limit 必须是 1 到 200 的整数。` 字面量实际落在 `src/rpc/handlers/content.ts:57`（`optionalNumber(params, 'limit', { min: 1, max: 200, message: 'limit 必须是 1 到 200 的整数。' })`）。
- **入库后预判：预计可跑通**，兜底命中上下限守卫整句（整数守卫备选）。注意：中和通用守卫会同时放开所有数字参数的对应校验，不止 `limit`；回放 `E-034`（`limit=99999`），放开后实际 200，`httpStatus` 与 `errorCode` 断言必须变红，还原后复跑恢复 `passed`。是否把锚点改到 handler 层（`content.ts:57`）留待拍板。

### M3 · `docs/contracts/openapi.yaml`

- 规格候选：首选枚举列表行 `- news.list`；兜底 `- kps.list` / `- artifacts.list` / `- agent.sessions`。
- **2026-11-20 只读干跑实测**：枚举块在 L223–253（30 项）；`- news.list` **L227 唯一命中**，三条兜底分别在 L226（`- kps.list`）、L238（`- artifacts.list`）、L253（`- agent.sessions`）各唯一命中；L657、L824 另有 `method:` 字段但无枚举，不构成重复。
- **入库后预判：预计跑通**。回放 `node coverage.mjs`，删项后 `E-077` 的 `missing` 必须列出被删方法、`ok=false`，还原后复跑恢复 `ok=true`。

## 5. 当前状态（2026-11-20 复测，A 轮产物已落盘）

三个目标文件均已存在，但整体仍属未跟踪目录（宽路径 `git status --porcelain`：`?? apps/server/`、`?? docs/contracts/`）。按双条件准入（文件存在 **且** 单文件状态为空），三条全部被拦截为 `not-run`，未对被测文件做任何写入或还原：

| 编号 | 目标文件 | 当前准入状态 | 单文件 git 标记（reason 原文） | 入库且工作区干净后的锚点预判 |
|---|---|---|---|---|
| M1 | `apps/server/src/chat/stream.ts` | `not-run`（改动中） | `目标文件被其它轮次改动中（git status: ?? apps/server/src/chat/stream.ts）` | **预计 anchor-miss**：现有四候选 0 命中；真实 done 调用在 L120 `writer.done({`，需刷新为整段调用语句锚点 |
| M2 | `apps/server/src/rpc/validate.ts` | `not-run`（改动中） | `目标文件被其它轮次改动中（git status: ?? apps/server/src/rpc/validate.ts）` | **预计可跑通**：兜底命中 L39 上下限守卫（L38 整数守卫备选）；limit 专属消息在 `handlers/content.ts:57` |
| M3 | `docs/contracts/openapi.yaml` | `not-run`（改动中） | `目标文件被其它轮次改动中（git status: ?? docs/contracts/openapi.yaml）` | **预计跑通**：`- news.list` L227 唯一命中 |

`not-run`（文件缺失 / 状态不干净）与 `anchor-miss` 都是设计内的安全分支：前置未就绪、并行改动中或锚点漂移时不改被测文件，reason 如实写明，不把它当成断言失败，也不编造「已杀死」结论。上述预判来自只读干跑（`.scratch/run/E/selftest/anchor-dryrun.mjs`，仅 `fs.readFileSync`，不写被测文件）；待文件入库且工作区干净后，先按 §6 核对锚点唯一性，再复跑上述命令进入 `runnable` 分支，预判以实际回放结果为准。

## 6. 锚点漂移时怎么维护

- **候选失效**：A 轮调整了函数名或消息文案 → 先在被测文件里 `Select-String` 找到新的唯一上下文片段，把它补进对应规格的 `anchorAlternatives` 队尾（或替换失效候选）；不要为了命中而放宽到会出现多次的短片段。
- **唯一性被破坏**：某候选在文件里出现 ≥2 次 → 运行时判 `anchor-miss`，不会强行改写；此时把锚点换成包含更多上下文的整行（含相邻字段名 / 变量名），保证全文唯一。
- **落点路径变化**：A 轮最终目录与冻结路径不一致时，只改规格模块的 `file` 字段；`targetCase` / `targetCommand` 跟着 02-contract §10 映射表核对。
- **维护纪律**：锚点是 E 轮的责任（01-scope §7.4），不靠 A 留接口；每次改完规格，先 `node src/patch.mjs --inspect` 确认文件可达，再回放单条 `--only` 验证变红与还原。

## 7. 安全边界

- 并行隔离准入：目标文件存在**且**单文件 `git status --porcelain -- <文件>` 为空才 apply；未跟踪（`??`）、已修改（` M`）、删除（`D`）等任何状态都记 not-run，不往其它轮次未提交的实现里写字节；
- 被测文件只在回放窗口内被「原字节备份 → 写入 → 还原」，窗口外零改动；
- 还原只用 apply 前保存的原字节备份写回并逐字节复核；不删除 report 目录之外的任何文件；不执行 `git checkout` / `git stash` / `git reset`，也不做宽路径 checkout；
- 报告与日志只落退出码、截断后的 stdout/stderr 摘要与 diff，不写 token、口令、消息正文；
- 本目录纯 `.mjs`（驱动脚本为 `.ps1`），不引第三方依赖。
