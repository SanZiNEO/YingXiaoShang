# E · 契约测试 · 契约

> 轮次：E · 契约测试
> 文档角色：02-contract
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1（本文件只细化，不新增错误码、不改端口、不改方法名）
> 一句话：每条用例的编号、入参、期望 code/HTTP/中文消息、报告字段、覆盖判定与 mutation 红例全部写死，实现者照着生成用例，验收者照着判过。

## 1 契约总览

| 层 | 冻结口径（来自冻结文件） | 本轮细化 |
|---|---|---|
| 传输 / 端口 / 前缀 | §2：`http://127.0.0.1:8080`、`/api/v1`、JSON `ensure_ascii=false` | E 的 http target 可用随机空闲端口覆盖 base URL |
| 鉴权与归属 | §3：Bearer token、`studentId` 只从 token 解析、四类归属校验 | 用例的双学生越权构造方式与 `403` 断言（§3、§4） |
| RPC 信封 | §4.1：`{method,params,requestId}` / `{ok,result,requestId,elapsedMs}` / 失败 `{ok:false,error:{code,message,field,detail}}` | 断言原语逐项对齐信封字段（§3、§6） |
| 错误码与中文消息 | §4.2：14 个 code 与逐字消息 | 每条非法用例绑定具体 code、HTTP、消息原文（§4） |
| 30 方法清单 | §5：方法名、必填、其他 params、返回顶层、写/归属 | 逐方法合法/非法入参与期望表（§3） |
| 4 legacy 方法 | §6：`getKp`/`getBlock`/`getResource`/`listIdeology`，不计入 30 覆盖 | 各 1 条合法用例（§3 末段） |
| 5 专用通道 | §7：`chat/stream`、`chat/cancel`、`answer`、`answer-set`、`health` | 通道用例编号、事件序列断言、回读断言（§5） |
| OpenAPI 覆盖 | §8：enum=30、通道 path=5、`x-legacy-methods`=4、`*Result` schema | coverage 输出结构与判定（§7） |

**契约稳定性**：本文件出现的用例编号、断言字段名、报告 JSON 字段名视为 v1 冻结。被断言的服务端字段允许新增（客户端断言只查必含字段，容忍未知字段）；删除或改名必致对应用例变红，这正是 mutation 要捕获的退化 [R38]。OpenAPI 作为跨调用方边界的组织方式遵循 [R2]。

## 2 用例编号体系与总量算术

### 2.1 编号规则

- 全局编号 `E-001` 起顺序递增，三位补零；每条用例一个编号，不重用、不跳号。
- 用例元数据 `kind` 取值：`method-legal`（方法合法）、`method-illegal`（方法非法）、`legacy`（legacy 合法）、`illegal-class`（非法五类专属）、`channel`（专用通道）、`oas`（OpenAPI 覆盖）。
- 元数据 `target` 取值：`http`、`electron`、`both`、`stub`；同一条契约用例在不同 target 下各产出一条报告记录，编号不变，`target` 字段区分。
- 编号段分配：

| 段 | kind | 数量 | 编号 |
|---|---|---|---|
| 30 方法合法 | `method-legal` | 30 | `E-001` … `E-030` |
| 30 方法非法 | `method-illegal` | 30 | `E-031` … `E-060` |
| 4 legacy 合法 | `legacy` | 4 | `E-061` … `E-064` |
| 非法五类专属 | `illegal-class` | 5 | `E-065` … `E-069` |
| 专用通道 | `channel` | 7 | `E-070` … `E-076` |
| OpenAPI 覆盖 | `oas` | 4 | `E-077` … `E-080` |

### 2.2 总量算术

```text
30 方法 × 2（合法 1 + 非法 1）        = 60
4 legacy 方法 × 1（合法）             =  4
非法五类专属（缺字段/类型错/404/403/未知方法）=  5
专用通道（SSE 顺序 1 + SSE 取消 1 + cancel 未知 1
          + answer 回读 1 + answer-set 回读 1
          + answer-set 空数组 1 + health 无鉴权 1）=  7
OpenAPI 覆盖（enum 30 + 通道 path 5 + legacy 4 + Result schema 30）=  4
合计                                  = 80
```

`summary.total` 必须等于 80；`coverage` 命令不计入这 80 条的执行计数，其 4 项核对分别对应 `E-077` … `E-080`。用例条目集中登记在 `cases/methods.mjs`、`cases/illegal-class.mjs`、`cases/channels.mjs`、`cases/openapi.mjs`，断言原语复用 [R36] 的「一条编号一条断言、失败原因写进断言文本」组织方式。

### 2.3 通用断言口径

合法用例（`method-legal` / `legacy` / `channel` 成功路径）：

- http target：HTTP 200，响应体 `ok === true`，`requestId` 回显与请求一致（请求未带则服务端生成，报告记录回显值），`result` 含冻结 §5 规定的顶层字段。
- electron target：桥接调用 resolve（不 reject），返回对象含同一份顶层字段；不解析 HTTP 状态，状态映射见 §9。
- 不校验 `elapsedMs` 的具体数值，只要求它是 ≥0 的数字。

