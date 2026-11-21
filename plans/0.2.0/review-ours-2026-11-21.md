# 我们这几天的工作 · 独立复核（2026-11-21）

> 复核对象：`packages/dispatch`（+ `scripts/verify-dispatch.ts`）、`docs/contracts/ipc-methods.md`、
> `docs/contracts/database-plan.md`、`packages/news/src/fallback.ts` 与 `searchAndIngestFallback`
> （+ `scripts/verify-news-fallback.ts`）、`review-yang-2026-11-19.md`、`给杨泽易的分工建议.md`、
> `ROADMAP.md`、`decisions.md` 的 D-8、`review-kit.md` 新增的「三种假证据」一节。
>
> **不在范围**：`apps/server`、`services/`、`tools/` 的实现质量（协作者交付）。
> 出现它们的地方，只为核对**我们文档里关于它们的陈述**真假。
>
> 复核基线：开始时 `HEAD = 08330ac`，结束时 `HEAD = e74cf6e`（12:29:06 的合并提交）。
> 以下结论一律以 **e74cf6e** 为准；工作树全程只有 `M pnpm-lock.yaml`（复核开始前就存在，非本次改动）。
> 复核方式：只读 + 2 次「改错看变红」（已逐一还原，`git diff` 对被改文件为空）。

---

## 〇、总判断

**需改后再合。**

dispatch 的抽取本身是干净的（37/37 方法名与契约表逐一对上、顺序一致、`args.studentId` 零处读取、
`studentId` 只来自 `ctx`，这两条都有能变红的断言守着）。问题不在重构，在**重构之后文档没跟着改**，
以及**两个功能只修了一半**：契约里三处描述已被这次重构变成假话；「不迁 PG」的裁决与三份文档、
乃至同一份文档内部互相打架；新闻兜底补上了「查」没补「刷新」；共享分发层里 4 个方法
把越权面从 `studentId` 挪到了 `sessionId/artifactId/factId`，并且注释宣称那里已经校验过（实测可越权读）。

---

## 一、分级清单

### P0（阻断合并）

无。

> 说明：Q1 的越权问题实测可复现（见 Q1），但今天服务端在 `apps/server/src/rpc/handlers/chat.ts:21`
> 用 `requireSession` 挡住了，桌面端又是单用户，所以**当前不是活的数据泄露**，按 P1 记。
> 它离 P0 只差一步：下一个实现者若按 `packages/dispatch/src/index.ts:188` 的注释相信「已经校验过」，
> 就是全班可读别人的对话。

### P1（发布前必修）

