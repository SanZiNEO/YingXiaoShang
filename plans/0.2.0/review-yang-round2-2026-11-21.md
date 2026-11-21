# 杨泽易 A–I 九轮实现审查（2026-11-21，main @ 6ded55db）

> 审查对象：`c28ebce9...6ded55db`，30 个提交、226 个文件（`apps/server` 全量 + `tools/*` 六套 + 九轮文档）。
> 审查方式：同步到本地、**真跑**他的测试与服务，不是读代码猜。
> 分级沿用 `review-kit.md`：P0 会挂住/错交付/断数据、P1 明显退化或需求未接通、P2 收敛与维护。

---

## 一、总判断

**方向与工程质量都到位，但有两个必须先修的问题（一个 P0 级部署风险、一个 P1 数据 bug）。**

实测清单（全部我亲手跑的）：

| 项目 | 结果 |
|---|---|
| `apps/server` typecheck | ✅ 0 错误 |
| 服务端单测（`node --import tsx --test test/*.test.ts`） | ✅ **28 / 28 通过** |
| 五步 smoke（登录→提问→出题→交卷→查档案） | ✅ **5 / 5 PASS**（空库也能跑完） |
| OpenAPI 自检（`openapi-check.mjs`） | ✅ **8 / 8 PASS**（30 方法、4 legacy、12 冻结路径、SSE） |
| 契约测试（`--target http`，正确凭据） | 🟡 **63 passed / 3 failed / 14 skipped** |
| 契约测试重跑同一命令 | ❌ **5 passed / 56 failed**（触发 429，见 P1-3） |

**这套工程化程度超出预期**：冻结契约 + OpenAPI 生成 + 单测 + 契约测试 + mutation 验证 + 九轮文档（每轮 scope/contract/implementation/acceptance 四件套），
比我这边的工作规范得多。下面挑问题，不代表否定整体。

---

## 二、P0：登录限流按 IP 计数，一个班会被互相锁死

- **位置**：`apps/server/src/app.ts:18-19`、`:81-91`、`:232-236`
- **配置**：`RATE_WINDOW_MS = 60_000`、`LOGIN_LIMIT = 5`；键是 `clientIp(req)`
  （优先 `x-forwarded-for` 第一段，否则 `req.socket.remoteAddress`）
- **为什么是 P0**：教室里 40 个学生通常共用**一个出口 IP**（校园网 NAT / 机房代理）。
  按 IP 计数意味着**全班共享 5 次/分钟的登录额度**：
  - 第 6 个登录的学生收到 429「尝试太频繁，请等一分钟再试」
  - 这不是恶意攻击，是正常上课
  - 后果是「全班轮流等」，比功能缺失更难解释
- **证据（我实测到的同一机制）**：连续跑两次契约测试（每次登录 2 个账号），
  第二次直接 5 passed / 56 failed，首个失败是 `httpStatus 429`。
- **建议（三选一，推荐 a+b）**：
  - a. **按「IP + 学号」计数**：防爆破的语义应该落在「同一个 IP 对同一个学号的尝试次数」；
  - b. **限额可配**：`YXS_LOGIN_LIMIT` / `YXS_LOGIN_WINDOW_MS` 环境变量，默认放宽到 50/分钟；
  - c. 反代部署时用 `x-forwarded-for` 取真实 IP（现在支持，但直连部署就没有 XFF）。

> 这一条如果带到 M1 真机试用，第一天就会全班卡住。**不是"以后优化"的东西。**

---

## 三、P1

### P1-1 新学生首次登录不创建 `student_profiles`，写类接口 500

- **位置**：`apps/server/src/auth/routes.ts`（登录只写 `auth.db`）、`apps/server/src/rpc/handlers/memory.ts`（直接写 `memory_facts`，有 FK 到 `student_profiles`）
- **复现**（我实测）：
  ```
  20230002 登录成功 → memory.upsert
  → 500 {"code":"INTERNAL","message":"FOREIGN KEY constraint failed…"}
  ```
  同样输入用 20230001（有 profile 行）→ 200 成功。
- **原因**：`add-student.mjs` 只写 auth 账号；`student_profiles` 没有对应行。
  桌面端有 `ensureStudent`，服务端没有。
- **后果**：新学生登录后，**所有写入类接口都会失败**（学情、记忆、交卷），而这正是 M1 的核心闭环。
- **建议**：登录成功时 `upsertStudentProfile`（幂等），或每个写入 handler 前 `ensureStudent`。
  推荐前者：一处解决，且登录本来就是「已知这个学号」。

### P1-2 500 把 SQL 错误原文透给学生

- **证据**：`FOREIGN KEY constraint failed（如果反复出现，把这句话截图发给老师）`
- 这违反我们既有的产品规则（`apps/desktop/src/main/errors.ts` 的 `friendlyError`：
  不出现英文栈/内部术语）。
- **原因**：服务端的 `errors.ts` 是从桌面端复制的，但只覆盖了 401/402/429/网络等，
  **没有覆盖 `FOREIGN KEY constraint failed` / `UNIQUE constraint failed` / `NOT NULL constraint failed`**。
  底面的 `friendlyError` 兜底把原始英文当成正文返回。
- **建议**：补三条 SQL 约束错误的中文化，并在服务端复用同一份 `friendlyError`
  （现在两边各一份，容易再次分叉）。

### P1-3 契约测试不处理 429，同一条命令两次结果不同

- **证据**：
  ```
  第 1 次：63 passed / 3 failed / 14 skipped
  第 2 次：5 passed / 56 failed / 19 skipped   ← 首个失败 httpStatus 429
  单条跑 E-021 / E-071：各 1 passed
  ```