非法用例（`method-illegal` / `illegal-class` / `channel` 失败路径）：

- http target：HTTP 状态与 `error.code` 同时符合 §4 表；`error.message` 逐字相等；`field` 在 `BAD_REQUEST` 时出现且等于出错参数名。
- electron target：调用 reject，错误消息对照同一份中文目录；现状宽容行为下不成立的条目在报告标差异，不合并到 http 结果。
- 中文消息比对用逐字相等（含标点），不用子串包含 [R7]。

### 2.4 CLI 参数与退出码

`run.mjs` 启动期一次读完参数并冻结，运行期不再重读；参数口径与 `03-implementation.md` §5.1 对齐，实现不得自造第二套默认值。命令在 `tools/contract-tests/` 目录下执行。

| 参数 | 类型 | 默认 | 作用 | 校验失败行为 |
|---|---|---|---|---|
| `--target` | 枚举 `stub` / `http` / `electron` / `both` | `stub` | 选择被测目标：`stub` 内置桩自洽、`http` 打 `apps/server`、`electron` 复用现有 Playwright 封装、`both` 先 http 后 electron 分组跑 | 非法值（不在四者内）→ 退出码 3，中文一行 `参数 --target 非法：取值必须是 stub/http/electron/both。` |
| `--base-url` | string | `http://127.0.0.1:8080` | http 目标的服务端地址；路径前缀固定 `/api/v1`，参数里不带前缀 | 非 `http://host:port` 形态 → 退出码 3，`参数 --base-url 非法：必须是 http://host:port 形态。` |
| `--only`（别名 `--case`） | string | 空（全量 80 条） | 只跑匹配的方法名或用例编号（如 `--only news.list`、`--only E-070`） | 不匹配任何用例 → 退出码 3，`参数 --only 非法：没有匹配到任何用例。` |
| `--home` | string | `.scratch/run/E/home-<短id>/` | 隔离数据目录；http/electron 实例的库副本与产物位置 | 指向真实数据目录（`%APPDATA%`、`~/.learning-agent`、`<repo>/.learning-agent`）→ 拒绝并退出码 3 |
| `--report` | string | `report/<时间戳>/` | 报告落盘目录；相对路径基于 `tools/contract-tests/` | 路径不可写或越出工具包目录 → 退出码 3 |
| `--student-id` | string | 本地测试学生 fixture 学号（`lib/fixtures.mjs`） | http 目标登录前置凭证之一 | 缺省在报告里提示；登录失败按 §4 鉴权路径记用例失败（退出码 1），不算 CLI 非法 |
| `--password` | string | fixture 测试口令 | http 目标登录前置凭证之一 | 同上；口令不出现在报告正文与日志 |

退出码表（权威口径，§9 运行命令引用本表）：

| 退出码 | 含义 | 触发条件 |
|---|---|---|
| 0 | 通过 | 全部用例 `passed`；或按设计 `skipped`/`pending`：`both`/默认目标下 http 组不可达整组跳过、electron 锁未取得整组跳过、OpenAPI 缺失标 `pending`，且其余用例 `passed` |
| 1 | 断言失败 | 至少一条用例 `failed`：业务断言不成立、SSE 超时未收终态、鉴权失败、coverage 核对 `red`（`missing`/`extra`）等；mutation 回放期预期变红被捕获也算 1，revert 后复跑应恢复 |
| 2 | http 前置不可达 | 显式 `--target http` 且连接拒绝/超时、无可用用例；`--target both` 或默认目标下 http 组走 `skipped`，不记 2 |
| 3 | CLI 参数非法 | `--target` 非法值、`--only`/`--case` 不匹配、`--base-url` 形态非法、`--home` 指向真实目录、`--report` 不可写 |

可粘示例（先桩自洽，再打本地服务端，只跑 `news.list` 一条）：

```powershell
cd tools\contract-tests
node run.mjs --target stub
node run.mjs --target http --base-url http://127.0.0.1:8080 --only news.list
```

CLI 参数解析与「先校验参数、再连被测实例」的顺序遵循测试入口单一职责做法 [R36]：参数非法在启动早期退出，不产生半成品报告。

## 3 逐方法入参与断言表

> 方法名、必填项、返回顶层见冻结 §5。逐方法参数表的组织参照声明式校验思路 [R4]，本表只保留入参、期望 code/HTTP/消息三项，不引入反射式框架。合法期望列只写关键顶层字段；非法期望列写该用例的 code / HTTP / 逐字消息。
> 通用非法：`params` 为数组、字符串、`null` 时 → `400 BAD_REQUEST` + `params 必须是对象。`（下表记为「params 非对象」）。