| 级别 | 位置 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| P1 | `docs/contracts/ipc-methods.md:163` | 「现有 37 个方法里**全部读** `args.studentId`」已被本次重构变成假话 | `grep -n "args.studentId" packages/dispatch/src/index.ts` → 只有 `:11` 一行注释、`:50` 是 `ctx.studentId`，**0 处实读**；唯一还在读的是桌面适配器 `apps/desktop/src/main/index.ts:225` | 改成「桌面适配器读 `args.studentId` 用于切学生；dispatch 内 0 处读取，服务端只需在 HTTP 层从会话注入 `ctx.studentId`」 |
| P1 | `docs/contracts/ipc-methods.md:206` / `packages/dispatch/src/index.ts:4` | 契约承诺的入口 `createDispatch(deps)` **不存在**，实际导出是 `dispatchMethod(deps, method, input, ctx)`；「250 行 switch」也不成立 | `packages/dispatch/src/index.ts` 只有两个导出：`dispatchMethod`（`:42-47`）与 `exportFormat`（`:231`）；`grep -c createDispatch` → 0。旧 switch：`git show 08330ac^:apps/desktop/src/main/index.ts` 第 203–393 行（191 行函数，switch 本体 208–391 约 184 行） | 契约改成实际签名；「250 行」改「约 190 行」 |
| P1 | `packages/dispatch/src/index.ts:187-188` | `chat.messages` 直通 `db.listChatMessages(sessionId)`，**无归属校验**；注释却写「归属校验在 AgentService/DB 层」——两层都没有 | `packages/db/src/index.ts:1338-1343`：SQL 只有 `WHERE session_id=?`，签名里没有 `studentId`；`packages/agent/src/index.ts:390-391` 同理；实测见 Q1。契约自己在 `:99` 写着「**必须校验归属**」，与本注释相反 | 删掉这句注释，改「本层不做归属校验：服务端必须在 HTTP 层 `requireSession`」；并给 `verify-dispatch.ts` 补一条 `chat.messages` 越权断言（同 `:64-76` 的写法） |
| P1 | `packages/news/src/index.ts:275-298` | 新闻兜底只补了「搜」没补「刷」。`refresh()` 直连 `POST /run`，**没有** `isBackendUnavailable` 分支 | 同一次提交（`35f71d7`）的理由是「桌面交付包不带 Python」，对 refresh 一字不适用性差别；`packages/news/src/index.ts:341` 有 fallback，`:280-291` 没有。调用点是活的：`apps/desktop/src/renderer/src/workspace.tsx:531` 无条件渲染「刷新」按钮 → `App.tsx:1045` → 必抛 | 要么 `refresh()` 也走 `isBackendUnavailable` 降级（返回「本机无采集服务，已跳过」而非报错），要么桌面端在无 host 时隐藏该按钮。**必须在 `verify-news-fallback.ts` 里加一条能变红的接线断言** |
| P1 | `docs/requirements/R07-news.md:8` 与 `:102` | `verify-doc-refs.py` **退出码 1**：两处把已删除的 `pipeline/ingest-news.ts` 写成可解析路径 | 实跑见第三节。根因不是我这次改的：`165a7b9` 修好过（该提交版本 `grep -c` = 0），被 `e74cf6e` 的合并覆盖回旧文本（HEAD 与 `8561e6b` 完全一致，均为 2 处） | 重做 `165a7b9` 的改法：`pipeline/ingest-news.ts` → 「旧的 TS 入库脚本（`ingest-news`）」。**并复查该合并是否还覆盖了别的修复** |
| P1 | `plans/0.2.0/给杨泽易的分工建议.md:230`（另见 `:55`、`:206`、`ROADMAP.md:217`） | 同一份文档一边说「不迁 PG」（`:111` `:113`），一边在**要发出去的那段话**里写「下周：PG 迁移」。对方已据此做出 `tools/migrate-pg` | 原文引用：`:230`「> 下周：PG 迁移 + 契约测试 + 压测可观测性」；`:55`「PG 迁移在任务 D」，而任务 D 的标题就是「**不迁 PG**」；`ROADMAP.md:217` 把「PG 迁移」列进他的范围。`tools/migrate-pg/` 已存在且无「当前不启用」标记（`grep -rn "不启用" tools/migrate-pg` → 0） | 四处统一改成「PG 迁移留 M2，本轮只做单写者 + 回传」；`tools/migrate-pg/README.md` 首行加「当前不启用（M2 选项）」。这正是 `review-yang-round2-2026-11-21.md:143` 自己开的动作，未完成 |
| P1 | `plans/0.2.0/decisions.md:144` | D-8（状态「生效」）写「M1 引入…集中数据库（**SQLite 单写 → PostgreSQL**）」，与 `database-plan.md:4`「结论：**不换**」直接冲突，**且没有后续裁决覆盖** | `grep -n "PostgreSQL\|PG" plans/0.2.0/decisions.md` → 全文只有 `:144` 这一处；无 D-9 | 补一条 D-9：把 D-8 的「SQLite 单写 → PostgreSQL」改为「M1 只做 SQLite 单写；PG 触发条件见 `database-plan.md` §4.1，留 M2」。否则按 `review-kit.md` §二的权威顺序，`database-plan.md` 的结论是**低于 D-8 且与之相反**的 |

### P2（记录，不阻断）

