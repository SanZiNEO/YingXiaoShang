# A · 服务端骨架 · 验收

> 轮次：A · 服务端骨架
> 文档角色：04-acceptance
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1
> 一句话：20 条 AC 全部可命令复现；任何一条只能靠「我觉得对」的，都不算过。

## 1 验收口径

**过 = 下列三组同时成立**：

1. **硬指标**：30 方法各至少 1 次 200 且字段齐全；5 通道全部可用；OpenAPI 的 method enum 恰好 30 项；`/metrics` 含 10 个 `yxs_*` 指标名；镜像 `Config.User=10001`；`smoke.mjs` 五步全绿（`YXS_LLM=mock`，断网可跑）。
2. **反向验证**：§5 的 5 个 mutation 每个都能让指定 AC 变红；改回后变绿。
3. **证据**：每条 AC 在 `.scratch/run/A/evidence/` 留下可复跑的请求/响应原文。

不可替代项（不能用「手工点了一遍」代替）：SSE 顺序、取消静默、越权 403、`SQLITE_BUSY` 计数、OpenAPI enum 数量。

「可机器判定的才算验收」这条口径来自测试实践：断言写成可执行检查，而不是人工观察 [R36]。

## 2 前置条件

```powershell
cd E:\Documents\GitHub\YingXiaoShang

# 1) 准备隔离数据（不要用 .learning-agent 真实目录）
New-Item -ItemType Directory -Force .scratch\run\A\home\data | Out-Null
Copy-Item .scratch\sample-home\data\learning.db .scratch\run\A\home\data\learning.db -ErrorAction SilentlyContinue
if (-not (Test-Path .scratch\run\A\home\data\learning.db)) {
  # 没有示例库时用种子库
  pnpm run db:seed
  Copy-Item .learning-agent\data\learning.db .scratch\run\A\home\data\learning.db
}

# 2) 建一个测试学生（首次登录用；口令 abc12345）
$env:LEARNING_AGENT_HOME = (Resolve-Path .scratch\run\A\home).Path
pnpm --dir apps/server exec tsx scripts/add-student.mjs --id 20230001 --name 张三 --cohort 2023 --password abc12345

# 3) 起服务
$env:YXS_LLM = 'mock'; $env:YXS_MOCK_SCRIPT = 'tools'; $env:YXS_SERVER_PORT = '8080'
pnpm --dir apps/server dev
```

缺什么就明说「缺则跳过并标记」：没有种子库 → 跳过依赖真实章节数的 AC-A-01 断言（改为断言 `chapters >= 0`）；没有 Docker → 跳过 AC-A-19 并标 `skipped`。

建测试学生时用 `--password abc12345` 只是为了本地可复现；口令存储仍走 scrypt，验收不检查明文落盘 [R9]。

## 3 用例清单