| # | method | 合法入参 | 合法期望 | 非法入参 | 非法期望（code / HTTP / 消息） |
|---|---|---|---|---|---|
| 1 | `student.current` | `{}` | 200 `result` 含 `studentId`,`name`,`cohort` | params 非对象 | `BAD_REQUEST` / 400 / `params 必须是对象。` |
| 2 | `chapters.list` | `{}` | 200 `result` 为 `Chapter[]` | params 非对象 | `BAD_REQUEST` / 400 / `params 必须是对象。` |
| 3 | `kps.list` | `{}`（默认 limit 80） | 200 `result` 为 `KnowledgePoint[]` | `{limit:"80"}` | `BAD_REQUEST` / 400 / `limit 必须是整数。` |
| 4 | `news.list` | `{}`（默认 limit 20） | 200 `result` 为 `NewsArticle[]` | `{limit:99999}` | `BAD_REQUEST` / 400 / `limit 必须是 1 到 200 的整数。` |
| 5 | `news.status` | `{}` | 200 `result` 含 `count`,`newestFetchedAt` | params 非对象 | `BAD_REQUEST` / 400 / `params 必须是对象。` |
| 6 | `news.refresh` | `{}` | 200 `result` 含 `results`,`queued`,`accepted`,`count`,`newestFetchedAt` | `{sources:"36kr"}` | `BAD_REQUEST` / 400 / `sources 必须是非空字符串数组。` |
| 7 | `news.get` | `{articleId:"<种子库存在 id>"}` | 200 `result` 含 `article`,`matches`,`ideology` | `{}`（缺 `articleId`） | `BAD_REQUEST` / 400 / `articleId 不能为空。` |
| 8 | `news.match` | `{articleId:"<种子库存在 id>"}` | 200 `result` 含 `matches` | `{}`（缺 `articleId`） | `BAD_REQUEST` / 400 / `articleId 不能为空。` |
| 9 | `questions.attempts` | `{}` | 200 `result` 为 `attempts[]` | `{questionIds:"q1"}` | `BAD_REQUEST` / 400 / `questionIds 必须是非空字符串数组。` |
| 10 | `profile.get` | `{}` | 200 `result` 为 `Profile` | params 非对象 | `BAD_REQUEST` / 400 / `params 必须是对象。` |
| 11 | `profile.growth` | `{}` | 200 `result` 为 growth summary | params 非对象 | `BAD_REQUEST` / 400 / `params 必须是对象。` |
| 12 | `profile.evidence` | `{}`（默认 limit 100） | 200 `result` 为 `Evidence[]` | `{limit:0}` | `BAD_REQUEST` / 400 / `limit 必须是 1 到 500 的整数。` |
| 13 | `profile.snapshot` | `{chapterId:"<存在 id>",checkpoint:"pre"}` | 200 `result` 为 snapshot | `{checkpoint:"pre"}`（缺 `chapterId`） | `BAD_REQUEST` / 400 / `chapterId 不能为空。` |
| 14 | `profile.review` | `{evidenceId:"<存在 id>",status:"reviewed"}` | 200 `result` 为 `{ok:true}` | `{evidenceId:"<存在 id>",status:"bad"}` | `BAD_REQUEST` / 400 / `status 必须是 draft、reviewed 或 rejected。` |
| 15 | `artifacts.list` | `{}`（默认 limit 50） | 200 `result` 为 `Artifact[]` | `{limit:9999}` | `BAD_REQUEST` / 400 / `limit 必须是 1 到 200 的整数。` |
| 16 | `artifacts.get` | `{artifactId:"<本人存在 id>"}` | 200 `result` 为 `Artifact` | `{}`（缺 `artifactId`） | `BAD_REQUEST` / 400 / `artifactId 不能为空。` |
| 17 | `artifacts.export` | `{artifactId:"<本人存在 id>"}` | 200 `result` 为 `{path}` | `{artifactId:"<本人存在 id>",format:"pdf"}` | `BAD_REQUEST` / 400 / `format 必须是 md、docx 或 html。` |
| 18 | `memory.facts` | `{}` | 200 `result` 为 `MemoryFact[]` | params 非对象 | `BAD_REQUEST` / 400 / `params 必须是对象。` |
| 19 | `memory.episodes` | `{}`（默认 limit 50） | 200 `result` 为 `MemoryEpisode[]` | `{limit:"50"}` | `BAD_REQUEST` / 400 / `limit 必须是整数。` |
| 20 | `memory.summary` | `{}` | 200 `result` 为 `MemorySummary` | params 非对象 | `BAD_REQUEST` / 400 / `params 必须是对象。` |
| 21 | `memory.upsert` | `{key:"e-contract",value:"样例"}` | 200 `result` 为 `MemoryFact` | `{value:"样例"}`（缺 `key`） | `BAD_REQUEST` / 400 / `key 不能为空。` |
| 22 | `memory.delete` | `{factId:"<本人存在 id>"}` | 200 `result` 为 `{ok:true}` | `{}`（缺 `factId`） | `BAD_REQUEST` / 400 / `factId 不能为空。` |
| 23 | `chat.sessions` | `{}` | 200 `result` 为 `ChatSession[]` | params 非对象 | `BAD_REQUEST` / 400 / `params 必须是对象。` |
| 24 | `chat.messages` | `{sessionId:"<本人存在 id>"}` | 200 `result` 为 `ChatMessage[]` | `{}`（缺 `sessionId`） | `BAD_REQUEST` / 400 / `sessionId 不能为空。` |
| 25 | `agent.snapshot` | `{}` | 200 `result` 为 `LearningStateSnapshot` | params 非对象 | `BAD_REQUEST` / 400 / `params 必须是对象。` |
| 26 | `agent.suggestions` | `{}` | 200 `result` 为 `LearningSuggestions` | params 非对象 | `BAD_REQUEST` / 400 / `params 必须是对象。` |
| 27 | `agent.turns` | `{sessionId:"<本人存在 id>"}` | 200 `result` 为 `TurnRow[]` | `{}`（缺 `sessionId`） | `BAD_REQUEST` / 400 / `sessionId 不能为空。` |
| 28 | `agent.ledger` | `{}` | 200 `result` 为 `{items,counts}` | params 非对象 | `BAD_REQUEST` / 400 / `params 必须是对象。` |
| 29 | `agent.retry` | `{sourceId:"<存在 id>"}` | 200 `result` 为 ledger | `{}`（缺 `sourceId`） | `BAD_REQUEST` / 400 / `sourceId 不能为空。` |
| 30 | `agent.sessions` | `{}` | 200 `result` 为 `ChatSessionSummary[]` | params 非对象 | `BAD_REQUEST` / 400 / `params 必须是对象。` |