| 级别 | 位置 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| P2 | `docs/contracts/database-plan.md:18` | 「依赖 DAL 的文件 **21 个**」复算不出 | 规则「`.ts` 里出现 `@learning-agent/db`，排除 `.d.ts`/`package.json`」：文档所在提交 `08330ac` 上 **26** 个，现在 **28** 个；若只算真 import 了 `LearningDb` 类型（剔除 `import type {}` 空导入）则 `08330ac` **14** 个、现在 **18** 个。两个口径都不是 21 | 写清统计口径并给出复算命令；或直接改成复算得出的数。**不影响「不迁 PG」的结论**（真数更大，只会让迁移更贵） |
| P2 | `docs/contracts/database-plan.md:63` 与 `:88` | 让 Python 侧「把 `db.upsertNews(...)` 换成 `httpx.post(...)`」「检查不再有 `upsertNews`」——**Python 侧从来没有 `upsertNews`** | `grep -rn "upsertNews" services/news-crawler-py/src` → 0 处；实际是 `output.py:107` `INSERT INTO news_articles`、`db.py:113` `INSERT INTO source_runs`、`db.py:69` `sqlite3.connect` | 点名真实符号：`output.py` 的 `INSERT INTO news_articles` 与 `db.py` 的 `INSERT INTO source_runs` |
| P2 | `packages/news/src/fallback.ts:117` | 兜底写入的 `source` 是**站点中文名**（`item.siteName`），采集行是**注册源 id**（`normalize.py` `source=descriptor.id`）。同一列两种语义 | `fallback.ts:117` `source: item.siteName.trim() \|\| 'web'` vs `services/news-crawler-py/src/news_crawler/normalize.py:77` `source=descriptor.id`；`news_articles.source` 是自由 `TEXT`（`packages/db/src/index.ts:141`），无约束兜住 | 兜底行写 `source: 'web-search'`（固定值），站点名放 `author`/`summary`；或明确在 R07 写「`source` 允许 `web-*` 前缀」 |
| P2 | `packages/news/src/index.ts:539` | `web_search` 的工具描述仍对模型宣称「检索 **Python 新闻采集后端**…**3 秒预算**」；桌面包实际是 DeepSeek 搜索，预算 15 秒 | `fallback.ts:31` `FALLBACK_TIMEOUT_MS = 15_000`；`fallback.ts:8-10` 注释已说明包内没有 Python。模型会按 3 秒做规划 | 描述改成「先查本地库；本地不可用时联网检索（≤15 秒）」，不带实现名 |
| P2 | `scripts/verify-dispatch.ts:111-131` | 「契约表里的方法全部已实现」只证明 **case 分支存在**，不证明参数/返回形状。且方向单一（契约→代码），代码多出来的 case 不会被发现 | 该段对所有方法传 `{}` 并靠「报错不包含 `unknown learning method`」判过；`profile: {}` 等桩会让方法抛 `TypeError`，同样算「通过」 | 加一条反向断言（`cases ⊆ 契约表`）；参数/返回形状留给契约测试（任务 E），但脚本注释要写清「只验名字」 |
| P2 | `docs/contracts/ipc-methods.md:30-33` | 「所有面向学生的错误必须是中文 + 可执行（`friendlyError` 是**唯一来源**）」——实际 37 个方法全都不经过它 | `apps/desktop/src/main/index.ts:298` `ipcMain.handle('learning:invoke', ... invoke(method, input))`，无 `friendlyError` 包装；只有 `:342`（chat）与 `:379`（answer）包了。**重构前就是这样**（旧文件 `08330ac^` 只在 489/526 两处用），不是本次退步 | 要么在 `invoke()` 里统一包一层 `friendlyError`，要么把契约改成「独立通道已包，`invoke` 路径未包」 |
| P2 | `plans/0.2.0/ROADMAP.md:136` / `:33` `:111` | 三个数字与事实不符：「19+8 条断言」实为 **33**（23 纯 + 10 接线）；「**0 行服务端代码**」实为 38 个 `.ts` / 4003 行 | `grep -c "^ *check(" scripts/verify-news-fallback.ts` → 33；`35f71d7` 时是 24 条（第 6–8 节 **0** 条），任何版本都不是 27。`find apps/server/src -name "*.ts" \| wc -l` → 38，`cat ... \| wc -l` → 4003 | 数字改成 33（23+10）；「0 行服务端代码」加时间限定或改成「骨架已进仓库，见 `apps/server`」 |

---

## 二、Q1–Q5

### Q1 `dispatchMethod` 的 `studentId` 只认 `ctx`——这个边界有没有绕过路径？

**结论：`studentId` 这条边界本身没有绕过路径；但真正的越权面被挪到了「别的 id」上，现在有 4 个方法可以横着读，而且注释谎称已经校验过。**

证据一：`studentId` 来源单一。
- `packages/dispatch/src/index.ts:50` `const studentId = ctx.studentId`，全文件 0 处 `args.studentId`（`grep` 只命中 `:11` 注释）。
- 唯一读入参 `studentId` 的是桌面适配器 `apps/desktop/src/main/index.ts:225-228`，它是在**构造 ctx**，不是覆盖 dispatch 的判定——符合 `:219-221` 的注释。
- 有新写法的验证脚本 19 条断言全绿，且我改坏实现后能变红（见第四节实验 B）。

证据二：越权面在 `sessionId / artifactId / factId / evidenceId` 上。

| 方法 | 位置 | 校验情况 |
|---|---|---|
| `chat.messages` | `packages/dispatch/src/index.ts:187-188` | ❌ `db.listChatMessages(sessionId)`，SQL 仅 `WHERE session_id=?`（`packages/db/src/index.ts:1338-1343`） |
| `agent.turns` | `packages/dispatch/src/index.ts:198-199` | ❌ `db.listTurns(sessionId, limit)`，SQL 仅 `WHERE session_id=?`（`packages/db/src/index.ts:1413-1418`） |
| `artifacts.get` | `packages/dispatch/src/index.ts:162-163` | ❌ `artifacts.get(id)`，签名无 `studentId`（`packages/artifacts/src/index.ts:164`） |
| `memory.delete` | `packages/dispatch/src/index.ts:182-184` | ❌ `profile.deleteMemoryFact(factId)` → `db.deleteMemoryFact(id)`（`packages/db/src/index.ts:1579`） |

**实测复现（在仓库内建临时脚本跑完即删，`git status` 已确认干净）**：造 A、B 两个学生，B 建一个会话并写一条「乙写的私密内容」，然后以 `ctx={studentId:'student_a'}` 调 `dispatchMethod(deps,'chat.messages',{sessionId: B的会话}, ctx)`：

