# H · Electron 用例变红

## 要实现

- 5 条 mutation：取消、交卷、流式、打包启动、空题目集。
- 每条 mutation 一个最小 patch：只改坏实现，不带修复。
- `run-mutation.ps1`：应用 patch → 跑指定用例 → 断言红 → 反向还原 → 断言绿。
- mutation 报告：改了什么、命令、失败输出、还原后输出。
- 31 条已跑通的证据索引。

## 产出

```text
tools/automated-testing/mutations/
  cancel.patch
  submit.patch
  streaming.patch
  packaged-boot.patch
  empty-question-set.patch
tools/automated-testing/scripts/run-mutation.ps1
tools/automated-testing/mutation-report.md
```