### 3.1 边界参数补充

- `limit` 整数判定：传字符串、布尔、对象、数组均为类型错 → `limit 必须是整数。`；整数但小于下限或大于上限 → 对应范围消息（各方法上下限见冻结 §5）。
- `checkpoint` 非法值 → `checkpoint 必须是 pre 或 post。`（`profile.snapshot` 备用非法用例，不占 30 条主编号之外的新计数）。
- `memory.upsert` 的 `kind` 非法值按现状归一为 `goal`，不报 400；`value` 为 `null` → `value 不能为空。`。
- 种子库不存在的 ID：合法用例取 `.scratch/run/E/home-*/` 副本里的真实 ID；取不到时该用例 `skipped`，原因写进报告，不用编造 ID。
- 本节只约定方法入参边界；命令行参数、`--home`/`--report` 等运行配置与退出码见 §2.4，两处不重复定义默认值。

### 3.2 4 个 legacy 合法用例

| 编号 | method | 合法入参 | 合法期望 | 证据 |
|---|---|---|---|---|
| `E-061` | `getKp` | `{kpId:"<存在 id>"}` | 200 返回 `KnowledgePoint` | `apps/desktop/src/main/index.ts:225-226` |
| `E-062` | `getBlock` | `{blockId:"<存在 id>"}` | 200 返回 `{block,chapter?,section?}` | `apps/desktop/src/main/index.ts:227-235` |
| `E-063` | `getResource` | `{resourceId:"<存在 id>"}`（兼容 `sourceId`） | 200 返回 `{guide,chapter?}` | `apps/desktop/src/main/index.ts:236-248` |
| `E-064` | `listIdeology` | `{}` | 200 返回 `IdeologyPoint[]` | `apps/desktop/src/main/index.ts:249-250` |

legacy 不计入 30 方法覆盖统计；OpenAPI 里它们出现在 `x-legacy-methods` 而非 method 枚举（冻结 §6、§8）。

## 4 错误与消息逐字表

### 4.1 错误码总表（冻结 §4.2，E 逐条断言）

| code | HTTP | 中文消息（逐字） | E 覆盖用例 |
|---|---|---|---|
| `AUTH_REQUIRED` | 401 | `请先登录。` | 鉴权前置探测：受保护端点不带 token |
| `AUTH_INVALID` | 401 | `登录已失效，请重新登录。` | 失效/过期 token 探测 |
| `AUTH_FAILED` | 401 | `学号或口令不对，请检查后再试。` | 登录失败用例（不区分学号不存在与口令错） |
| `FORBIDDEN` | 403 | `这个资源不属于当前学号，换回自己的账号再试。` | `E-068` 越权 |
| `NOT_FOUND` | 404 | `没有找到这条记录，可能已被删除。` | `E-067` 资源不存在 |
| `UNKNOWN_METHOD` | 404 | `没有这个方法：<method>` | `E-069` 未知方法 |
| `BAD_REQUEST` | 400 | 见 §3 各方法消息 | `E-031` … `E-060`、`E-065`、`E-066`、`E-075` |
| `PAYLOAD_TOO_LARGE` | 413 | `这次提交的内容太大了（上限 1 MB），分几次发。` | 体超限探测（不占 80 条主计数，前置边界探针） |
| `RATE_LIMITED` | 429 | `请求太频繁，请等几秒再试。` | 登录限流探测（可选，限速窗口内跑） |
| `NOT_IMPLEMENTED` | 501 | `这个功能还没做，先别用。` | CAS/OAuth 预留端点形状探测 |
| `UPSTREAM_FAILED` | 502 | `上游服务没响应（新闻服务 / 模型），稍后重试。` | 侧车/模型离线时的 `news.refresh` 探测 |
| `CANCELLED` | 499 | `已停止这一轮（你点的停止）。这次没有保存结果，可以重新提问。` | `E-071` 取消后事件 |
| `TIMEOUT` | 504 | `这一步等太久了，已经停下，可以直接重试。` | 超时探测（stub 模拟慢速响应） |
| `INTERNAL` | 500 | `服务端出了点问题，已经记下来了，请稍后重试。` | 兜底形状探测；`detail` 不放堆栈/SQL/路径 |