```
ctx=A，args.sessionId=乙的会话；chat.messages 返回 1 条
内容： ["乙写的私密内容"]
越权读到别人的消息： true
```

为什么不是 P0：服务端今天在 `apps/server/src/rpc/handlers/chat.ts:21-22` 先调 `requireSession` 再读，
桌面端是单用户，所以暂时读不到别人的数据。但 `packages/dispatch` 是「产品行为的唯一来源」，
`:188` 那句注释会让下一个实现者跳过 HTTP 层校验——那一步就是 P0。

补充：本仓库**从来没有** `assertSessionOwner` / `assertQuestionSetOwner`（`grep -rn` 全仓 0 处），
而 `docs/contracts/ipc-methods.md:36` 写着「现有 `assertSessionOwner` / `assertQuestionSetOwner` 必须保留」。
协作者因此自己写了 `apps/server/src/ownership.ts`（依据是契约表 `:99` 的「必须校验归属」）。
契约那句要改成「本项目没有这两个函数，服务端需自建归属校验（参考 `apps/server/src/ownership.ts`）」。

### Q2 契约清单 vs `packages/dispatch` 实际 case vs `apps/desktop/src/main/index.ts`

**结论：方法**集合**完全一致（37 = 37，顺序也一致，无重名、无缺漏）；8 个独立通道也一致。但契约的**散文部分**有三处已被这次重构变成假话。**

- 方法名比对（脚本比对，`^| n | \`method\` |` vs `case '...'`）：
  `contract: 37 dispatch: 37`；`在契约但代码没有: []`；`在代码但契约漏了: []`；`顺序完全一致: True`。
- 通道比对：契约 §三列 8 个（`:57-66`），`apps/desktop/src/main/index.ts` 注册 8 个
  （`:298` invoke、`:301` cancel、`:306` chat、`:347` answer、`:362` answer-set、`:382` health、
  `:390` settings:get、`:391` settings:set）——**一一对上**。
- 逐行抽查入参/返回也对得上：`getResource` 的 `resourceId | sourceId` 双别名（`dispatch:83-85`）、
  `memory.upsert` 六种 `kind`（`dispatch:172-181`）、`profile.snapshot` 的 `pre|post`（`dispatch:147-151`）、
  `profile.review` 的 `draft|reviewed|rejected`（`dispatch:153-158`）、`artifacts.export` 的格式归一
  （`dispatch:229-232` `exportFormat`）。

假话三处（都记在 P1/P2 里）：
1. `:5` 「基线：`apps/desktop/src/main/index.ts`（**`invoke` switch** + **7 个**独立通道）」——
   `grep -c "case '"` 在该文件 = **0**；独立通道是 **8** 个（契约自己 §三 也说 8）。
2. `:163` 「37 个方法里全部读 `args.studentId`」——见 Q1，0 处。
3. `:206` 「抽成 `createDispatch(deps)`」——不存在，实际 `dispatchMethod(deps, method, input, ctx)`。

### Q3 `database-plan.md` 的四个数字，以及「不迁 PG」站不站得住

**结论：三个数字精确可复算，一个（21 个文件）复算不出。「不迁 PG」在 40–60 人规模下站得住，但站得住的理由不是文里那个 0.22 次/秒，而是「所有写都在同一个 Node 进程的同一个同步连接上」；而这条理由目前**还没落实**——Python 仍在直写同一个库。**

逐条复算（`packages/db/src/index.ts`，3746 行）：

| 文档说法 | 复算结果 | 判定 |
|---|---|---|
| `:16` 「同步调用点 280 处（`.prepare / .exec / .transaction`）」 | `grep -o` 计数：`.prepare(` 211 + `.exec(` 44 + `.transaction(` 25 = **280** | ✅ 精确对上 |
| `:17` 「`async` 方法 0 个」 | `grep -c "async "` = **0** | ✅ |
| `:18` 「依赖 DAL 的文件 21 个」 | 见 P2：口径不同得 26 / 28 或 14 / 18，**都复算不出 21** | ❌ |
| `:29` 「6400 次写/天 ÷ 8 小时 ≈ 0.22 次/秒」 | 40×20×8 = 6400；6400÷8h÷3600 = **0.2222** | ✅ 算术正确 |
| `:16` 行号 `packages/db/src/index.ts:2,816,831` | `:2` `import { DatabaseSync } from 'node:sqlite'`、`:816` `private readonly db: DatabaseSync`、`:831` `this.db = new DatabaseSync(...)` | ✅ 三处都成立 |

**反方论据（三条，都有出处）：**

