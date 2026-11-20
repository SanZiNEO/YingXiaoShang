# H 轮 mutation 报告

- 轮次：H
- 生成时间：2026-11-20T22:32:31.3711761+08:00
- 仓库根：<仓库根>
- 分支：docs/server-client-split-round-briefs
- 应用 patch 前工作区干净：True
- 取得 Electron 锁：True
- 脚本版本：1.1.0（运行宿主 Desktop 5.1.26100.9818）
- 证据根目录：`.scratch/run/H/`（相对仓库根，换机器后路径自动跟随）

## 汇总

killed=3 survived=1 skipped=1 apply-failed=0 revert-failed=0 green-failed=0

## Mutant 记录

| ID | patch | 目标 | TC | 预期 | 状态 | 红退出码 | 命中关键词 | 分类 | 绿退出码 | 证据目录（红 / 绿） | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M1 | tools/automated-testing/mutations/cancel.patch | apps/desktop/src/main/index.ts:485 | TC-P1-03 | killed | killed | 1 | toBeInstanceOf | assertion | 0 | .scratch/run/H/M1/red / .scratch/run/H/M1/green |  |
| M2 | tools/automated-testing/mutations/answer-set.patch | packages/agent/src/index.ts:856 | TC-P0-06 | killed | killed | 1 | questionId, score, toHaveLength | assertion | 0 | .scratch/run/H/M2/red / .scratch/run/H/M2/green |  |
| M3 | tools/automated-testing/mutations/streaming.patch | packages/agent/src/team.ts:157 | TC-P0-03 | survived | survived | 0 |  | n/a | 0 | .scratch/run/H/M3/red / .scratch/run/H/M3/green | mutant 存活：用例未变红，覆盖不到这条缺陷。 |
| M4 | tools/automated-testing/mutations/packaged-boot.patch | apps/desktop/src/main/index.ts:157 | TC-P0-08 | skipped | skipped | 1 | 营小商, app.asar | timeout | 0 | .scratch/run/H/M4/red / .scratch/run/H/M4/green | 超时类失败（classification=timeout，keywords=[营小商,app.asar]）：driver 在 launch / 首窗 / health 任一等候超时，按契约 §4.2 不计 killed，记 skipped。缺的环节是「应用能起窗并暴露 learning.health」，不是断言。 |
| M5 | tools/automated-testing/mutations/empty-question-set.patch | apps/desktop/src/renderer/src/question-set.ts:12 | TC-P1-02 | killed | killed | 1 | retry, question-set | assertion | 0 | .scratch/run/H/M5/red / .scratch/run/H/M5/green |  |

## 证据完整性（AC-H-12）

| ID | 阶段 | 证据目录 | 已存在 | 缺失 |
| --- | --- | --- | --- | --- |
| M1 | red | `.scratch/run/H/M1/red` | stdout.txt, exit-code.txt, failure-summary.txt, meta.json | — |
| M1 | green | `.scratch/run/H/M1/green` | stdout.txt, exit-code.txt, failure-summary.txt, meta.json | — |
| M2 | red | `.scratch/run/H/M2/red` | stdout.txt, exit-code.txt, failure-summary.txt, meta.json | — |
| M2 | green | `.scratch/run/H/M2/green` | stdout.txt, exit-code.txt, failure-summary.txt, meta.json | — |
| M3 | red | `.scratch/run/H/M3/red` | stdout.txt, exit-code.txt, failure-summary.txt, meta.json | — |
| M3 | green | `.scratch/run/H/M3/green` | stdout.txt, exit-code.txt, failure-summary.txt, meta.json | — |
| M4 | red | `.scratch/run/H/M4/red` | stdout.txt, exit-code.txt, failure-summary.txt, meta.json | — |
| M4 | green | `.scratch/run/H/M4/green` | stdout.txt, exit-code.txt, failure-summary.txt, meta.json | — |
| M5 | red | `.scratch/run/H/M5/red` | stdout.txt, exit-code.txt, failure-summary.txt, meta.json | — |
| M5 | green | `.scratch/run/H/M5/green` | stdout.txt, exit-code.txt, failure-summary.txt, meta.json | — |

## AC 演练记录（AC-H-09 / H-11 / H-13 / H-14）

| 演练 | AC | 结果 | 退出码 | 检查项 | 证据目录 |
| --- | --- | --- | --- | --- | --- |
| dryrun | AC-H-11 | 通过 | 0 | 退出码=0; 打印 M3 契约锚点=True; 打印 M4 契约锚点=True; 未创建锁目录=False; 未新建证据目录=0; 工作区干净=empty | `.scratch/run/H/drills/dryrun` |
| isolation | AC-H-14 | 通过 | 0 | 存在阶段 meta.json=30; 本轮格式 meta.json 数量=15; 全部 YXS_WORKERS=1=0; 全部 YXS_RETRIES=0=0; meta 含起止时间戳=0; meta 未指向真实数据目录=0; 用例超时 180000=True; 并发取自 YXS_WORKERS=True; 重试取自 YXS_RETRIES=True; 无残留 H 临时 home 进程=0 | `.scratch/run/H/drills/isolation` |
| lock | AC-H-09 | 通过 | 2 | 退出码=2; stdout 含中文原因=True; 报告 lockAcquired=false=True; 报告 M5 记 skipped=True; 工作区干净=empty | `.scratch/run/H/drills/lock` |
| revert | AC-H-13 | 通过 | 4 | 退出码=4; stdout 含中文提示=True; 报告 M5 记 revert-failed=True; 看门狗确实注入过外部改动=0; 目标文件已恢复演练前内容=True; 工作区干净=empty | `.scratch/run/H/drills/revert` |

## 残留与清理

本轮无残留目录：M4 基线备份在恢复成功后已删除，锁目录已释放。

## 基线索引（31 行）