### 4.2 字段级中文消息（§5 冻结清单）

| 触发 | 逐字消息 |
|---|---|
| 缺 `articleId` | `articleId 不能为空。` |
| 缺 `sessionId` | `sessionId 不能为空。` |
| 缺 `artifactId` | `artifactId 不能为空。` |
| 缺 `factId` | `factId 不能为空。` |
| 缺 `evidenceId` | `evidenceId 不能为空。` |
| 缺 `sourceId` | `sourceId 不能为空。` |
| 缺 `chapterId` | `chapterId 不能为空。` |
| `checkpoint` 非法 | `checkpoint 必须是 pre 或 post。` |
| `status` 非法 | `status 必须是 draft、reviewed 或 rejected。` |
| `limit` 类型错 | `limit 必须是整数。` |
| 交卷 `answers` 空数组 | `这一卷还没有作答，先答一题再交。` |
| 作答失败兜底 | `这次作答没有记成成绩，可以直接重试。` |

消息来源：冻结 §4.2 与 `apps/desktop/src/main/errors.ts:9-64`；测试只做逐字比对，不改写、不拼接后缀 [R7]。

### 4.3 非法五类专属用例

| 编号 | 类别 | 输入 | 期望 code / HTTP | 期望消息（逐字） |
|---|---|---|---|---|
| `E-065` | 缺字段 | `news.get` 传 `{}`，无 `articleId` | `BAD_REQUEST` / 400 | `articleId 不能为空。` |
| `E-066` | 类型错 | `kps.list` 传 `{limit:"80"}` | `BAD_REQUEST` / 400 | `limit 必须是整数。` |
| `E-067` | 404 归属 | `news.get` 传库中不存在的 `articleId` | `NOT_FOUND` / 404 | `没有找到这条记录，可能已被删除。` |
| `E-068` | 403 | 学生 B 的 token 读学生 A 的 `chat.messages` 会话 | `FORBIDDEN` / 403 | `这个资源不属于当前学号，换回自己的账号再试。` |
| `E-069` | 未知方法 | `method:"learning.__nonexistent__"` | `UNKNOWN_METHOD` / 404 | `没有这个方法：learning.__nonexistent__` |

`E-068` 的构造：先在学生 A 会话建一条会话记录，再用学生 B 登录取得 token 调 `chat.messages`；归属表依据 `packages/db/src/index.ts:276`（`chat_sessions.student_id`）。`memory.delete`、`artifacts.get`、`artifacts.export`、`profile.review` 的 403 形状与 `E-068` 同口径，不在 80 条外重复计数。

## 5 事件与通道序列契约

### 5.1 `POST /api/v1/chat/stream`（`E-070` 顺序、`E-071` 取消）

请求体：`{sessionId? , message, chapterId?, scopeOverride?, requestId?}`；`message` 必填，≤8000 字符。响应头：`Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache`、`X-Accel-Buffering: no`。

事件白名单（来自 `packages/agent/src/team.ts:17-35`）：`session`、`round`、`text`、`tool`、`tool-end`，加传输层终态/异常 `done`、`error`；心跳为注释行 `: keep-alive`。

**`E-070` 顺序断言**：

1. 第一帧 `event: session`，`data` 含 `requestId`,`sessionId`；`session` 必须在任何可能失败的事件之前。
2. 中间帧事件名 ∈ 白名单；`id` 从 1 递增不复用。
3. 终态帧 `event: done` 恰好一次，`data` 含 `requestId`,`turnId`,`sessionId`,`text`,`artifacts`,`citations`,`warnings`（`trace?` 可缺）；`done` 之后连接关闭，不再有事件。
4. 中文不转义；`text` 为增量，`done.text` 为全量。

**`E-071` 取消断言**：

1. 发起 stream 后记录 `requestId`；调 `POST /api/v1/chat/cancel` 传同一 `requestId`。
2. 流上最多再出现 1 个 `event: error`，`data.code === "CANCELLED"`；关闭后不再出现 `text` 帧。
3. 采集器用「事件数静默」判定停止产字（复用 `chat-events.ts:70-83` 的 `waitQuiet` 思路），不用固定等待 [R36]。