1. **同步 API + 单进程 = 队头阻塞，不是「写入量小」能救的。** `:73` 把「`node:sqlite` 是同步的，单进程内天然串行」当作**优点**写下来；同一个事实的另一面是：一次 `matcher.backfill(20)`（`packages/dispatch/src/index.ts:106-107`，`news.refresh` 里就在调）期间，全进程所有请求都排队。40 人同时在线的指标是 P99 延迟，不是日均 0.22 次/秒。文档通篇没有「事件循环」四个字。
2. **0.22 次/秒是日均，峰值才是撞锁的时刻。** 一节课同时开始，40 人各 8 次写在 30 秒内 → 约 10 次/秒，SQLite 仍扛得住，所以结论不变；但用日均为结论背书的方法本身站不住，`:88` 的验收判据（40 并发 × 10 轮）才是真证据，而那条**还没跑过**。
3. **「单写者」今天不成立，这正是「不迁 PG」的地基。** `:48` 写「采集服务（Python）**不直接写库**」，`:199` 要求删掉 Python 直写；实测 `services/news-crawler-py/src/news_crawler/output.py:107` 仍在 `INSERT INTO news_articles`，`db.py:113` 仍在 `INSERT INTO source_runs`，`db.py:69` `sqlite3.connect`，且 `grep -rn "internal/news/ingest" apps/server services` → **0 处**，回传接口还没实现。也就是说：文档描述的架构是**目标态**，而「不迁 PG」的前提是它**已经是现状**——现在两个进程确实在抢同一个文件。

**给结论定级**：40–60 人、单校、写入 0.22 次/秒均量，SQLite WAL 绰绰有余，**不迁 PG 是对的**；
真正的风险是 `node:sqlite` 同步阻塞带来的延迟，以及「单写者」尚未落地这两件事，
应该写进 `database-plan.md` 的风险节，而不是靠一版日均估算把问题关掉。

### Q4 `fallback.ts` 有没有绕过「不按学生原话判断意图」的原则？两条路径的差异会导致什么？

**结论：没有违反原则——`isBackendUnavailable()` 判断的是**传输层错误**（ECONNREFUSED / timed out…），不读学生说的话，所以不是「按关键词/正则判断学生意图」。但两条路径有 3 处实质差异，其中 1 处会写脏数据。**

证据（原则）：`docs/principles/single-agent.md:36` 禁的是「按关键词/正则判断**学生意图**、为某个品牌或某条新闻写分支」。
`fallback.ts:42-48` 的正则作用在 `error.message` 与 `cause` 上；`:44` 的注释也写明「只有连不上/超时才值得退回 API」。
分支的依据是**服务在不在**，不是**学生想干什么**。判据层面合规。

差异清单（全部有出处）：

| 维度 | Python 路径 | 兜底路径 | 后果 |
|---|---|---|---|
| `source` 列 | 注册源 id（`normalize.py:77` `source=descriptor.id`） | 站点中文名（`fallback.ts:117`） | `news_articles.source` 同一列两种语义；`news.list({source})` 按源过滤永远命中不到兜底行；R07 的源统计看不到这批数据 |
| 时间预算 | `queryTimeoutMs`（3 秒门面，与 `web_search` 描述 `index.ts:539` 一致） | 15 秒（`fallback.ts:31`） | 模型按 3 秒做规划，实际最长 15 秒；在「停止」类需求（R21）里 5 倍差距 |
| `errors[]` 语义 | 只有降级时一条 `meta.reason`（`index.ts:345`） | 每条正文不足 300 字的命中各一条（`fallback.ts:147`） | 模型可能在回答里对「正文太短」做无意义播报 |
| `content_status` 门槛 | 1000 字（`normalize.py:81`） | 1000 字（`fallback.ts:121`） | ✅ 一致，无差异 |

另外两点不是差异，但值得记：
- `crawl:false`（只要本地、不联网）在兜底路径里被**静默忽略**（`index.ts:322` 计算 `fresh`，`:358-374` 从不看 `options.crawl`）。**目前不可达**——唯一调用点 `index.ts:555` 不传 `crawl`，所以不按缺陷记，只记为潜在坑。
- `FALLBACK_MIN_CONTENT = 300`（`fallback.ts:29`）与 R07 的口径不完全一致：R07 `:76`/`:83` 说「正文和摘要都不足 **20** 字才拒绝入库，短稿可以 `partial` 入库」，R07 `:113` 又说「正文 **≥300** 字才入库」。代码按 300 走（更严），于是同一个查询在桌面包里入库条数**少于**服务端。这需要 R07 自己先把口径统一。

### Q5 五份文档之间有没有矛盾、或与代码事实矛盾？

**结论：M1/M2/M3 的表述是一致的；「兜底是否已修」基本一致但数字不对；「PG 迁移」前后矛盾，而且矛盾已经造成了实际返工（对方建了 `tools/migrate-pg`）。**