| TC | 标题 | 依赖 ID | 证据目录 | 基线状态 | 复跑命令 |
| --- | --- | --- | --- | --- | --- |
| TC-P0-01 | TC-P0-01 隔离 home 启动并通过 health 自检 | BOOT-01, CH-06, DATA-01, DATA-02, SVC-01, LEG-13 | .artifacts/p0-01-boot-health-TC-P0-01-隔离-home-启动并通过-health-自检-p0 | passed | pnpm --dir tools/automated-testing test -- -g TC-P0-01 |
| TC-P0-02 | TC-P0-02 首窗出现、preload 桥与学生身份可用 | WIN-01, UI-01, CH-01, IPC-01, DATA-14a | .artifacts/p0-02-preload-bridge-TC-P0-02-首窗出现、preload-桥与学生身份可用-p0 | passed | pnpm --dir tools/automated-testing test -- -g TC-P0-02 |
| TC-P0-03 | TC-P0-03 一轮完整对话：流式事件序列 + chat resolve | FLOW-01, FLOW-02, CH-03, CH-09, EVT-01, EVT-03, SVC-21 | .artifacts/p0-03-chat-stream-TC-P0-03-一轮完整对话：流式事件序列-chat-resolve-p0 | passed | pnpm --dir tools/automated-testing test -- -g TC-P0-03 |
| TC-P0-04 | TC-P0-04 对话落库：会话/消息/轮次可回查 | IPC-27, IPC-28, DATA-04, SVC-20 | .artifacts/p0-04-chat-persistence-TC-P0-04-对话落库：会话-消息-轮次可回查-p0 | passed | pnpm --dir tools/automated-testing test -- -g TC-P0-04 |
| TC-P0-05 | TC-P0-05 打开一个产物/文档标签 | UI-07, UI-08, UI-09, FLOW-08, IPC-19, IPC-20, DATA-13a, SVC-16 | .artifacts/p0-05-open-artifact-TC-P0-05-打开一个产物-文档标签-p0 | passed | pnpm --dir tools/automated-testing test -- -g TC-P0-05 |
| TC-P0-06 | TC-P0-06 一次答题/交卷并回读判分记录 | FLOW-03, UI-10, CH-05, IPC-13, SVC-21, LEG-08 | .artifacts/p0-06-answer-set-TC-P0-06-一次答题-交卷并回读判分记录-p0 | passed | pnpm --dir tools/automated-testing test -- -g TC-P0-06 |
| TC-P0-07 | TC-P0-07 干净退出：定时器/子进程清理、句柄释放 | BOOT-07, DATA-12b, DATA-12d, SVC-01 | .artifacts/p0-07-clean-exit-TC-P0-07-干净退出：定时器-子进程清理、句柄释放-p0 | passed | pnpm --dir tools/automated-testing test -- -g TC-P0-07 |
| TC-P0-08 | TC-P0-08 packaged 产物启动首窗 + health（packaged 路径 ①） | PKG-03, PKG-06, BOOT-01, DATA-06, LEG-22 | .artifacts/p0-08-packaged-boot-TC-P0--111ca-物启动首窗-health（packaged-路径-①）-p0 | passed | pnpm --dir tools/automated-testing test -- -g TC-P0-08 |
| TC-P0-09 | TC-P0-09 packaged 首启种子库自举落库（packaged 路径 ②） | PKG-03, PKG-04, DATA-06, DATA-07, DATA-12b | .artifacts/p0-09-packaged-seed-TC-P0--b87da-ed-首启种子库自举落库（packaged-路径-②）-p0 | passed | pnpm --dir tools/automated-testing test -- -g TC-P0-09 |
| TC-P0-10 | TC-P0-10 只读 invoke 方法契约往返快照 | IPC-01, IPC-02, IPC-03, IPC-09, SVC-02, DATA-04, CH-01 | .artifacts/p0-10-readonly-invoke-TC-P0-10-只读-invoke-方法契约往返快照-p0 | passed | pnpm --dir tools/automated-testing test -- -g TC-P0-10 |
| TC-P0-11 | TC-P0-11 关闭 sidecar 下启动不阻塞、本地新闻可读 | EXT-06, IPC-08, IPC-09, SVC-18, BOOT-01 | .artifacts/p0-11-news-offline-TC-P0-11-关闭-sidecar-下启动不阻塞、本地新闻可读-p0 | failed | pnpm --dir tools/automated-testing test -- -g TC-P0-11 |
| TC-P0-12 | TC-P0-12 窗口尺寸/位置持久化一轮 | BOOT-05, WIN-02, DATA-11 | .artifacts/p0-12-window-state-TC-P0-12-窗口尺寸-位置持久化一轮-p0 | passed | pnpm --dir tools/automated-testing test -- -g TC-P0-12 |
| TC-P0-13 | TC-P0-13 产物导出文件落盘可回读 | IPC-21, SVC-16, DATA-13a, DATA-13b, IPC-20 | .artifacts/p0-13-artifact-export-TC-P0-13-产物导出文件落盘可回读-p0 | passed | pnpm --dir tools/automated-testing test -- -g TC-P0-13 |
| TC-P1-01 | TC-P1-01 设置读取/写入与坏文件修复 | CH-07, CH-08, DATA-10, UI-05, LEG-11 | .artifacts/p1-01-settings-TC-P1-01-设置读取-写入与坏文件修复-p1 | passed | pnpm --dir tools/automated-testing test -- -g TC-P1-01 |
| TC-P1-02 | TC-P1-02 空题目集不出现死胡同 | FLOW-04, UI-10, SVC-07, LEG-03, DATA-14b | .artifacts/p1-02-empty-question-set-TC-P1-02-空题目集不出现死胡同-p1 | passed | pnpm --dir tools/automated-testing test -- -g TC-P1-02 |
| TC-P1-03 | TC-P1-03 取消进行中的回答 | FLOW-02, CH-02, EVT-01, LEG-01, LEG-02 | .artifacts/p1-03-cancel-TC-P1-03-取消进行中的回答-p1 | passed | pnpm --dir tools/automated-testing test -- -g TC-P1-03 |
| TC-P1-04 | TC-P1-04 本地新闻查询与筛选不依赖网络 | IPC-08, IPC-09, IPC-11, SVC-18, EXT-10 | .artifacts/p1-04-news-offline-TC-P1-04-本地新闻查询与筛选不依赖网络-p1 | passed | pnpm --dir tools/automated-testing test -- -g TC-P1-04 |
| TC-P1-05 | TC-P1-05 新闻刷新在无侧车时显式失败且不写脏数据 | IPC-10, EXT-06, EXT-10, SVC-19 | .artifacts/p1-05-news-refresh-TC-P1-05-新闻刷新在无侧车时显式失败且不写脏数据-p1 | passed | pnpm --dir tools/automated-testing test -- -g TC-P1-05 |
| TC-P1-06 | TC-P1-06 sidecar 退出后不重建、后续网络调用失败 | EXT-07, SVC-19, EXT-12 | .artifacts/p1-06-sidecar-TC-P1-06-sidecar-退出后不重建、后续网络调用失败-p1 | passed | pnpm --dir tools/automated-testing test -- -g TC-P1-06 |
| TC-P1-07 | TC-P1-07 引用溯源分派到 news/source 标签并回读 IPC | FLOW-05, UI-11, UI-12, IPC-11, IPC-05, IPC-06 | .artifacts/p1-07-citation-TC-P1-07-引用溯源分派到-news-source-标签并回读-IPC-p1 | passed | pnpm --dir tools/automated-testing test -- -g TC-P1-07 |
| TC-P1-08 | TC-P1-08 会话新建与历史切换 | FLOW-06, IPC-27, IPC-34, SVC-20 | .artifacts/p1-08-sessions-TC-P1-08-会话新建与历史切换-p1 | passed | pnpm --dir tools/automated-testing test -- -g TC-P1-08 |
| TC-P1-09 | TC-P1-09 档案证据复核与前后测快照 | FLOW-07, UI-04, IPC-14, IPC-16, IPC-17, IPC-18, SVC-14 | .artifacts/p1-09-profile-TC-P1-09-档案证据复核与前后测快照-p1 | passed | pnpm --dir tools/automated-testing test -- -g TC-P1-09 |
| TC-P1-10 | TC-P1-10 分栏拖拽键盘步进与布局持久化 | FLOW-09, UI-14, UI-15, WIN-01 | .artifacts/p1-10-drag-TC-P1-10-分栏拖拽键盘步进与布局持久化-p1 | passed | pnpm --dir tools/automated-testing test -- -g TC-P1-10 |
| TC-P1-11 | TC-P1-11 损坏 DB 启动失败分支（可重置/不可重置） | BOOT-02, BOOT-03, DATA-03, LEG-12 | .artifacts/p1-11-corrupt-db-TC-P1-11-损坏-DB-启动失败分支（可重置-不可重置）-p1 | passed | pnpm --dir tools/automated-testing test -- -g TC-P1-11 |
| TC-P1-12 | TC-P1-12 双实例行为观察（单例缺失） | BOOT-04, WIN-01, LEG-18 | .artifacts/p1-12-dual-instance-TC-P1-12-双实例行为观察（单例缺失）-p1 | passed | pnpm --dir tools/automated-testing test -- -g TC-P1-12 |
| TC-P1-13 | TC-P1-13 九种 DocKind 标签逐一打开 | UI-07, UI-08, FLOW-08, IPC-19, LEG-30 | .artifacts/p1-13-doc-kinds-TC-P1-13-九种-DocKind-标签逐一打开-p1 | passed | pnpm --dir tools/automated-testing test -- -g TC-P1-13 |
| TC-P1-14 | TC-P1-14 本地文件预览：扩展名映射、data URL 与缺失路径上抛 | UI-13, IPC-36, IPC-37, SVC-27 | .artifacts/p1-14-file-preview-TC-P1-14-本地文件预览：扩展名映射、data-URL-与缺失路径上抛-p1 | passed | pnpm --dir tools/automated-testing test -- -g TC-P1-14 |
| TC-P1-15 | TC-P1-15 记忆事实 upsert/delete 往返与非法 kind 归一 | IPC-22, IPC-25, IPC-26, SVC-14 | .artifacts/p1-15-memory-TC-P1-15-记忆事实-upsert-delete-往返与非法-kind-归一-p1 | passed | pnpm --dir tools/automated-testing test -- -g TC-P1-15 |
| TC-P1-16 | TC-P1-16 过程轮次/账本投影一致性与 pending 行重试受理 | IPC-31, IPC-32, IPC-33, SVC-20 | .artifacts/p1-16-ledger-TC-P1-16-过程轮次-账本投影一致性与-pending-行重试受理-p1 | passed | pnpm --dir tools/automated-testing test -- -g TC-P1-16 |
| TC-P1-17 | TC-P1-17 无种子空库首启健康告警分叉 | PKG-05, DATA-07, LEG-13, BOOT-01 | .artifacts/p1-17-empty-db-TC-P1-17-无种子空库首启健康告警分叉-p1 | passed | pnpm --dir tools/automated-testing test -- -g TC-P1-17 |
| TC-P1-18 | TC-P1-18 跨 IPC 错误对象形态探针 | CH-01, CH-03, LEG-05, SVC-02 | .artifacts/p1-18-unknown-method-TC-P1-18-跨-IPC-错误对象形态探针-p1 | passed | pnpm --dir tools/automated-testing test -- -g TC-P1-18 |