帧格式与心跳注释行遵循 SSE 规范 [R10][R11]；E 不实现 Last-Event-ID 重放，也不断言自动重连。

### 5.2 `POST /api/v1/chat/cancel`（`E-072`）

- 请求：`{requestId:"req_abc123"}` → 200 `{ok:true,result:{cancelled:true},requestId:"req_abc123"}`。
- `E-072`：传不存在或已结束的 `requestId` → 仍 200，`result.cancelled === false`，不是错误、不是 404。
- 取消必须把 `AbortSignal` 交到执行链；依据 `apps/desktop/src/main/index.ts:482-486` 的接线注释，只断 HTTP 连接不算取消成立。

### 5.3 `POST /api/v1/answer`（`E-073`）

请求：`{sessionId,questionId,answer,artifactId?,chapterId?}`；200 `result` 含 `turnId`,`text`,`feedback`,`evidence`,`ledger`,`warnings`,`status`。`E-073` 合法回读：提交后 `questions.attempts` 能查到该题作答记录。

### 5.4 `POST /api/v1/answer-set`（`E-074` 回读、`E-075` 空数组）

请求：`{sessionId,artifactId,answers:[{questionId,answer}],chapterId?}`；200 `result` 含 `turnId`,`text`,`results`,`ledger`,`warnings`,`status`。

- `E-074`：合法交卷后回读成绩与台账。
- `E-075`：`answers: []` → `400 BAD_REQUEST`，消息逐字 `这一卷还没有作答，先答一题再交。`。
- 题目不在该卷：`400` + `题目 <questionId> 不在这一卷里，先刷新题目集再交。`（文档化边界，不占独立编号）。

### 5.5 `GET /api/v1/health`（`E-076`）

- 不带 Authorization 返回 200；`result` 含 `ok`,`warnings[]`,`notices[]`,`chapters`,`knowledgePoints`,`newsArticles`,`appHome`,`version`,`uptimeMs`。
- `warnings`、`notices` 必须是数组；判定逻辑复用 `startupHealth`（`apps/desktop/src/main/health.ts:11-33`）。
- DB 打不开 → HTTP 503 + `ok:false`（环境探针，不占主编号）。

## 6 数据结构：report JSON 结构

`run.mjs` 汇总写入 `report/report.json`，逐条证据落 `report/<用例编号>/`。结构逐字段如下：

```json
{
  "schemaVersion": "1.0",
  "round": "E",
  "target": "http|electron|both|stub",
  "startedAt": "2026-11-19T02:00:00.000Z",
  "finishedAt": "2026-11-19T02:01:12.000Z",
  "environment": {
    "baseUrl": "http://127.0.0.1:0",
    "port": 0,
    "home": ".scratch/run/E/home-7c1e/",
    "openapi": "present|missing",
    "lockedElectron": false
  },
  "summary": { "total": 80, "passed": 0, "failed": 0, "skipped": 0, "pending": 0 },
  "cases": [
    {
      "id": "E-004",
      "kind": "method-illegal",
      "method": "news.list",
      "channel": "/api/v1/rpc",
      "target": "http",
      "status": "passed|failed|skipped|pending",
      "assertions": [
        { "name": "httpStatus", "expected": 400, "actual": 400, "ok": true },
        { "name": "errorCode", "expected": "BAD_REQUEST", "actual": "BAD_REQUEST", "ok": true },
        { "name": "messageExact", "expected": "limit 必须是 1 到 200 的整数。", "actual": "limit 必须是 1 到 200 的整数。", "ok": true },
        { "name": "field", "expected": "limit", "actual": "limit", "ok": true }
      ],
      "expected": { "code": "BAD_REQUEST", "http": 400, "message": "limit 必须是 1 到 200 的整数。" },
      "actual": { "code": "BAD_REQUEST", "http": 400, "message": "limit 必须是 1 到 200 的整数。" },
      "evidence": "report/E-004/meta.json",
      "durationMs": 3,
      "error": null
    }
  ],
  "mutations": [
    { "id": "M1", "patch": "mutations/m1-drop-done.patch", "applied": false, "reverted": true, "targetCase": "E-070" }
  ]
}
```

字段约定：

- `status`：`passed` 全部断言成立；`failed` 至少一条断言不成立；`skipped` 前置不可用（实例不可达、锁未取得、种子 ID 取不到）；`pending` 仅用于 OpenAPI 缺失时的覆盖核对。
- `assertions[]`：每条断言一个对象，`name` 取 `httpStatus` / `errorCode` / `messageExact` / `field` / `resultFields` / `eventOrder` / `collectionEqual`；`expected` 与 `actual` 并列保留，失败时不覆盖实际值。
- `evidence`：单条用例的 meta、请求/响应摘录、事件序列快照、DB 探针路径；失败时附采集到的原文，证据思路沿用现有 evidence 落盘 [R34]。
- `error`：用例执行异常（非断言失败）的分类与消息；堆栈不进报告正文。

## 7 coverage 输出结构与判定