**（1）M1/M2/M3 —— 一致 ✅**
`decisions.md:143`「P0 单机原型（已完成…）→ M1 校内网页版 → M2 一个班真跑 → M3 小程序」；
`ROADMAP.md:101-103` 与 `:111-113` 三阶段名称、判据完全同口径；`给杨泽易的分工建议.md:50` 把桌面端定位成「演示 + 离线兜底」，与 D-8 `:146` 一致。
唯一与之冲突的是 `ROADMAP.md:33`/`:111` 的「0 行服务端代码」（见 P2）。

**（2）PG 迁移 —— 矛盾，且已产生成本 ❌**

| 文档 | 说什么 |
|---|---|
| `decisions.md:144`（D-8，生效） | M1 引入「集中数据库（SQLite 单写 → **PostgreSQL**）」 |
| `database-plan.md:4` | 「**不换**…迁 PG 留作 M2」 |
| `ROADMAP.md:131` | 「**不迁 PG**——应用独占写 `learning.db`」 |
| `ROADMAP.md:217` | 他的范围里写「**PG 迁移**」 |
| `分工建议.md:111` `:113` | 「采集服务改为回传写库（**不迁 PG**）」 |
| `分工建议.md:55` | 「PG 迁移在**任务 D**」（任务 D 就是「不迁 PG」） |
| `分工建议.md:206` | 「我们**马上要上 PG**，你会更需要」 |
| `分工建议.md:230`（要发出去的那段话） | 「下周：**PG 迁移** + 契约测试」 |

后果不是理论：`tools/migrate-pg/` 已经建出来（`ls tools/migrate-pg` → `README.md package.json src`），且没有任何「当前不启用」标记。
按 `review-kit.md` §二的权威顺序，`decisions.md` 高于契约文档，所以**现在生效的裁决其实是「迁 PG」**，
`database-plan.md` 的「不迁」只是建议。这条必须先补 D-9 才能算数。

**（3）兜底是否已修 —— 方向一致，数字不对 ⚠️**
`ROADMAP.md:136` 说「✅ 2026-11-19 已完成（`fallback.ts`，19+8 条断言，含接线）」；
`分工建议.md:169` 把它当作**已踩过的坑**写（「新闻兜底测试只测纯函数…能变红才算测到」）；
`review-kit.md` §五之二第三行同口径。三处说法一致（都说已修 + 强调接线），
但「19+8」= 27 与实测 **33**（23 纯 + 10 接线）对不上；
且 `review-yang-2026-11-19.md:135`「结论与动作」表里仍把「修 P0-1（桌面端保留 DeepSeek Search 兜底路径）」列为待办，
没有任何「已完成」标记——读者会以为是未做的事。建议在该行加 `（已完成 2026-11-19）`。

**（4）`review-kit.md` §五之二「三种假证据」自身的可信度 —— 可验证，且第 3 条为真 ✅**
第 3 行说「新闻兜底测试只 import `fallback.ts`；把 `searchAndIngest` 的 `catch` 整条删掉，测试仍全绿」。
我按当时的提交复现了这个状态：`git show 35f71d7:scripts/verify-news-fallback.ts` 里第 6–8 节**断言数 = 0**（全文 24 条全是纯函数）。
也就是说，当时删掉接线，测试确实会全绿。第 1、2 条涉及外部仓库与本仓库早期提交，本轮未交叉验证，标**未验证**。

---

## 三、验证命令实跑结果（真实输出）

环境：Windows / Git Bash，`HEAD = e74cf6e`，工作树仅 `M pnpm-lock.yaml`（复核前已存在）。

| 命令 | 退出码 | 关键输出 |
|---|---|---|
| `pnpm run typecheck` | **0** | `grep -c "error TS"` → **0**；脚本链 `tsc -b && tsc -p pipeline/tsconfig.json --noEmit && pnpm --dir apps/desktop exec tsc --noEmit` 走完。前置的 `pnpm install` 仍报 `ERR_PNPM_IGNORED_BUILDS`（8 个包）与 `install that runs before scripts failed` 警告，但**不影响**本次退出码 |
| `pnpm exec tsx scripts/verify-dispatch.ts` | **0** | `全部通过`。19 条断言：§1 6 条、§2 2 条、§3 3 条、§4 1 条、§5 4 条、§6 3 条 |
| `pnpm exec tsx scripts/verify-news-fallback.ts` | **0** | `全部通过`。33 条断言：§1 6、§2 4、§3 8、§4 3、§5 2、§6 6、§7 3、§8 1 |
| `PYTHONUTF8=1 python tools/verify-doc-refs.py` | **1** | 「活跃文档 35 份，核对引用 453 条（跳过 2 条）」；指向仓库外 15 处（`.gitignore` 的 `example/`，脚本自己说不算错）；**指向不存在的文件 2 处**：`docs/requirements/R07-news.md:8 → pipeline/ingest-news.ts`、`:102 → pipeline/ingest-news.ts`；结尾「**共 2 处需要修**」 |