| 编号 | 操作 | 期望 | 失败判据 | 证据 |
|---|---|---|---|---|
| AC-A-01 | `curl -s localhost:8080/health` | `200`，`result.ok=true`，`chapters`/`knowledgePoints`/`newsArticles` 为整数，`appHome` 为绝对路径 | 任一字段缺失；`chapters` 为字符串 | `health.json` |
| AC-A-02 | `POST /api/v1/auth/login` 正确学号口令 | `200`；`token` 长度 43；`expiresAt` ≈ 现在 +7 天（±5 分钟） | token 长度不符；无 `expiresAt` | `login.json` |
| AC-A-03 | 分别用「错误口令」「不存在的学号」登录 | 两次都 `401`，且 `error.message` **完全相同**（`学号或口令不对，请检查后再试。`） | 两条消息不同；状态码不同 | `login-fail-1.json`、`login-fail-2.json` |
| AC-A-04 | 带 A 的 token，请求体塞 `{"studentId":"99999999"}` 调 `student.current` | 返回 `studentId` 仍是 A 的学号；日志出现 `ignoredStudentId=true` | 返回 99999999；日志无该字段 | `spoof.json` + `main.log` |
| AC-A-05 | `POST /auth/logout` 后复用同一 token 调 `student.current` | `401`，消息 `登录已失效，请重新登录。` | 仍 200 | `logout.json` |
| AC-A-06 | `kps.list` 传 `{"limit":"10"}`；`news.get` 不传 `articleId`；`profile.snapshot` 传 `checkpoint:"mid"` | 三条 `400`，消息分别为 `limit 必须是 1 到 500 的整数。`、`articleId 不能为空。`、`checkpoint 必须是 pre 或 post。` | 任一条 200 或消息不一致（逐字比对） | `bad-1..3.json` |
| AC-A-07 | `POST /rpc` `{"method":"foo.bar"}` | `404`，`code=UNKNOWN_METHOD`，消息 `没有这个方法：foo.bar` | 500；英文消息；`code` 不符 | `unknown.json` |
| AC-A-08 | 跑 `node scripts/probe-methods.mjs`（按 OpenAPI enum 逐条打合法输入） | 30/30 `ok:true`，且每个响应含 §5 表列出的必含字段 | 任一方法非 200；任一必含字段缺失 | `methods.jsonl` |
| AC-A-09 | 同上，打 4 个 legacy：`getKp` `getBlock` `getResource` `listIdeology` | 4/4 `200`，字段齐全（`getBlock` 含 `block`；`getResource` 含 `guide`） | 任一 `UNKNOWN_METHOD` | `legacy.jsonl` |
| AC-A-10 | 用学生 B 的 token 读学生 A 的 `chat.messages`（`sessionId` 取自 A） | `403`，消息 `这个资源不属于当前学号，换回自己的账号再试。` | 200；或返回空数组（等于泄漏「存在与否」） | `forbidden.json` |
| AC-A-11 | `curl -N -X POST /api/v1/chat/stream` 发一句「你好」 | 第一帧 `event: session` 且含 `sessionId`；最后一帧 `event: done` 且含 `turnId/text/sessionId`；中间 `text` 有 ≥3 帧 | 首帧不是 `session`；无 `done`；`done` 出现两次 | `sse-raw.txt` |
| AC-A-12 | 发一条长回答，200ms 后 `POST /chat/cancel` | 收到 `event: error` 且 `code=CANCELLED`；此后 1s 内该 `requestId` 无新 `text` | 1s 后仍有 `text`；无 `error`；HTTP 直接断开无事件 | `cancel.txt` |
| AC-A-13 | 出题（mock 脚本）拿到 `artifactId` → `answer-set` 提交 `q1/q2` → `questions.attempts` 回读 | 交卷 `200` 且 `status=completed`；`attempts` 能查到这两题 | 交卷 500；回读为空 | `answer-set.json`、`attempts.json` |
| AC-A-14 | 不带 token 调 `/health` 与 `/api/v1/health` | 均 `200`，且 `warnings` 是数组 | 401 | `health-no-auth.json` |
| AC-A-15 | `curl -s localhost:8080/metrics` | 含 10 个指标名（§9.2 全表），且 `yxs_http_request_duration_seconds_bucket` 有 12 个 `le` 桶 | 任一缺失；桶数量不符 | `metrics.txt` |
| AC-A-16 | 抓 100 行日志，检查字段与敏感词 | 每行是合法 JSON；含 `requestId/studentId/method/status/durationMs`；**不含** token、口令、消息正文 | 有非 JSON 行；出现 `Bearer`、`abc12345`、学生原话 | `log-sample.jsonl` |
| AC-A-17 | 60 并发同时打 `profile.snapshot`（写库） | `yxs_sqlite_busy_total` 有值（>0 或明确为 0 且 WAL 生效可解释）；无 500 | 出现未捕获异常；指标不存在 | `busy.txt` |
| AC-A-18 | `node scripts/openapi-check.mjs` | `rpc.method enum = 30`；5 个通道 path 齐全；`x-legacy-methods = 4` | 数量不符；缺 path | `openapi-check.txt` |
| AC-A-19 | `docker build -f apps/server/Dockerfile -t yxs-server:local .` 后 `docker run` | 构建成功；`User=10001`；容器 `/health` 200；镜像 < 500 MB | `User` 为空/root；health 非 200 | `docker.txt` |
| AC-A-20 | `node apps/server/scripts/smoke.mjs` | 五步全过：登录→提问→出题→交卷→查档案，输出 5 行 `PASS` | 任一步 FAIL | `smoke.txt` |
| AC-A-21 | 断网（关 Wi-Fi / 加 hosts 黑洞 `api.deepseek.com`）后重跑 smoke | 全绿（`YXS_LLM=mock`） | 任一步失败 | `smoke-offline.txt` |