`coverage.mjs` 输出 `report/coverage.json`：

```json
{
  "openapi": "present|missing",
  "file": "docs/contracts/openapi.yaml",
  "status": "green|pending|red",
  "checks": [
    { "id": "E-077", "name": "method-enum", "expected": 30, "actual": 30, "ok": true, "missing": [], "extra": [] },
    { "id": "E-078", "name": "channel-paths", "expected": 5, "actual": 5, "ok": true, "missing": [] },
    { "id": "E-079", "name": "legacy-methods", "expected": 4, "actual": 4, "ok": true, "missing": [] },
    { "id": "E-080", "name": "result-schemas", "expected": 30, "actual": 30, "ok": true, "missing": [] }
  ]
}
```

四项核对口径：

| 编号 | 核对对象 | 通过判据 |
|---|---|---|
| `E-077` | `paths./api/v1/rpc` 请求体 `method` 枚举 | 集合恰好等于冻结 §5 的 30 个名字；`missing` 为缺项，`extra` 为多出来的项 |
| `E-078` | §7 的 5 个通道 path | `/api/v1/chat/stream`、`/api/v1/chat/cancel`、`/api/v1/answer`、`/api/v1/answer-set`、`/api/v1/health` 各有独立 path 条目 |
| `E-079` | `x-legacy-methods` 扩展 | 恰好 `getKp`、`getBlock`、`getResource`、`listIdeology` 4 个；不出现在 method 枚举里 |
| `E-080` | `components.schemas` | 30 方法返回结构均有 `<Method>Result`（点转驼峰，如 `news.list` → `NewsListResult`）；`missing` 列出未覆盖方法 |

判定与退出：

- 文件存在且四项全 `ok` → `green`。
- 文件缺失 → `openapi: "missing"`、`status: "pending"`，只按冻结表列应有项，退出码 0（冻结 §8）。
- 文件存在但有失败项 → `red`，`missing`/`extra` 写入报告交 A 修；E 不改 yaml；该情况汇总退出码 1（见 §2.4）。

解析用 PyYAML 风格的本地解析，不引第三方云校验服务 [R37]；OpenAPI 3.0.3 结构参照规范 [R2]，集合相等判定参照 [R41] 的枚举/ schema 校验思路。

## 8 兼容与版本

- **旧客户端宽容调用**：HTTP 服务端按冻结 §4.3 严格校验；E 的 http target 断言严格口径。electron target 跑现状宽容行为时，差异进报告分栏，不放宽 http 期望值。
- **字段增删**：合法用例只断言必含字段，响应多出的未知字段不判失败；必含字段缺失或改名 → 对应用例变红。
- **legacy 策略**：4 个方法标 `deprecated: true`、`tags: [legacy]`，保留只读；新增调用方不应再依赖它们，但桌面端引用溯源在切换期仍需可用（冻结 §6）。
- **错误码冻结**：不新增同义错误码；同一失败语义全链路一个 code，不在新闻与产物两处拆码 [R7]。
- **版本候选**：`artifacts.export` 的文件下载端点属 v2 候选，本轮不实现、不断言；报告里出现相关路径只作日志记录。
- **OpenAPI 版本**：核对按 3.0.3，不接受 3.1 方言特性；E 不修改文件，只报版本不符。

## 9 测试运行、退出码与运行契约

退出码权威口径见 §2.4 表；本节只列运行前置与命令，不另立一套码表。

| 退出码 | 含义 | 触发条件（摘要，详见 §2.4） |
|---|---|---|
| 0 | 通过 / 按设计跳过 | 全绿；或 `both`/默认下 http 组与 electron 组按前置跳过、OpenAPI 缺失 `pending`，其余 `passed` |
| 1 | 断言失败 | 至少一条用例 `failed`，含 coverage `red`、SSE 超时、鉴权失败；mutation 回放期预期变红记 1，revert 后复跑恢复 |
| 2 | 显式 http 不可达 | 仅 `--target http` 且服务端连不上；`both`/默认下走 `skipped` 不记 2 |
| 3 | CLI 参数非法 | 参数校验不过；明细见 §2.4 各参数「校验失败行为」列 |

运行命令（在 `tools/contract-tests/` 下）：

```powershell
# 内置桩自洽跑（不联网、不起进程）
node run.mjs --target stub

# 打本地服务端（端口随机；--base-url 可覆盖）
node run.mjs --target http

# 复用现有 Playwright 封装打 Electron
node run.mjs --target electron

# 双跑对照
node run.mjs --target both

# OpenAPI 覆盖核对
node coverage.mjs
```

- http target 前置：探测 `/health`；显式 `--target http` 不可达 → 退出码 2；`--target both` 或默认目标下 http 组整组 `skipped`，退出码 0（口径见 §2.4）。
- electron target 前置：取得 `.scratch/run/electron.lock`；拿不到则整 target 跳过，报告写明。
- 临时 home：`.scratch/run/E/home-<短id>/`，不写真实数据目录；种子库从现有 seed 副本复制 [R40]。
- 请求体上限 1 MiB、`message` 8000 字符、各 RPC 超时口径沿用冻结 §2；E 不在测试里调大这些上限。