第 4 条按 `review-kit.md` §八的规矩，直接记 P1（见第一节最后一条）。

另有两条与「方法/契约一致性」有关的一次性比对（脚本，非仓库内文件）：

```
contract: 37 dispatch: 37
dup in contract: []   dup in code: []
在契约但代码没有: []   在代码但契约漏了: []
顺序完全一致: True
```

```
.prepare( 211   .exec( 44   .transaction( 25   → 合计 280
async 方法: 0
```

---

## 四、变红实验（2 次，均已还原并 `git diff` 确认为空）

### 实验 A：砍掉新闻兜底的接线

- **改了什么**：`packages/news/src/index.ts:341-342`，把
  `if (!isBackendUnavailable(error) || !this.allowFallback) throw error` + `return this.searchAndIngestFallback(...)`
  两行换成一行 `throw error`（等价于「把 catch 整条删掉」）。
- **看到什么**：`verify-news-fallback.ts` **退出码 1**，第 6 节 4 条变红：
  ```
  ❌ 后端拒绝时不抛错（真的退回去了） — fetch failed
  ❌ 兜底拿到了条目 — 实际 undefined
  ❌ 兜底结果写进了库（upsertNews 被调用） — 实际 0
  ❌ 入库的是长文那条 — undefined
  ```
  §7（`allowFallback=false`）与 §8（撞 url 回查 id）仍绿——说明这两节没被这次改动触及，**§6 是唯一守接线的断言**。
- **结论**：这条接线断言**有效**，`review-kit.md` §五之二第三行的坑已经堵上。
- **是否还原**：还原，`diff -q` → 字节一致，`git status --short packages/news/src/index.ts` 为空。

### 实验 B：让 dispatch 信任入参里的 `studentId`

- **改了什么**：`packages/dispatch/src/index.ts:50`，
  `const studentId = ctx.studentId` →
  `const studentId = typeof args.studentId === 'string' && args.studentId.length > 0 ? args.studentId : ctx.studentId`。
- **看到什么**：`verify-dispatch.ts` **退出码 1**，只有一条变红：
  ```
  ❌ 入参里的 studentId 被忽略（越权防护） — ["student_b"]
  有 1 条不通过
  ```
  `["student_b"]` 正是「甲拿着乙的 id 看到了乙的会话」，说明断言命中的是**真实越权路径**，不是字符串比对。
- **结论**：`studentId` 边界这条断言**有效**。
- **是否还原**：还原，`diff -q` → 字节一致，`git status --short packages/dispatch/src/index.ts` 为空。
- **顺带发现**：这条断言只覆盖 `chat.sessions` 一个方法。同一类风险（`chat.messages` / `agent.turns` /
  `artifacts.get` / `memory.delete`）**没有任何断言**——改了也不会红，这正是 Q1 里那 4 个方法能留下来的原因。

---

## 五、文档与代码的矛盾清单

