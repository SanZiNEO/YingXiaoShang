# H 轮 mutation patch 目录

本目录存放 H 轮（Electron 用例变红）5 个故障注入用的最小 git 补丁。每个 patch 只改一处语义（一行或一个 hunk），锚点一律取 `plans/server-client-split/H-electron-mutation/02-contract.md` §2.2 的契约点；应用后必须按下方流程还原，`apps/desktop/**`、`packages/**` 不留常驻改动。

## 1. patch 清单

| Mutant | patch 文件 | 目标文件:锚点行号 | 对应 TC | 红例 spec 与断言位置 | 改坏语义 | 期望失败关键词 | 预期状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M1 | `cancel.patch` | `apps/desktop/src/main/index.ts:485` | TC-P1-03 | `tools/automated-testing/src/scenarios/p1-03-cancel.spec.ts:25-37`（:31 取消后文本长度不变；:34 `toBeInstanceOf(Error)`） | 取消控制器不再把 AbortSignal 交进执行链——点「停止」只断界面回调，在途模型请求继续跑（历史假停缺陷）。 | `没有静默` / `toBeInstanceOf(Error)` | killed |
| M2 | `answer-set.patch` | `packages/agent/src/index.ts:856` | TC-P0-06 | `tools/automated-testing/src/scenarios/p0-06-answer-set.spec.ts:46-85`（:81 results 20 项；:83-84 `questionId` 为 string、`score` 为 number） | 交卷返回的 results 丢掉 questionId / score 等判分字段（DB 落库链路不动）。 | `toHaveLength(20)` / `score` / `questionId` | killed |
| M3 | `streaming.patch` | `packages/agent/src/team.ts:157-160` | TC-P0-03 | `tools/automated-testing/src/scenarios/p0-03-chat-stream.spec.ts:22-31`（:24 `必须收到 session 事件`）、`:73-75` | 删除 `tool-start` → `type:'tool'` 转发分支，工具开始帧不再上抛（`tool-end` 仍发出）。 | `必须收到 session 事件` / `toBeGreaterThan` | **survived**（覆盖缺口） |
| M4 | `packaged-boot.patch` | `apps/desktop/src/main/index.ts:157` | TC-P0-08 | `tools/automated-testing/src/scenarios/p0-08-packaged-boot.spec.ts:30-56`（:38 标题含「营小商」） | `loadFile` 指向不存在的 `out/renderer/missing.html`，packaged 首窗起不来。 | `营小商` / `app.asar` / `user_version` / `learning.db` | **skipped**（环境超时） |
| M5 | `empty-question-set.patch` | `apps/desktop/src/renderer/src/question-set.ts:12` | TC-P1-02 | `tools/automated-testing/src/scenarios/p1-02-empty-question-set.spec.ts:12-13`（:13 空内容返回 `'retry'`） | 空题集判定恒返回 markdown，空题集不再走 retry 兜底（学生进入死胡同）。 | `retry` / `question-set` | killed |

## 2. 用法

在仓库根目录执行（脚本自己向上定位 `.git`，不假设 cwd）。应用：

```powershell
git apply --verbose tools/automated-testing/mutations/<name>.patch
```

还原：

```powershell
git apply -R --verbose tools/automated-testing/mutations/<name>.patch
```

`<name>` 取值：`cancel`、`answer-set`、`streaming`、`packaged-boot`、`empty-question-set`。

每条闭环结束后必须核对：

```powershell
git status --porcelain apps/desktop packages
```

输出必须为空；若有残留，说明该 patch 未还原干净，不允许进入下一条。

## 3. M3 / M4 的预期结果与依据

两个 patch 都锚在契约点上，实测结果不是 killed，原因如下——这是**真实结果**，不是脚本缺陷，也不靠换锚点凑数。

### M3 `streaming.patch` → survived

`01-scope.md` §2 明文规定「不为 mutant 补写新的断言 spec；覆盖缺口如实记为 survived」。代码事实：`p0-03-chat-stream.spec.ts` 全文没有 `tool` / `tool-end` 帧断言（`:22-31` 只断言 `session` 与 `text(lead)`，`:73-75` 同样只到 `text`），所以删掉 `tool-start` 转发后用例仍然全绿。

这条 survived 就是覆盖缺口的证据：**工具帧序列（`tool` 与 `tool-end` 的配对与顺序）目前没有任何断言保护**。后续补断言的输入写进报告 `notes`，不在本轮临时加断言。

> 曾有一版把锚点挪到 `packages/agent/src/index.ts:413`（删 `session` 帧）从而得到 killed，那是**把缺陷挪到了现有断言够得着的位置**，不是契约意义上的捕获，已撤销。

### M4 `packaged-boot.patch` → skipped

`loadFile` 指向不存在的 `out/renderer/missing.html` 后，`src/driver/electron-driver.ts` 的 `waitForFunction(learning.health)` 会等到超时。失败分类是 `timeout`，按 `02-contract.md` §4.2「超时类失败不算有效红」不计 killed，脚本记 `skipped` 并写明环境原因。

> 曾有一版改 `apps/desktop/src/renderer/index.html:6` 的页面标题从而得到 killed，那是等价替换：`p0-01`、`p0-02` 也断言 title 含「营小商」，缺陷不属 packaged 专属，却只跑了 `p0-08`，已撤销。

## 4. 生效前提

patch 改的是源码，只有经既有构建流程重新生成产物后才会被带进运行时：

- dev 目标读 `out/`：`apps/desktop/src/main/index.ts:157` 的 `loadFile` 指向 `out/renderer/index.html`。
- packaged 目标读 `release/win-unpacked/resources/app.asar`。
- **M4 必须先重编译并重打包进 `release/win-unpacked/resources/app.asar` 才会生效**；`run-mutation.ps1` 用 asar 哈希变化 + marker 双条件确认改动真的进包，进不去记 `skipped(asar-stale)`，不跑红例。

## 5. 命名说明

`plans/server-client-split/H-electron-mutation/README.md` 的产出清单写的是 `submit.patch`，而 `02-contract.md` §2.2 与本目录统一用 `answer-set.patch`（M2）；以 contracts 为准。

## 6. 源码锚点漂移处理

| 事项 | 口径 |
| --- | --- |
| 源码锚点漂移处理 | apply 前工作区必须干净；源码被他轮改动导致 hunk 不匹配时记 apply-failed、不自动重写上下文。 |
| 锚点可替代性 | 只有契约 §2.2 登记的备选锚点（M1 `turn-canceller.ts:19`、M3 `tool-loop.ts:313`）可在主锚点漂移时替换；替换要同步改 `02-contract.md`，不允许静默换成「能变红的任意位置」。 |