用例的写法遵循「一条 AC 一个可观察结果 + 明确失败判据」，避免「看起来正常」这种不可判定的描述 [R36]。

## 4 证据

- 落点：`.scratch/run/A/evidence/<AC 编号>/`，每条 AC 一个目录，含 `request.txt`（curl 原文）、`response.json`、`status.txt`。
- 统一采集脚本（写进 `04` 同目录 `evidence.ps1`，验收时直接跑）：

```powershell
$base = 'http://127.0.0.1:8080'
$out  = '.scratch\run\A\evidence'
$tok  = (curl.exe -s -X POST "$base/api/v1/auth/login" -H 'content-type: application/json' `
        -d '{"studentId":"20230001","password":"abc12345"}' | ConvertFrom-Json).result.token
New-Item -ItemType Directory -Force "$out\AC-A-01" | Out-Null
curl.exe -s -D "$out\AC-A-01\headers.txt" "$base/health" -o "$out\AC-A-01\response.json"
```

- 复跑要求：所有 AC 必须能在**同一个 home** 上重复跑（第二次跑前删除 `auth.db` 或换学号），不能依赖「第一次跑才过」。

证据存成「请求原文 + 响应原文」而不是截图，是为了让失败能在 CI 里复盘；结构化事件落盘（每请求一行 JSON）与 12-Factor 的日志观一致 [R6]。

## 5 反向验证（mutation）

| # | 改坏哪里 | 预期变红的 AC | 还原后 |
|---|---|---|---|
| M1 | `src/auth/bearer.ts`：把 `studentId` 改成从 `params.studentId` 取（回退到现状行为） | AC-A-04 | 变绿 |
| M2 | `src/http/sse.ts`：`done()` 里删掉 `this.send('done', payload)`，只 `close()` | AC-A-11、AC-A-20 | 变绿 |
| M3 | `src/rpc/validate.ts`：`num()` 不再校验整数（直接 `Number()`） | AC-A-06 | 变绿 |
| M4 | `src/auth/store.ts`：`revoke()` 改成空实现 | AC-A-05 | 变绿 |
| M5 | `scripts/gen-openapi.mjs`：把 legacy 的 4 个混进 `method.enum` | AC-A-18（enum=34） | 变绿 |

执行约定：

```powershell
git diff --stat              # 确认只改动了预期文件
# 手工改坏 → 跑对应 AC → 记录失败输出 → git checkout -- <file> → 再跑 → 记录通过输出
git status --porcelain       # 必须干净（除 .scratch 与 evidence）
```

每个 mutation 的「失败输出」原文贴进 `mutation-report.md`（A 轮自建，放 `apps/server/docs/mutation-notes.md`，不占 H 轮的目录）。

mutation 的判据是「killed / survived」：用例变红 = killed，仍绿 = survived（说明用例没覆盖到这条契约）。术语与报告口径参照 [R52][R53]，但我们只维护 5 个手写 patch，不引入 Stryker 运行时。

## 6 排查表

| 症状 | 最可能原因 | 一条命令确认 |
|---|---|---|
| 启动即退出，码 2 | 数据目录不可写 | `Test-Path $env:LEARNING_AGENT_HOME; icacls $env:LEARNING_AGENT_HOME` |
| `/health` 200 但 `chapters=0` | 库是空库（没复制种子） | `node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('.scratch/run/A/home/data/learning.db');console.log(d.prepare('select count(*) n from chapters').get())"` |
| 登录 401 但口令确定对 | 测试学生没建 / `auth.db` 指向别处 | `Get-ChildItem .scratch\run\A\home\data\auth.db`；启动日志里的 `authDbPath` |
| SSE 一次性吐出全部文本 | 中间层缓冲 / 没设 `X-Accel-Buffering` | `curl.exe -N -v`，看响应头 |
| 取消后模型还在跑 | 只断连接没 `abort` | 看 `src/chat/stream.ts` 里 `res.on('close')` 是否调 `controller.abort()` |
| `SQLITE_BUSY` 指标恒 0 | 没包 `db.exec` / WAL 生效 | 60 并发写时 `curl /metrics | findstr busy` |
| `/metrics` 缺桶 | 用了默认桶（prom-client 默认不含 30s） | 看 `new Histogram({buckets:[...]})` |
| OpenAPI enum 少一项 | 改了 `METHODS` 没重跑生成器 | `pnpm --dir apps/server run gen:openapi && git diff docs/contracts/openapi.yaml` |
| 镜像里 `chapters=0` | 没设 `YXS_DB_PATH` / 没挂卷 | `docker run --rm yxs-server:local node -e "console.log(process.env.LEARNING_AGENT_HOME)"` |