| # | 哪句话写错了 | 位置 | 正确说法（有出处） |
|---|---|---|---|
| 1 | 「现有 37 个方法里全部读 `args.studentId`」 | `docs/contracts/ipc-methods.md:163` | dispatch 内 **0 处**读 `args.studentId`（`grep` 仅命中 `packages/dispatch/src/index.ts:11` 注释）；读入参的只有桌面适配器 `apps/desktop/src/main/index.ts:225`，用来**构造** `ctx` |
| 2 | 「抽成 `createDispatch(deps)`」 | `docs/contracts/ipc-methods.md:206` | 实际导出 `dispatchMethod(deps, method, input, ctx)`（`packages/dispatch/src/index.ts:42-47`）与 `exportFormat`（`:231`） |
| 3 | 「基线：…（`invoke` switch + 7 个独立通道）」 | `docs/contracts/ipc-methods.md:5` | `apps/desktop/src/main/index.ts` 已**没有** switch（`grep -c "case '"` = 0）；独立通道 **8** 个（契约自己 `:57-66` 也列了 8 个） |
| 4 | 「那 250 行 switch」 | `packages/dispatch/src/index.ts:4` | `08330ac^` 里 `invoke` 是第 203–393 行（191 行），switch 208–391（约 184 行） |
| 5 | 「现有 `assertSessionOwner` / `assertQuestionSetOwner` 必须保留」 | `docs/contracts/ipc-methods.md:36` | 全仓 `grep` **0 处**，这两个函数在本项目从未存在；服务端实际自建了 `apps/server/src/ownership.ts`（`requireSession`/`requireArtifact`/`requireEvidence`） |
| 6 | 「归属校验在 AgentService/DB 层」 | `packages/dispatch/src/index.ts:188` | 两层都没有：`db.listChatMessages` 只有 `WHERE session_id=?`（`packages/db/src/index.ts:1338-1343`），`agent.listTurns` 只是转发（`packages/agent/src/index.ts:390-391`）。实测可越权读（Q1） |
| 7 | 「所有面向学生的错误…（`friendlyError` 是唯一来源）」 | `docs/contracts/ipc-methods.md:30-33` | `learning:invoke` 这条（37 个方法）**不经过** `friendlyError`：`apps/desktop/src/main/index.ts:298` 直通 `invoke()`，只有 `:342`/`:379` 两个通道包了。（重构前也一样，非本次退步） |
| 8 | 「依赖 DAL 的文件 21 个」 | `docs/contracts/database-plan.md:18` | 复算：`08330ac` 上 26 个 `.ts`，现在 28 个（严格口径 14 / 18）。21 复算不出 |
| 9 | 「Python 侧只需把 `db.upsertNews(...)` 换成 `httpx.post(...)`」/「检查不再有 `upsertNews`」 | `docs/contracts/database-plan.md:63`、`:88` | Python 侧没有 `upsertNews`；实际是 `output.py:107` `INSERT INTO news_articles`、`db.py:113` `INSERT INTO source_runs` |
| 10 | 「采集服务（Python）**不直接写库**」 | `docs/contracts/database-plan.md:48` | 现在**仍在直写**：`output.py:107`、`db.py:113`、`db.py:69`；`POST /internal/news/ingest` 在 `apps/server` 与 `services` 里 `grep` 均 0 处。这句应写成「目标形态，验收见 §3」 |
| 11 | 「M1 引入…集中数据库（SQLite 单写 → PostgreSQL）」 | `plans/0.2.0/decisions.md:144` | 与 `database-plan.md:4`、`ROADMAP.md:131`、`分工建议.md:111` 相反；需补 D-9 才能让「不迁 PG」具备裁决效力 |
| 12 | 「下周：PG 迁移」「PG 迁移在任务 D」「我们马上要上 PG」「范围内含 PG 迁移」 | `分工建议.md:230`、`:55`、`:206`；`ROADMAP.md:217` | 均应改为「PG 迁移留 M2（触发条件见 `database-plan.md` §4.1）」；`tools/migrate-pg/` 需标「当前不启用」 |
| 13 | 「19+8 条断言」 | `plans/0.2.0/ROADMAP.md:136` | 实测 **33** 条（23 纯 + 10 接线）；`35f71d7` 时是 24 条（接线 0 条） |
| 14 | 「0 行服务端代码」 | `plans/0.2.0/ROADMAP.md:33` / `:111` | `apps/server/src` 已有 38 个 `.ts` / 4003 行（表头写「最后更新 2026-11-19」，今天的合并把它变成过期陈述） |
| 15 | 「正文 ≥300 字才入库」（作为全局口径） | `docs/requirements/R07-news.md:113` | 与同文件 `:76`/`:83` 的「正文和摘要都不足 20 字才拒绝入库」冲突。代码两处都在用：兜底按 300（`fallback.ts:29`），本地检索门槛 40（R07 `:105`）。需先统一 R07 口径，再决定 `FALLBACK_MIN_CONTENT` |
| 16 | 「把 `pipeline/ingest-news.ts` 写成可解析路径」 | `docs/requirements/R07-news.md:8` / `:102` | 文件已删除；`165a7b9` 修过，被 `e74cf6e` 合并覆盖回来（`verify-doc-refs.py` 因此退出码 1） |
| 17 | `web_search` 工具描述「检索 Python 新闻采集后端…3 秒预算」 | `packages/news/src/index.ts:539` | 桌面包走 DeepSeek 搜索，预算 15 秒（`fallback.ts:31`）；描述应说清「本地库优先，不可用时联网（≤15 秒）」 |

---

## 附：外部三条发现要不要改我们的文档

| 外部发现 | 影响我们的结论吗 |
|---|---|
| `memory.upsert` 在新学生（无 `student_profiles` 行）时 500，且把 `FOREIGN KEY constraint failed` 原文吐给学生 | **不影响，反而印证契约是对的**：`ipc-methods.md:28-33` 明写「不要把上游英文栈返回给学生，`friendlyError` 已处理，服务端别绕过它」。是服务端没照做，不是契约错 |
| `news.refresh` 采集服务未启动时返回 502，契约要求 200 | **影响**：契约 `:81` 只写了成功形状，没写「采集服务不在时返回什么」。这正是本文 P1「refresh 没有兜底」的文档侧一半——契约应补一行「采集服务不可用时返回 `{results:[], queued:false, accepted:[], ...}`，不得返回 5xx」 |
| 全量契约测试 63 passed / 3 failed / 14 skipped | 不影响本轮文档结论；但它说明 `verify-*.ts` 之外还有一套更宽的网，本文 P2「`verify-dispatch` 只验 case 存在」可以由那套网补上 |