## 10 mutation 映射表

3 条临时 mutation 的「改哪里 → 哪条用例应变红」对照；patch 存 `tools/contract-tests/mutations/`，脚本化 apply/revert，结束复查 `git status --porcelain apps/server docs/contracts` 为空（例外申请见 `01-scope.md` §7）。mutation「植入故障 → 用例必须红 → 还原恢复绿」的状态口径参照 Stryker 的 killed/survived 术语 [R52]，本轮手动维护 patch，不引入全量 mutant 运行时。

| 编号 | patch | 改哪里 | 临时改动 | 应变红用例 | 变红的断言点 | revert 后 |
|---|---|---|---|---|---|---|
| M1 | `mutations/m1-drop-done.patch` | `apps/server/src/chat/stream.ts`（发 `done` 帧位置） | 移除 `done` 帧发送，流结束不发终态 | `E-070` | 终态帧必须为 `done` 且恰好一次；缺 `done` 时 `eventOrder` 断言失败 | 复跑 `E-070` 恢复 `passed` |
| M2 | `mutations/m2-loosen-limit.patch` | `apps/server/src/rpc/validate.ts` 或 `limit` 校验 handler | 去掉整数/上限校验，越界值放行 | `E-034`（`news.list` limit 越界） | 期望 `400 BAD_REQUEST` + `limit 必须是 1 到 200 的整数。`；实际 200 时 `httpStatus` 与 `errorCode` 断言失败 | 复跑 `E-034` 恢复 `passed` |
| M3 | `mutations/m3-enum-29.patch` | `docs/contracts/openapi.yaml`（`method` 枚举） | 枚举删除 1 项，30 → 29 | `E-077` | `method-enum` 集合相等：`missing` 列出被删方法，`ok=false` | 复跑 `E-077` 恢复 `ok=true` |

回放流程：`apply-revert.ps1` 先确认工作区干净 → apply patch → 跑目标用例确认变红（记录失败断言）→ revert patch → 复查 `git status --porcelain apps/server docs/contracts` 为空 → 复跑目标用例确认恢复绿色。任一步失败：不强行继续，报告标该 mutation 未完成，patch 必须已 revert。

## 参考

- [R3] JSON-RPC 2.0 规范 — https://www.jsonrpc.org/specification — 支撑 §1 信封与 §2 编号分段 — 借鉴 `method`/`params`/`error` 结构；不引入 batch。
- [R2] OpenAPI 3.0.3 规范 — https://spec.openapis.org/oas/v3.0.3 — 支撑 §7 覆盖核对的 `paths`/`components.schemas` 组织 — 采用 3.0.3；不用 3.1 方言。
- [R7] OWASP REST Security Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html — 支撑 §4 消息最小披露与 §8 错误码冻结 — 采用归属校验与不泄漏内部结构。
- [R10] Server-Sent Events（WHATWG 规范） — https://html.spec.whatwg.org/multipage/server-sent-events.html — 支撑 §5.1 帧格式与 `session`/`done` 顺序 — 采用规范帧；不做重连重放。
- [R11] MDN · Using server-sent events — https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events — 支撑 §5.1 心跳注释行与缓冲坑 — 采用 `: keep-alive` 与 `X-Accel-Buffering`。
- [R34] Playwright — https://playwright.dev/docs/intro — 支撑 §6 证据落盘与 fixture 思路 — 采用失败取证；不用快照测试。
- [R36] JavaScript Testing Best Practices — https://github.com/goldbergyoni/javascript-testing-best-practices — 支撑 §2.1 用例组织与 §5.1 轮询断言 — 禁固定等待；不引入其工具链。
- [R37] Redocly CLI 文档 — https://redocly.com/docs/cli — 支撑 §7「先解析契约再比对覆盖」 — 借鉴校验顺序；不引云服务。
- [R38] Pact JS — https://github.com/pact-foundation/pact-js — 支撑 §1 契约一致性与 §10 mutation 对照 — 用例对照真实 provider；不引入 Pact 运行时。
- [R40] factory_boy — https://github.com/FactoryBoy/factory_boy — 支撑 §9 测试样例数据外置 — 集中生成 fixture；不引入 Python 栈。
- [R41] kin-openapi — https://github.com/getkin/kin-openapi — 支撑 §7 枚举与 schema 集合相等判定 — 借鉴解析与比对思路；不引入 Go 依赖。
- [R4] fastapi — https://github.com/fastapi/fastapi — 支撑 §3 逐方法参数表的声明式组织 — 借鉴「参数 → 校验规则 → 消息」逐条列出；不引入 Python 栈。
- [R52] Stryker JS — https://github.com/stryker-mutator/stryker-js — 支撑 §10 mutation 红/绿状态口径 — 借鉴 killed/survived 术语；不引入全量 mutant 扫描运行时。