基线索引状态取自既有 `.artifacts/` reporter 证据；本轮未重跑非目标用例。passed=30 failed=1 unknown=0。

## 结构化 payload

```json
{
    "round":  "H",
    "generatedAt":  "2026-11-20T22:32:31.3711761+08:00",
    "repoRoot":  "<仓库根>",
    "branch":  "docs/server-client-split-round-briefs",
    "baselineCleanBefore":  true,
    "lockAcquired":  true,
    "scriptVersion":  "1.1.0",
    "powershell":  "Desktop 5.1.26100.9818",
    "baselineIndex":  [
                          {
                              "tc":  "TC-P0-01",
                              "title":  "TC-P0-01 隔离 home 启动并通过 health 自检",
                              "deps":  [
                                           "BOOT-01",
                                           "CH-06",
                                           "DATA-01",
                                           "DATA-02",
                                           "SVC-01",
                                           "LEG-13"
                                       ],
                              "evidenceDir":  ".artifacts/p0-01-boot-health-TC-P0-01-隔离-home-启动并通过-health-自检-p0",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P0-01"
                          },
                          {
                              "tc":  "TC-P0-02",
                              "title":  "TC-P0-02 首窗出现、preload 桥与学生身份可用",
                              "deps":  [
                                           "WIN-01",
                                           "UI-01",
                                           "CH-01",
                                           "IPC-01",
                                           "DATA-14a"
                                       ],
                              "evidenceDir":  ".artifacts/p0-02-preload-bridge-TC-P0-02-首窗出现、preload-桥与学生身份可用-p0",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P0-02"
                          },
                          {
                              "tc":  "TC-P0-03",
                              "title":  "TC-P0-03 一轮完整对话：流式事件序列 + chat resolve",
                              "deps":  [
                                           "FLOW-01",
                                           "FLOW-02",
                                           "CH-03",
                                           "CH-09",
                                           "EVT-01",
                                           "EVT-03",
                                           "SVC-21"
                                       ],
                              "evidenceDir":  ".artifacts/p0-03-chat-stream-TC-P0-03-一轮完整对话：流式事件序列-chat-resolve-p0",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P0-03"
                          },
                          {
                              "tc":  "TC-P0-04",
                              "title":  "TC-P0-04 对话落库：会话/消息/轮次可回查",
                              "deps":  [
                                           "IPC-27",
                                           "IPC-28",
                                           "DATA-04",
                                           "SVC-20"
                                       ],
                              "evidenceDir":  ".artifacts/p0-04-chat-persistence-TC-P0-04-对话落库：会话-消息-轮次可回查-p0",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P0-04"
                          },
                          {
                              "tc":  "TC-P0-05",
                              "title":  "TC-P0-05 打开一个产物/文档标签",
                              "deps":  [
                                           "UI-07",
                                           "UI-08",
                                           "UI-09",
                                           "FLOW-08",
                                           "IPC-19",
                                           "IPC-20",
                                           "DATA-13a",
                                           "SVC-16"
                                       ],
                              "evidenceDir":  ".artifacts/p0-05-open-artifact-TC-P0-05-打开一个产物-文档标签-p0",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P0-05"
                          },
                          {
                              "tc":  "TC-P0-06",
                              "title":  "TC-P0-06 一次答题/交卷并回读判分记录",
                              "deps":  [
                                           "FLOW-03",
                                           "UI-10",
                                           "CH-05",
                                           "IPC-13",
                                           "SVC-21",
                                           "LEG-08"
                                       ],
                              "evidenceDir":  ".artifacts/p0-06-answer-set-TC-P0-06-一次答题-交卷并回读判分记录-p0",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P0-06"
                          },
                          {
                              "tc":  "TC-P0-07",
                              "title":  "TC-P0-07 干净退出：定时器/子进程清理、句柄释放",
                              "deps":  [
                                           "BOOT-07",
                                           "DATA-12b",
                                           "DATA-12d",
                                           "SVC-01"
                                       ],
                              "evidenceDir":  ".artifacts/p0-07-clean-exit-TC-P0-07-干净退出：定时器-子进程清理、句柄释放-p0",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P0-07"
                          },
                          {
                              "tc":  "TC-P0-08",
                              "title":  "TC-P0-08 packaged 产物启动首窗 + health（packaged 路径 ①）",
                              "deps":  [
                                           "PKG-03",
                                           "PKG-06",
                                           "BOOT-01",
                                           "DATA-06",
                                           "LEG-22"
                                       ],
                              "evidenceDir":  ".artifacts/p0-08-packaged-boot-TC-P0--111ca-物启动首窗-health（packaged-路径-①）-p0",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P0-08"
                          },
                          {
                              "tc":  "TC-P0-09",
                              "title":  "TC-P0-09 packaged 首启种子库自举落库（packaged 路径 ②）",
                              "deps":  [
                                           "PKG-03",
                                           "PKG-04",
                                           "DATA-06",
                                           "DATA-07",
                                           "DATA-12b"
                                       ],
                              "evidenceDir":  ".artifacts/p0-09-packaged-seed-TC-P0--b87da-ed-首启种子库自举落库（packaged-路径-②）-p0",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P0-09"
                          },
                          {
                              "tc":  "TC-P0-10",
                              "title":  "TC-P0-10 只读 invoke 方法契约往返快照",
                              "deps":  [
                                           "IPC-01",
                                           "IPC-02",
                                           "IPC-03",
                                           "IPC-09",
                                           "SVC-02",
                                           "DATA-04",
                                           "CH-01"
                                       ],
                              "evidenceDir":  ".artifacts/p0-10-readonly-invoke-TC-P0-10-只读-invoke-方法契约往返快照-p0",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P0-10"
                          },
                          {
                              "tc":  "TC-P0-11",
                              "title":  "TC-P0-11 关闭 sidecar 下启动不阻塞、本地新闻可读",
                              "deps":  [
                                           "EXT-06",
                                           "IPC-08",
                                           "IPC-09",
                                           "SVC-18",
                                           "BOOT-01"
                                       ],
                              "evidenceDir":  ".artifacts/p0-11-news-offline-TC-P0-11-关闭-sidecar-下启动不阻塞、本地新闻可读-p0",
                              "baselineStatus":  "failed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P0-11"
                          },
                          {
                              "tc":  "TC-P0-12",
                              "title":  "TC-P0-12 窗口尺寸/位置持久化一轮",
                              "deps":  [
                                           "BOOT-05",
                                           "WIN-02",
                                           "DATA-11"
                                       ],
                              "evidenceDir":  ".artifacts/p0-12-window-state-TC-P0-12-窗口尺寸-位置持久化一轮-p0",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P0-12"
                          },
                          {
                              "tc":  "TC-P0-13",
                              "title":  "TC-P0-13 产物导出文件落盘可回读",
                              "deps":  [
                                           "IPC-21",
                                           "SVC-16",
                                           "DATA-13a",
                                           "DATA-13b",
                                           "IPC-20"
                                       ],
                              "evidenceDir":  ".artifacts/p0-13-artifact-export-TC-P0-13-产物导出文件落盘可回读-p0",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P0-13"
                          },
                          {
                              "tc":  "TC-P1-01",
                              "title":  "TC-P1-01 设置读取/写入与坏文件修复",
                              "deps":  [
                                           "CH-07",
                                           "CH-08",
                                           "DATA-10",
                                           "UI-05",
                                           "LEG-11"
                                       ],
                              "evidenceDir":  ".artifacts/p1-01-settings-TC-P1-01-设置读取-写入与坏文件修复-p1",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P1-01"
                          },
                          {
                              "tc":  "TC-P1-02",
                              "title":  "TC-P1-02 空题目集不出现死胡同",
                              "deps":  [
                                           "FLOW-04",
                                           "UI-10",
                                           "SVC-07",
                                           "LEG-03",
                                           "DATA-14b"
                                       ],
                              "evidenceDir":  ".artifacts/p1-02-empty-question-set-TC-P1-02-空题目集不出现死胡同-p1",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P1-02"
                          },
                          {
                              "tc":  "TC-P1-03",
                              "title":  "TC-P1-03 取消进行中的回答",
                              "deps":  [
                                           "FLOW-02",
                                           "CH-02",
                                           "EVT-01",
                                           "LEG-01",
                                           "LEG-02"
                                       ],
                              "evidenceDir":  ".artifacts/p1-03-cancel-TC-P1-03-取消进行中的回答-p1",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P1-03"
                          },
                          {
                              "tc":  "TC-P1-04",
                              "title":  "TC-P1-04 本地新闻查询与筛选不依赖网络",
                              "deps":  [
                                           "IPC-08",
                                           "IPC-09",
                                           "IPC-11",
                                           "SVC-18",
                                           "EXT-10"
                                       ],
                              "evidenceDir":  ".artifacts/p1-04-news-offline-TC-P1-04-本地新闻查询与筛选不依赖网络-p1",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P1-04"
                          },
                          {
                              "tc":  "TC-P1-05",
                              "title":  "TC-P1-05 新闻刷新在无侧车时显式失败且不写脏数据",
                              "deps":  [
                                           "IPC-10",
                                           "EXT-06",
                                           "EXT-10",
                                           "SVC-19"
                                       ],
                              "evidenceDir":  ".artifacts/p1-05-news-refresh-TC-P1-05-新闻刷新在无侧车时显式失败且不写脏数据-p1",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P1-05"
                          },
                          {
                              "tc":  "TC-P1-06",
                              "title":  "TC-P1-06 sidecar 退出后不重建、后续网络调用失败",
                              "deps":  [
                                           "EXT-07",
                                           "SVC-19",
                                           "EXT-12"
                                       ],
                              "evidenceDir":  ".artifacts/p1-06-sidecar-TC-P1-06-sidecar-退出后不重建、后续网络调用失败-p1",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P1-06"
                          },
                          {
                              "tc":  "TC-P1-07",
                              "title":  "TC-P1-07 引用溯源分派到 news/source 标签并回读 IPC",
                              "deps":  [
                                           "FLOW-05",
                                           "UI-11",
                                           "UI-12",
                                           "IPC-11",
                                           "IPC-05",
                                           "IPC-06"
                                       ],
                              "evidenceDir":  ".artifacts/p1-07-citation-TC-P1-07-引用溯源分派到-news-source-标签并回读-IPC-p1",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P1-07"
                          },
                          {
                              "tc":  "TC-P1-08",
                              "title":  "TC-P1-08 会话新建与历史切换",
                              "deps":  [
                                           "FLOW-06",
                                           "IPC-27",
                                           "IPC-34",
                                           "SVC-20"
                                       ],
                              "evidenceDir":  ".artifacts/p1-08-sessions-TC-P1-08-会话新建与历史切换-p1",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P1-08"
                          },
                          {
                              "tc":  "TC-P1-09",
                              "title":  "TC-P1-09 档案证据复核与前后测快照",
                              "deps":  [
                                           "FLOW-07",
                                           "UI-04",
                                           "IPC-14",
                                           "IPC-16",
                                           "IPC-17",
                                           "IPC-18",
                                           "SVC-14"
                                       ],
                              "evidenceDir":  ".artifacts/p1-09-profile-TC-P1-09-档案证据复核与前后测快照-p1",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P1-09"
                          },
                          {
                              "tc":  "TC-P1-10",
                              "title":  "TC-P1-10 分栏拖拽键盘步进与布局持久化",
                              "deps":  [
                                           "FLOW-09",
                                           "UI-14",
                                           "UI-15",
                                           "WIN-01"
                                       ],
                              "evidenceDir":  ".artifacts/p1-10-drag-TC-P1-10-分栏拖拽键盘步进与布局持久化-p1",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P1-10"
                          },
                          {
                              "tc":  "TC-P1-11",
                              "title":  "TC-P1-11 损坏 DB 启动失败分支（可重置/不可重置）",
                              "deps":  [
                                           "BOOT-02",
                                           "BOOT-03",
                                           "DATA-03",
                                           "LEG-12"
                                       ],
                              "evidenceDir":  ".artifacts/p1-11-corrupt-db-TC-P1-11-损坏-DB-启动失败分支（可重置-不可重置）-p1",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P1-11"
                          },
                          {
                              "tc":  "TC-P1-12",
                              "title":  "TC-P1-12 双实例行为观察（单例缺失）",
                              "deps":  [
                                           "BOOT-04",
                                           "WIN-01",
                                           "LEG-18"
                                       ],
                              "evidenceDir":  ".artifacts/p1-12-dual-instance-TC-P1-12-双实例行为观察（单例缺失）-p1",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P1-12"
                          },
                          {
                              "tc":  "TC-P1-13",
                              "title":  "TC-P1-13 九种 DocKind 标签逐一打开",
                              "deps":  [
                                           "UI-07",
                                           "UI-08",
                                           "FLOW-08",
                                           "IPC-19",
                                           "LEG-30"
                                       ],
                              "evidenceDir":  ".artifacts/p1-13-doc-kinds-TC-P1-13-九种-DocKind-标签逐一打开-p1",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P1-13"
                          },
                          {
                              "tc":  "TC-P1-14",
                              "title":  "TC-P1-14 本地文件预览：扩展名映射、data URL 与缺失路径上抛",
                              "deps":  [
                                           "UI-13",
                                           "IPC-36",
                                           "IPC-37",
                                           "SVC-27"
                                       ],
                              "evidenceDir":  ".artifacts/p1-14-file-preview-TC-P1-14-本地文件预览：扩展名映射、data-URL-与缺失路径上抛-p1",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P1-14"
                          },
                          {
                              "tc":  "TC-P1-15",
                              "title":  "TC-P1-15 记忆事实 upsert/delete 往返与非法 kind 归一",
                              "deps":  [
                                           "IPC-22",
                                           "IPC-25",
                                           "IPC-26",
                                           "SVC-14"
                                       ],
                              "evidenceDir":  ".artifacts/p1-15-memory-TC-P1-15-记忆事实-upsert-delete-往返与非法-kind-归一-p1",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P1-15"
                          },
                          {
                              "tc":  "TC-P1-16",
                              "title":  "TC-P1-16 过程轮次/账本投影一致性与 pending 行重试受理",
                              "deps":  [
                                           "IPC-31",
                                           "IPC-32",
                                           "IPC-33",
                                           "SVC-20"
                                       ],
                              "evidenceDir":  ".artifacts/p1-16-ledger-TC-P1-16-过程轮次-账本投影一致性与-pending-行重试受理-p1",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P1-16"
                          },
                          {
                              "tc":  "TC-P1-17",
                              "title":  "TC-P1-17 无种子空库首启健康告警分叉",
                              "deps":  [
                                           "PKG-05",
                                           "DATA-07",
                                           "LEG-13",
                                           "BOOT-01"
                                       ],
                              "evidenceDir":  ".artifacts/p1-17-empty-db-TC-P1-17-无种子空库首启健康告警分叉-p1",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P1-17"
                          },
                          {
                              "tc":  "TC-P1-18",
                              "title":  "TC-P1-18 跨 IPC 错误对象形态探针",
                              "deps":  [
                                           "CH-01",
                                           "CH-03",
                                           "LEG-05",
                                           "SVC-02"
                                       ],
                              "evidenceDir":  ".artifacts/p1-18-unknown-method-TC-P1-18-跨-IPC-错误对象形态探针-p1",
                              "baselineStatus":  "passed",
                              "runRef":  "pnpm --dir tools/automated-testing test -- -g TC-P1-18"
                          }
                      ],
    "mutations":  [
                      {
                          "id":  "M1",
                          "patch":  "tools/automated-testing/mutations/cancel.patch",
                          "targetFile":  "apps/desktop/src/main/index.ts",
                          "anchorLine":  485,
                          "defectSummary":  "取消控制器不再把 AbortSignal 交进执行链——点「停止」只断界面回调，在途模型请求继续跑（历史假停缺陷）。",
                          "targetCase":  {
                                             "tc":  "TC-P1-03",
                                             "spec":  "src/scenarios/p1-03-cancel.spec.ts"
                                         },
                          "status":  "killed",
                          "apply":  {
                                        "Command":  "git apply --verbose tools/automated-testing/mutations/cancel.patch",
                                        "ExitCode":  0,
                                        "AppliedAt":  "2026-11-20T14:25:38.0348656Z"
                                    },
                          "red":  {
                                      "Command":  "pnpm --dir tools/automated-testing exec playwright test --reporter=list --output=.scratch/run/H/M1/red/playwright src/scenarios/p1-03-cancel.spec.ts",
                                      "ExitCode":  1,
                                      "OutputExcerpt":  "Error: expect(received).toBe(expected) // Object.is equality",
                                      "KeywordsHit":  "toBeInstanceOf",
                                      "Classification":  "assertion"
                                  },
                          "revert":  {
                                         "Command":  "git apply -R --verbose tools/automated-testing/mutations/cancel.patch",
                                         "ExitCode":  0,
                                         "RevertedAt":  "2026-11-20T14:26:09.9282124Z"
                                     },
                          "green":  {
                                        "Command":  "pnpm --dir tools/automated-testing exec playwright test --reporter=list --output=.scratch/run/H/M1/green/playwright src/scenarios/p1-03-cancel.spec.ts",
                                        "ExitCode":  0,
                                        "OutputExcerpt":  "node.exe : [WARN] The \"pnpm\" field in package.json is no longer read by pnpm. The following keys were ignored: \"pnpm.on"
                                    },
                          "cleanupCheck":  {
                                               "Command":  "git status --porcelain apps/desktop packages",
                                               "Clean":  true,
                                               "Output":  ""
                                           },
                          "build":  {
                                        "red":  [
                                                    {
                                                        "Step":  "desktop",
                                                        "Command":  "pnpm --dir apps/desktop build",
                                                        "ExitCode":  0,
                                                        "DurationMs":  16818
                                                    }
                                                ],
                                        "green":  [
                                                      {
                                                          "Step":  "desktop",
                                                          "Command":  "pnpm --dir apps/desktop build",
                                                          "ExitCode":  0,
                                                          "DurationMs":  21259
                                                      }
                                                  ],
                                        "totalDurationMs":  16849,
                                        "repackage":  null,
                                        "unpackedBackup":  null
                                    },
                          "notes":  ""
                      },
                      {
                          "id":  "M2",
                          "patch":  "tools/automated-testing/mutations/answer-set.patch",
                          "targetFile":  "packages/agent/src/index.ts",
                          "anchorLine":  856,
                          "defectSummary":  "交卷返回的 results 丢掉 questionId / score 等判分字段（DB 落库链路不动）。",
                          "targetCase":  {
                                             "tc":  "TC-P0-06",
                                             "spec":  "src/scenarios/p0-06-answer-set.spec.ts"
                                         },
                          "status":  "killed",
                          "apply":  {
                                        "Command":  "git apply --verbose tools/automated-testing/mutations/answer-set.patch",
                                        "ExitCode":  0,
                                        "AppliedAt":  "2026-11-20T14:26:48.1724154Z"
                                    },
                          "red":  {
                                      "Command":  "pnpm --dir tools/automated-testing exec playwright test --reporter=list --output=.scratch/run/H/M2/red/playwright src/scenarios/p0-06-answer-set.spec.ts",
                                      "ExitCode":  1,
                                      "OutputExcerpt":  "Error: expect(received).toBe(expected) // Object.is equality",
                                      "KeywordsHit":  [
                                                          "questionId",
                                                          "score",
                                                          "toHaveLength"
                                                      ],
                                      "Classification":  "assertion"
                                  },
                          "revert":  {
                                         "Command":  "git apply -R --verbose tools/automated-testing/mutations/answer-set.patch",
                                         "ExitCode":  0,
                                         "RevertedAt":  "2026-11-20T14:27:25.5652746Z"
                                     },
                          "green":  {
                                        "Command":  "pnpm --dir tools/automated-testing exec playwright test --reporter=list --output=.scratch/run/H/M2/green/playwright src/scenarios/p0-06-answer-set.spec.ts",
                                        "ExitCode":  0,
                                        "OutputExcerpt":  "node.exe : [WARN] The \"pnpm\" field in package.json is no longer read by pnpm. The following keys were ignored: \"pnpm.on"
                                    },
                          "cleanupCheck":  {
                                               "Command":  "git status --porcelain apps/desktop packages",
                                               "Clean":  true,
                                               "Output":  ""
                                           },
                          "build":  {
                                        "red":  [
                                                    {
                                                        "Step":  "packages-agent",
                                                        "Command":  "pnpm --dir packages/agent build",
                                                        "ExitCode":  0,
                                                        "DurationMs":  8049
                                                    },
                                                    {
                                                        "Step":  "desktop",
                                                        "Command":  "pnpm --dir apps/desktop build",
                                                        "ExitCode":  0,
                                                        "DurationMs":  16801
                                                    }
                                                ],
                                        "green":  [
                                                      {
                                                          "Step":  "packages-agent",
                                                          "Command":  "pnpm --dir packages/agent build",
                                                          "ExitCode":  0,
                                                          "DurationMs":  6977
                                                      },
                                                      {
                                                          "Step":  "desktop",
                                                          "Command":  "pnpm --dir apps/desktop build",
                                                          "ExitCode":  0,
                                                          "DurationMs":  15826
                                                      }
                                                  ],
                                        "totalDurationMs":  24857,
                                        "repackage":  null,
                                        "unpackedBackup":  null
                                    },
                          "notes":  ""
                      },
                      {
                          "id":  "M3",
                          "patch":  "tools/automated-testing/mutations/streaming.patch",
                          "targetFile":  "packages/agent/src/team.ts",
                          "anchorLine":  157,
                          "defectSummary":  "tool-start 帧不再转发给界面（type:\u0027tool\u0027 不发出），工具帧序列缺开始帧。",
                          "targetCase":  {
                                             "tc":  "TC-P0-03",
                                             "spec":  "src/scenarios/p0-03-chat-stream.spec.ts"
                                         },
                          "status":  "survived",
                          "apply":  {
                                        "Command":  "git apply --verbose tools/automated-testing/mutations/streaming.patch",
                                        "ExitCode":  0,
                                        "AppliedAt":  "2026-11-20T14:27:59.3562384Z"
                                    },
                          "red":  {
                                      "Command":  "pnpm --dir tools/automated-testing exec playwright test --reporter=list --output=.scratch/run/H/M3/red/playwright src/scenarios/p0-03-chat-stream.spec.ts",
                                      "ExitCode":  0,
                                      "OutputExcerpt":  "node.exe : [WARN] The \"pnpm\" field in package.json is no longer read by pnpm. The following keys were ignored: \"pnpm.on",
                                      "KeywordsHit":  {

                                                      },
                                      "Classification":  "n/a"
                                  },
                          "revert":  {
                                         "Command":  "git apply -R --verbose tools/automated-testing/mutations/streaming.patch",
                                         "ExitCode":  0,
                                         "RevertedAt":  "2026-11-20T14:28:39.8622804Z"
                                     },
                          "green":  {
                                        "Command":  "pnpm --dir tools/automated-testing exec playwright test --reporter=list --output=.scratch/run/H/M3/green/playwright src/scenarios/p0-03-chat-stream.spec.ts",
                                        "ExitCode":  0,
                                        "OutputExcerpt":  "node.exe : [WARN] The \"pnpm\" field in package.json is no longer read by pnpm. The following keys were ignored: \"pnpm.on"
                                    },
                          "cleanupCheck":  {
                                               "Command":  "git status --porcelain apps/desktop packages",
                                               "Clean":  true,
                                               "Output":  ""
                                           },
                          "build":  {
                                        "red":  [
                                                    {
                                                        "Step":  "packages-agent",
                                                        "Command":  "pnpm --dir packages/agent build",
                                                        "ExitCode":  0,
                                                        "DurationMs":  6831
                                                    },
                                                    {
                                                        "Step":  "desktop",
                                                        "Command":  "pnpm --dir apps/desktop build",
                                                        "ExitCode":  0,
                                                        "DurationMs":  15585
                                                    }
                                                ],
                                        "green":  [
                                                      {
                                                          "Step":  "packages-agent",
                                                          "Command":  "pnpm --dir packages/agent build",
                                                          "ExitCode":  0,
                                                          "DurationMs":  7101
                                                      },
                                                      {
                                                          "Step":  "desktop",
                                                          "Command":  "pnpm --dir apps/desktop build",
                                                          "ExitCode":  0,
                                                          "DurationMs":  16818
                                                      }
                                                  ],
                                        "totalDurationMs":  22429,
                                        "repackage":  null,
                                        "unpackedBackup":  null
                                    },
                          "notes":  "mutant 存活：用例未变红，覆盖不到这条缺陷。"
                      },
                      {
                          "id":  "M4",
                          "patch":  "tools/automated-testing/mutations/packaged-boot.patch",
                          "targetFile":  "apps/desktop/src/main/index.ts",
                          "anchorLine":  157,
                          "defectSummary":  "packaged 首窗 loadFile 指向不存在的 out/renderer/missing.html，界面起不来。",
                          "targetCase":  {
                                             "tc":  "TC-P0-08",
                                             "spec":  "src/scenarios/p0-08-packaged-boot.spec.ts"
                                         },
                          "status":  "skipped",
                          "apply":  {
                                        "Command":  "git apply --verbose tools/automated-testing/mutations/packaged-boot.patch",
                                        "ExitCode":  0,
                                        "AppliedAt":  "2026-11-20T14:29:20.5203672Z"
                                    },
                          "red":  {
                                      "Command":  "pnpm --dir tools/automated-testing exec playwright test --reporter=list --output=.scratch/run/H/M4/red/playwright src/scenarios/p0-08-packaged-boot.spec.ts",
                                      "ExitCode":  1,
                                      "OutputExcerpt":  "TimeoutError: electron.launch: Timeout 60000ms exceeded.",
                                      "KeywordsHit":  [
                                                          "营小商",
                                                          "app.asar"
                                                      ],
                                      "Classification":  "timeout"
                                  },
                          "revert":  {
                                         "Command":  "git apply -R --verbose tools/automated-testing/mutations/packaged-boot.patch",
                                         "ExitCode":  0,
                                         "RevertedAt":  "2026-11-20T14:31:12.1269911Z"
                                     },
                          "green":  {
                                        "Command":  "pnpm --dir tools/automated-testing exec playwright test --reporter=list --output=.scratch/run/H/M4/green/playwright src/scenarios/p0-08-packaged-boot.spec.ts",
                                        "ExitCode":  0,
                                        "OutputExcerpt":  "node.exe : [WARN] The \"pnpm\" field in package.json is no longer read by pnpm. The following keys were ignored: \"pnpm.on"
                                    },
                          "cleanupCheck":  {
                                               "Command":  "git status --porcelain apps/desktop packages",
                                               "Clean":  true,
                                               "Output":  ""
                                           },
                          "build":  {
                                        "red":  [
                                                    {
                                                        "Step":  "desktop",
                                                        "Command":  "pnpm --dir apps/desktop build",
                                                        "ExitCode":  0,
                                                        "DurationMs":  15406
                                                    }
                                                ],
                                        "green":  [
                                                      {
                                                          "Step":  "desktop",
                                                          "Command":  "pnpm --dir apps/desktop build",
                                                          "ExitCode":  0,
                                                          "DurationMs":  17226
                                                      }
                                                  ],
                                        "totalDurationMs":  15415,
                                        "repackage":  {
                                                          "Command":  "pnpm --dir apps/desktop exec electron-builder --dir --publish never",
                                                          "ExitCode":  0,
                                                          "DistArg":  "-c.electronDist=<仓库根>\\apps\\desktop\\node_modules\\electron\\dist",
                                                          "AsarBefore":  {
                                                                             "Exists":  true,
                                                                             "Length":  41543417,
                                                                             "Sha256":  "672E923063D795BD1F96AD98C3853C37586728C0F3A5A8982087C63FE712B7DC",
                                                                             "LastWriteTime":  "2026-11-19T10:03:43.7776301+08:00",
                                                                             "MarkerPresent":  false
                                                                         },
                                                          "AsarAfter":  {
                                                                            "Exists":  true,
                                                                            "Length":  41543431,
                                                                            "Sha256":  "2334D2B81896548EEBF28940133944510762C3F94D33E13F38237B0AF914DF44",
                                                                            "LastWriteTime":  "2026-11-20T22:30:03.2701385+08:00",
                                                                            "MarkerPresent":  true
                                                                        },
                                                          "Log":  "<仓库根>\\.scratch\\run\\H\\M4\\red\\repackage.log"
                                                      },
                                        "unpackedBackup":  {
                                                               "Path":  "<仓库根>\\.scratch\\run\\H\\baseline-unpacked",
                                                               "SizeMb":  364,
                                                               "Restored":  true,
                                                               "Removed":  true
                                                           }
                                    },
                          "notes":  "超时类失败（classification=timeout，keywords=[营小商,app.asar]）：driver 在 launch / 首窗 / health 任一等候超时，按契约 §4.2 不计 killed，记 skipped。缺的环节是「应用能起窗并暴露 learning.health」，不是断言。"
                      },
                      {
                          "id":  "M5",
                          "patch":  "tools/automated-testing/mutations/empty-question-set.patch",
                          "targetFile":  "apps/desktop/src/renderer/src/question-set.ts",
                          "anchorLine":  12,
                          "defectSummary":  "空题集判定恒返回 markdown，空题集不再走 retry 兜底（学生进入死胡同）。",
                          "targetCase":  {
                                             "tc":  "TC-P1-02",
                                             "spec":  "src/scenarios/p1-02-empty-question-set.spec.ts"
                                         },
                          "status":  "killed",
                          "apply":  {
                                        "Command":  "git apply --verbose tools/automated-testing/mutations/empty-question-set.patch",
                                        "ExitCode":  0,
                                        "AppliedAt":  "2026-11-20T14:31:40.0246805Z"
                                    },
                          "red":  {
                                      "Command":  "pnpm --dir tools/automated-testing exec playwright test --reporter=list --output=.scratch/run/H/M5/red/playwright src/scenarios/p1-02-empty-question-set.spec.ts",
                                      "ExitCode":  1,
                                      "OutputExcerpt":  "Error: expect(received).toBe(expected) // Object.is equality",
                                      "KeywordsHit":  [
                                                          "retry",
                                                          "question-set"
                                                      ],
                                      "Classification":  "assertion"
                                  },
                          "revert":  {
                                         "Command":  "git apply -R --verbose tools/automated-testing/mutations/empty-question-set.patch",
                                         "ExitCode":  0,
                                         "RevertedAt":  "2026-11-20T14:32:05.8673245Z"
                                     },
                          "green":  {
                                        "Command":  "pnpm --dir tools/automated-testing exec playwright test --reporter=list --output=.scratch/run/H/M5/green/playwright src/scenarios/p1-02-empty-question-set.spec.ts",
                                        "ExitCode":  0,
                                        "OutputExcerpt":  "node.exe : [WARN] The \"pnpm\" field in package.json is no longer read by pnpm. The following keys were ignored: \"pnpm.on"
                                    },
                          "cleanupCheck":  {
                                               "Command":  "git status --porcelain apps/desktop packages",
                                               "Clean":  true,
                                               "Output":  ""
                                           },
                          "build":  {
                                        "red":  [
                                                    {
                                                        "Step":  "desktop",
                                                        "Command":  "pnpm --dir apps/desktop build",
                                                        "ExitCode":  0,
                                                        "DurationMs":  16762
                                                    }
                                                ],
                                        "green":  [
                                                      {
                                                          "Step":  "desktop",
                                                          "Command":  "pnpm --dir apps/desktop build",
                                                          "ExitCode":  0,
                                                          "DurationMs":  15567
                                                      }
                                                  ],
                                        "totalDurationMs":  16771,
                                        "repackage":  null,
                                        "unpackedBackup":  null
                                    },
                          "notes":  ""
                      }
                  ],
    "evidenceAudit":  [
                          {
                              "id":  "M1",
                              "phase":  "red",
                              "dir":  ".scratch/run/H/M1/red",
                              "present":  "stdout.txt, exit-code.txt, failure-summary.txt, meta.json",
                              "missing":  "",
                              "complete":  true
                          },
                          {
                              "id":  "M1",
                              "phase":  "green",
                              "dir":  ".scratch/run/H/M1/green",
                              "present":  "stdout.txt, exit-code.txt, failure-summary.txt, meta.json",
                              "missing":  "",
                              "complete":  true
                          },
                          {
                              "id":  "M2",
                              "phase":  "red",
                              "dir":  ".scratch/run/H/M2/red",
                              "present":  "stdout.txt, exit-code.txt, failure-summary.txt, meta.json",
                              "missing":  "",
                              "complete":  true
                          },
                          {
                              "id":  "M2",
                              "phase":  "green",
                              "dir":  ".scratch/run/H/M2/green",
                              "present":  "stdout.txt, exit-code.txt, failure-summary.txt, meta.json",
                              "missing":  "",
                              "complete":  true
                          },
                          {
                              "id":  "M3",
                              "phase":  "red",
                              "dir":  ".scratch/run/H/M3/red",
                              "present":  "stdout.txt, exit-code.txt, failure-summary.txt, meta.json",
                              "missing":  "",
                              "complete":  true
                          },
                          {
                              "id":  "M3",
                              "phase":  "green",
                              "dir":  ".scratch/run/H/M3/green",
                              "present":  "stdout.txt, exit-code.txt, failure-summary.txt, meta.json",
                              "missing":  "",
                              "complete":  true
                          },
                          {
                              "id":  "M4",
                              "phase":  "red",
                              "dir":  ".scratch/run/H/M4/red",
                              "present":  "stdout.txt, exit-code.txt, failure-summary.txt, meta.json",
                              "missing":  "",
                              "complete":  true
                          },
                          {
                              "id":  "M4",
                              "phase":  "green",
                              "dir":  ".scratch/run/H/M4/green",
                              "present":  "stdout.txt, exit-code.txt, failure-summary.txt, meta.json",
                              "missing":  "",
                              "complete":  true
                          },
                          {
                              "id":  "M5",
                              "phase":  "red",
                              "dir":  ".scratch/run/H/M5/red",
                              "present":  "stdout.txt, exit-code.txt, failure-summary.txt, meta.json",
                              "missing":  "",
                              "complete":  true
                          },
                          {
                              "id":  "M5",
                              "phase":  "green",
                              "dir":  ".scratch/run/H/M5/green",
                              "present":  "stdout.txt, exit-code.txt, failure-summary.txt, meta.json",
                              "missing":  "",
                              "complete":  true
                          }
                      ],
    "drills":  [
                   {
                       "name":  "dryrun",
                       "ac":  "AC-H-11",
                       "passed":  true,
                       "exitCode":  0,
                       "checks":  [
                                      {
                                          "name":  "退出码",
                                          "expected":  "0",
                                          "actual":  "0",
                                          "ok":  true
                                      },
                                      {
                                          "name":  "打印 M3 契约锚点",
                                          "expected":  "target=packages/agent/src/team.ts:157",
                                          "actual":  "True",
                                          "ok":  true
                                      },
                                      {
                                          "name":  "打印 M4 契约锚点",
                                          "expected":  "target=apps/desktop/src/main/index.ts:157",
                                          "actual":  "True",
                                          "ok":  true
                                      },
                                      {
                                          "name":  "未创建锁目录",
                                          "expected":  "False",
                                          "actual":  "False",
                                          "ok":  true
                                      },
                                      {
                                          "name":  "未新建证据目录",
                                          "expected":  "0",
                                          "actual":  "0",
                                          "ok":  true
                                      },
                                      {
                                          "name":  "工作区干净",
                                          "expected":  "empty",
                                          "actual":  "empty",
                                          "ok":  true
                                      }
                                  ],
                       "evidence":  ".scratch/run/H/drills/dryrun"
                   },
                   {
                       "name":  "isolation",
                       "ac":  "AC-H-14",
                       "passed":  true,
                       "exitCode":  0,
                       "checks":  [
                                      {
                                          "name":  "存在阶段 meta.json",
                                          "expected":  "\u003e0",
                                          "actual":  "30",
                                          "ok":  true
                                      },
                                      {
                                          "name":  "本轮格式 meta.json 数量",
                                          "expected":  "\u003e0",
                                          "actual":  "15",
                                          "ok":  true
                                      },
                                      {
                                          "name":  "全部 YXS_WORKERS=1",
                                          "expected":  "0 例外",
                                          "actual":  "0",
                                          "ok":  true
                                      },
                                      {
                                          "name":  "全部 YXS_RETRIES=0",
                                          "expected":  "0 例外",
                                          "actual":  "0",
                                          "ok":  true
                                      },
                                      {
                                          "name":  "meta 含起止时间戳",
                                          "expected":  "0 例外",
                                          "actual":  "0",
                                          "ok":  true
                                      },
                                      {
                                          "name":  "meta 未指向真实数据目录",
                                          "expected":  "0 例外",
                                          "actual":  "0",
                                          "ok":  true
                                      },
                                      {
                                          "name":  "用例超时 180000",
                                          "expected":  "180_000",
                                          "actual":  "True",
                                          "ok":  true
                                      },
                                      {
                                          "name":  "并发取自 YXS_WORKERS",
                                          "expected":  "process.env.YXS_WORKERS",
                                          "actual":  "True",
                                          "ok":  true
                                      },
                                      {
                                          "name":  "重试取自 YXS_RETRIES",
                                          "expected":  "process.env.YXS_RETRIES",
                                          "actual":  "True",
                                          "ok":  true
                                      },
                                      {
                                          "name":  "无残留 H 临时 home 进程",
                                          "expected":  "0",
                                          "actual":  "0",
                                          "ok":  true
                                      }
                                  ],
                       "evidence":  ".scratch/run/H/drills/isolation"
                   },
                   {
                       "name":  "lock",
                       "ac":  "AC-H-09",
                       "passed":  true,
                       "exitCode":  2,
                       "checks":  [
                                      {
                                          "name":  "退出码",
                                          "expected":  "2",
                                          "actual":  "2",
                                          "ok":  true
                                      },
                                      {
                                          "name":  "stdout 含中文原因",
                                          "expected":  "未取得 electron 锁",
                                          "actual":  "True",
                                          "ok":  true
                                      },
                                      {
                                          "name":  "报告 lockAcquired=false",
                                          "expected":  "False",
                                          "actual":  "True",
                                          "ok":  true
                                      },
                                      {
                                          "name":  "报告 M5 记 skipped",
                                          "expected":  "skipped",
                                          "actual":  "True",
                                          "ok":  true
                                      },
                                      {
                                          "name":  "工作区干净",
                                          "expected":  "empty",
                                          "actual":  "empty",
                                          "ok":  true
                                      }
                                  ],
                       "evidence":  ".scratch/run/H/drills/lock"
                   },
                   {
                       "name":  "revert",
                       "ac":  "AC-H-13",
                       "passed":  true,
                       "exitCode":  4,
                       "checks":  [
                                      {
                                          "name":  "退出码",
                                          "expected":  "4",
                                          "actual":  "4",
                                          "ok":  true
                                      },
                                      {
                                          "name":  "stdout 含中文提示",
                                          "expected":  "反向还原失败",
                                          "actual":  "True",
                                          "ok":  true
                                      },
                                      {
                                          "name":  "报告 M5 记 revert-failed",
                                          "expected":  "revert-failed",
                                          "actual":  "True",
                                          "ok":  true
                                      },
                                      {
                                          "name":  "看门狗确实注入过外部改动",
                                          "expected":  "1",
                                          "actual":  "0",
                                          "ok":  true
                                      },
                                      {
                                          "name":  "目标文件已恢复演练前内容",
                                          "expected":  "identical",
                                          "actual":  "True",
                                          "ok":  true
                                      },
                                      {
                                          "name":  "工作区干净",
                                          "expected":  "empty",
                                          "actual":  "empty",
                                          "ok":  true
                                      }
                                  ],
                       "evidence":  ".scratch/run/H/drills/revert"
                   }
               ],
    "leftovers":  {

                  },
    "summary":  {
                    "killed":  3,
                    "survived":  1,
                    "skipped":  1,
                    "applyFailed":  0,
                    "revertFailed":  0,
                    "greenFailed":  0
                }
}
```