排查表按「症状 → 最可能原因 → 一条确认命令」组织；指标类症状（如桶缺失、busy 恒 0）必须落到 `/metrics` 原文上，不看平均值 [R44]。

## 7 自检输出

文档自检是「交活前的最后一道机器闸」：它只查得到结构与引用是否对得上，查不到内容对不对——内容由 §3 的 21 条 AC 负责。这种「机器查形式、人查语义」的分工，是测试实践里反复强调的底线 [R36]。

```powershell
cd E:\Documents\GitHub\YingXiaoShang
python plans\server-client-split\00-master\check-docs.py --round A
```

```text
仓库根：E:\Documents\GitHub\YingXiaoShang
检查轮次：A
行数统计：
  A-*: 1051 行 / 4 份

全部通过：轮次齐全、节数达标、每节有引用、参考清单与本地行号引用都对得上。
```

（实跑时间 2026-11-19，退出码 0；行数统计会随文档微调变化，以最后一次为准。）

## 参考

- [R3] JSON-RPC 2.0 规范 — https://www.jsonrpc.org/specification — 支撑 §3 AC-A-07 未知方法与 §1 单端点口径 — 借鉴 `method/params/error`，不做 batch。
- [R7] OWASP REST Security Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html — 支撑 §3 AC-A-10 越权 403 与 §1 身份只信 token — 采用最小信息披露。
- [R9] Node.js crypto 文档 — https://nodejs.org/api/crypto.html — 支撑 §2 建测试学生口令与 §3 AC-A-02 token 长度 — 采用 scrypt + 32 字节随机。
- [R36] JavaScript Testing Best Practices — https://github.com/goldbergyoni/javascript-testing-best-practices — 支撑 §1 可机器判定口径与 §3 用例写法 — 采用可执行断言，不用人工观察。
- [R44] Prometheus 直方图实践 — https://prometheus.io/docs/practices/histograms/ — 支撑 §3 AC-A-15/17 的指标断言与 §6 排查 — 采用 histogram_quantile，禁用平均值。
- [R52] Stryker JS — https://github.com/stryker-mutator/stryker-js — 支撑 §5 mutation 范式 — 借鉴 killed/survived，不引入运行时。
- [R53] Stryker 文档 — https://stryker-mutator.io/docs/ — 支撑 §5 报告口径 — 同上。
