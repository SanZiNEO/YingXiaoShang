# Mutation 反向验证记录（本轮未执行）

> 04-acceptance §5 的 5 个 mutation 用于验证测试能不能真的把契约改坏染红。本轮按分工**不执行改坏与还原**，留待用户统一验收；本文件登记每个 mutation 的目标文件、预期变红的 AC、手工执行步骤与判定口径。

判定：改坏后对应 AC 变红 = **killed**（用例覆盖到了）；仍绿 = **survived**（用例没覆盖到这条契约，需要补用例）。还原后必须恢复全绿。

| # | 目标文件 | 改坏方式 | 预期变红 | 手工步骤 | 状态 |
|---|---|---|---|---|---|
| M1 | `src/auth/bearer.ts` | 把身份解析改回从请求体 `params.studentId` 取（忽略 token 里的学号） | AC-A-04（伪造 `studentId=99999999` 仍返回 A 的学号；日志 `ignoredStudentId=true`） | 1. `git status --porcelain` 确认工作区干净；2. 改坏 `bearer.ts`；3. 跑 AC-A-04 记录失败输出；4. `git checkout -- src/auth/bearer.ts`；5. 复跑确认变绿；6. 失败/通过原文贴回本文件 | 待统一验收 |
| M2 | `src/http/sse.ts`（`SseWriter`） | `done()` 里删掉 `this.send('done', payload)`，只 `close()` | AC-A-11（首帧 session、末帧 done、done 仅一次）、AC-A-20（smoke 五步） | 同 M1 流程；改坏后 `curl -N` 观察到连接结束但无 `event: done`；还原后复跑 smoke 全绿 | 待统一验收 |
| M3 | `src/rpc/validate.ts` | `requiredNumber()` 不再校验整数，直接 `Number()` 转换 | AC-A-06（`kps.list` 传 `limit:"10"` 应 400：`limit 必须是 1 到 500 的整数。`） | 改坏后字符串 `limit` 被静默转成数字、请求 200；还原后三条非法输入均 400 且逐字中文消息一致 | 待统一验收 |
| M4 | `src/auth/store.ts` | `revoke()` 改成空实现（不写 `revoked_at`） | AC-A-05（登出后同一 token 再调 `student.current` 应 401：`登录已失效，请重新登录。`） | 改坏后登出 token 仍可用；还原后复跑 AC-A-05 返回 401 | 待统一验收 |
| M5 | `scripts/gen-openapi.mjs` | 把 4 个 legacy（`getKp`/`getBlock`/`getResource`/`listIdeology`）混进 `method.enum` | AC-A-18（enum 应为 30；混入后变 34，`openapi-check.mjs` 失败） | 改坏后重跑 `gen:openapi` + `check:openapi`，记录 enum=34 的失败输出；还原后重新生成，自检恢复 30 项 | 待统一验收 |

## 执行约定

```powershell
cd <仓库根>
git diff --stat              # 确认只改动了预期文件
# 手工改坏 → 跑对应 AC → 记录失败输出 → git checkout -- <file> → 再跑 → 记录通过输出
git status --porcelain       # 必须干净（除 .scratch 与 evidence）
```

每个 mutation 的「失败输出」与「还原后通过输出」原文贴在本文件对应小节下方；当前为空，因为本轮不改业务代码、不伪造变红结果。

## 回填区（验收时填写）

### M1 — bearer 身份来源

- 改坏后失败输出：（待填）
- 还原后通过输出：（待填）
- 判定：killed / survived（待填）

### M2 — SSE done 帧

- 改坏后失败输出：（待填）
- 还原后通过输出：（待填）
- 判定：killed / survived（待填）

### M3 — 数字整数校验

- 改坏后失败输出：（待填）
- 还原后通过输出：（待填）
- 判定：killed / survived（待填）

### M4 — token 撤销

- 改坏后失败输出：（待填）
- 还原后通过输出：（待填）
- 判定：killed / survived（待填）

### M5 — legacy 混入 enum

- 改坏后失败输出：（待填）
- 还原后通过输出：（待填）
- 判定：killed / survived（待填）