- **后果**：CI 里会随机红；本地也会让人误判「服务端坏了」。这次是我先判了「56 条失败」，
  排查后才发现是限流。
- **建议**：
  - 429 时按 `Retry-After` 或固定 60s 退避重试；
  - 测试账号走白名单/免限流（`YXS_LOGIN_LIMIT=1000` 一行环境变量就够）；
  - 报告里把「429 导致的失败」单独归类，不要混进实现失败。

### P1-4 `news.refresh` 在采集服务不可用时返回 502，契约要求 200

- **证据**：`E-006`（单独跑仍失败）：`httpStatus expected 200 actual 502`，
  服务端日志 `{"status":502,"code":"UPSTREAM_FAILED"}`。
- 契约（`tools/contract-tests/src/frozen.mjs`）对 `news.refresh` 期望
  `200 + { results, queued, accepted, count, newestFetchedAt }`。
- **两种正确做法**（需要拍板，不是 bug 修法）：
  - a. 改实现：采集服务不可用时返回 **200** + `queued:false` + `accepted:[]` + 说明字段，
    前端显示「采集服务暂不可用，先看本地旧闻」；
  - b. 改契约：明确 502 + 固定中文文案，前端按 502 显示「新闻服务未就绪」。
- **建议 a**：因为 `refresh` 是「尽力而为」的动作，把不可用表达成「没排上队」比报错更贴合语义。

---

## 四、P2

| 位置 | 问题 | 建议 |
|---|---|---|
| `apps/server/src/health.ts` + 契约测试探活 | 空库时 `/health` 503 → 契约测试整组 **skipped 80 条、failed 0**，报告容易被读成「通过」 | 环境未就绪时让 CI 非零退出，或报告顶部给醒目横幅 |
| `tools/contract-tests` | 14 条因隔离 home 里没有 artifact/session/evidence 而 skip（不编造 ID 的做法是对的） | seed 时把 artifact/evidence 一并带上，否则写类接口的归属校验长期无覆盖 |
| `apps/server/src/app.ts:232` | 限流只记 `observeLogin('rate_limited')`，没有记录是哪个 IP/学号被限流 | 日志加 `limitedIp` 字段，排障时能定位 |
| 服务端 `errors.ts` 与桌面端 `errors.ts` 两份 | 同一份产品文案两处维护，已经出现 P1-2 这种漂移 | 抽到 `packages/shared`，两边 import |

---

## 五、做对了、需要保留的部分（有证据）

1. **安全语义扎实**：
   - `auth/passwords.ts` 用 `scrypt`（N=16384）+ `timingSafeEqual`，格式自描述 `scrypt$N$r$p$salt$hash`；
   - `ownership.ts` 的 403 **不枚举**：`requireEvidence` / `requireMemoryFact` 走「本人列表里 find」，
     查不到就是 403 而不是 404 —— 这正是我们契约里要求的「不暴露存在与否」。
2. **取消真的会停**：`chat/stream.ts:70-72` 客户端断开自动 `controller.abort()`，
   `:123` 把 signal 交进 `handleConversation`；我设 `YXS_MOCK_DELAY_MS=120` 后 `E-071` 通过
   （第一次失败是因为我没设延迟，回答在取消前就完成了——**这是测试环境问题，不是实现问题**）。
3. **`ignoredStudentId` 有日志字段**：说明作者已经想到「客户端传 studentId 要忽略」这件事，
   和我们 `packages/dispatch` 的越权断言是同一个判断。
4. **`legacy` 标记**：4 个 Electron 时代的方法单独标 `legacy`，OpenAPI 里生成 `x-legacy-methods`，
   不混进 30 个正式方法——这个收敛意识很好。
5. **业务没有重复实现**：handlers 直接调 `ctx.services.db/profile/matcher`，
   `chat` 直接调 `services.agent.handleConversation`。我们抽的 `packages/dispatch` 与他这层是
   **两层薄适配、同一批 service**，不是两套业务。

---

## 六、与我们这边工作的交叉点

| 事项 | 结论 |
|---|---|
| `packages/dispatch` 是否还需要 | **需要**：桌面端用它（不必重写业务）；服务端用他的 MethodSpec（有校验/schema/错误码）。两者都调 `packages/*`，不冲突 |
| 参数默认值可能不一致 | 有风险（如 `limit` 默认 200 vs validate 上限 200）。靠契约测试守，但**要先修 P1-3 的 429**，否则测试不稳定 |
| PG 迁移工具（他做了 `tools/migrate-pg`） | 我们结论是 M1 不迁 PG（`docs/contracts/database-plan.md`）。工具保留，作为 M2 选项；不删，但要标明「当前不启用」，避免有人以为 M1 跑在 PG 上 |
| `news.refresh` 的 502 | 与我们的「采集回传」方案相关：改成 200 + `queued:false` 更符合单写者架构 |

---

## 七、给他的回复建议（按优先级，可直接转发）

1. **登录限流改成「IP + 学号」，并支持环境变量配置**（P0，教室 NAT 会全班锁死）
2. **登录时 `upsertStudentProfile`**（P1，新学生一写就 500）
3. **`friendlyError` 补 SQL 约束错误的中文化，并把两份 errors.ts 合成一份**（P1）
4. **契约测试处理 429**（退避重试或测试账号免限流）（P1）
5. **`news.refresh` 不可用时返回 200 + `queued:false`**（P1，与采集回传架构一致）
6. `/health` 503 时让 CI 明确失败，别静默 skip（P2）

其余（PG 工具保留、legacy 收敛、文档体系）都保持现状即可。
