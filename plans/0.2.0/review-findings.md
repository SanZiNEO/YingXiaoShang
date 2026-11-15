# 0.2.0 独立复核结论（main @ f04fd73）

**总判断：需改后再合。**

复核范围：`main` HEAD = `f04fd73`，`git status` 基线干净（复核中途出现一个非本会话创建的未跟踪文件，见文末「复核环境说明」）。
规程：`plans/0.2.0/review-kit.md`。权威顺序：`single-agent.md` > `mvp-v3.md` > `R01–R21` > `decisions.md` > 审计文档。
所有结论都来自**我自己读到的代码行**或**我自己跑出来的命令输出**，不采信提交信息与 ROADMAP 的自述。

---

## 一、验证命令实跑结果

| 命令 | 结果 | 断言数 |
|---|---|---|
| `pnpm run typecheck` | **退出码 0** | — |
| `pnpm exec tsx scripts/verify-news-search.ts` | 全部通过 | 14 pass / 0 fail |
| `pnpm exec tsx scripts/verify-errors.ts` | 全部通过 | 16 pass / 0 fail |
| `pnpm exec tsx scripts/verify-startup-failure.ts` | 全部通过 | 10 pass / 0 fail |
| `pnpm exec tsx scripts/verify-startup-health.ts` | 全部通过 | 5 pass / 0 fail |
| `pnpm exec tsx scripts/verify-history-budget.ts` | 全部通过 | 30 pass / 0 fail |
| `pnpm exec tsx scripts/verify-question-submit.ts` | 全部通过 | 16 pass / 0 fail |
| `pnpm exec tsx scripts/verify-cancel.ts` | 全部通过 | 6 pass / 0 fail |
| `pnpm exec tsx scripts/verify-settings-bom.ts` | 全部通过 | 12 pass / 0 fail |
| `PYTHONUTF8=1 python tools/verify-doc-refs.py` | 全部对得上（活跃文档 32 份、465 条引用、跳过 2 条、仓库外 15 处） | 退出码 0 |

合计 **109 条断言全绿**。但「全绿」不等于「测到了」——见第三节实验 B。

---

## 二、分级清单

| 级别 | 位置 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| **P0** | `packages/agent/src/tools/read-tools.ts:65`、`:82`、`:449-453` | 用正则判断学生想不想要「最新」，把意图判断写进了代码。这是 `single-agent.md` 点名禁止的第一种写法 | `:65` `const FRESH_INTENT = /最新\|今天\|今日\|昨日\|昨天\|刚刚\|本周\|这周\|最近\|近期\|新闻\|动态\|消息/`；`:82` `if (!FRESH_INTENT.test(input.query)) return false`；`:449` `const online = explicitOnline \|\| shouldSearchOnline({...})`。判据原文 `docs/principles/single-agent.md:35-36`：「**禁止第四种落位：把业务判断写进代码。** 包括但不限于：按关键词/正则判断学生意图……」。工具本来就有 `online` 参数（`:433-436`）交给模型判断，代码又判一遍 → 同一件事两个判定源 | 删掉 `FRESH_INTENT` 与 `shouldSearchOnline` 的意图分支，要不要最新只由模型的 `online` 参数决定。「本地没命中要不要联网」可以留，但要写进工具说明当成工具策略，不能看学生原话 |
| **P1** | `apps/desktop/src/renderer/src/App.tsx:1490-1504`、`:1508-1521` | 停止按钮只在「一个字都还没出」时存在；一旦模型开始出字，界面切到 `streaming` 分支，按钮整个消失——正是最想停的时候停不了 | `:1490-1491` `{busy ? (stream && stream.text.trim().length > 0 ? <出字视图> : <…>)`；`「停止」` 按钮在 `:1519`，只属于 `else` 那半边。对照 `docs/requirements/R21-response-speed.md:12`「等太久或者不想等了，**能点停止**」、`:86` 验收项。`plans/0.2.0/ROADMAP.md:52` 却记 ✅「能中途停下来」 | 把停止按钮移到两个分支之外（或出字视图里也放一个），点完把已出文字定稿成「已停止」的一条消息 |
| **P1** | `apps/desktop/src/renderer/src/App.tsx:751-754` | 出字之后只要来一个工具事件，就把已经显示的字清空（撤字） | `:751-754`：`if (item.type === 'tool') { /* 收回这段，避免半截话上屏 */ const reset = item.agent === 'lead' ? '' : current.text; return { ...current, text: reset, … } }`。单代理下 `agent` 恒为 `'lead'`（`packages/agent/src/team.ts:236`），所以每次都清。`R21:11`「出了的字**不能又消失**」、`R21:48`「**不撤字**：已显示的文字保留为上一段」、`R21:80`「不靠撤字制造整洁」。`plans/0.2.0/implementation-progress.md:26` F04 仍是 ☐（未修），`git blame` 显示这段来自 `8e784ab`（2026-10-21），本轮未处理 | 保留已出文字，把阶段行单独显示；`reset` 改成不清 `text` |
| **P1** | `packages/agent/src/index.ts:405-423`、`apps/desktop/src/main/index.ts:471-473`、`apps/desktop/src/renderer/src/App.tsx:979-982`、`:680` | 新会话首轮失败：主进程已经建好会话并写入学生消息，但失败时 sessionId 从没到过界面；界面拿 `undefined` 去刷新→清空屏幕，学生刚打的字消失；重发又建一条新会话，旧会话成孤儿 | `index.ts:405` `const sessionId = input.sessionId \|\| this.db.createChatSession({…})`，`:412` 先 `insertChatMessage`，之后才 `runTeamTurn`（无 try/catch）；`main/index.ts:472` `throw friendlyError(error)`；`App.tsx:981` `await refreshAll(sessionId)` 用的是闭包旧值，`setSessionId(result.sessionId)` 只在成功路径（`:963`）；`App.tsx:680` 在 `sid` 为空时 `setEvents([])`。`implementation-progress.md:30` F18 ☐ | 会话一建立就通过事件告诉界面（新增 `type:'session'`），失败也用真实 sessionId 刷新 |
| **P1** | `packages/agent/src/tools/read-tools.ts:417-422` 对照 `:449-455`、`:18` | `search_news` 的工具说明和真实行为相反，模型会照着说明向学生描述错行为 | 说明写「默认只查本地库，很快；库里没有就如实说没有」「只有学生明确要最新…才把 online 设 true：那会实时联网补抓，**通常 30 秒以上**」；实现是 `:449` 本地没命中就自动联网、`:18` `ONLINE_NEWS_TIMEOUT_MS = 15_000`（`:455` 也传 `crawl:false`，实测秒级）。另外 `:477-480` 那句「可以再调一次 search_news 并把 online 设为 true」在 `scored.length===0` 时永远不可达（`:449` 已把 online 置真）。`docs/requirements/R07-news.md:66` 的工具表也只写了 `query?`/`limit?`，没有 `online` | 说明改成真实行为（会联网、有上限、抓不到就说抓不到），删除不可达分支，R07 工具表补 `online` |
| **P1** | `packages/agent/src/tool-loop.ts:386-390`、`packages/agent/src/team.ts:214`、`:241` | 模型空返回时整轮作废：不仅刚流出去的字消失，连这一轮已经收好的产物也一起丢 | `tool-loop.ts:386` `if (text.length > 0) lastText = text` → `:388` `if (text.length === 0) throw new Error('模型没有返回任何内容')`（`lastText` 就在手上却不返回）；抛错使 `team.ts:241` 的 `await finalizeArtifacts(emit, warnings)` 根本不执行，而写工具已经对模型承诺过「已收齐…附件会在本轮结束时生成」（`artifacts.ts:88-89`）；渲染层 `App.tsx:986` `setStream(null)` + `:981` 刷新，屏幕上的字被抹掉，违反 `R21:11` | 空返回时优先返回 `lastText`；`finalizeArtifacts` 放进 `finally`，已 collect 的产物照常落库 |
| **P1** | `plans/0.2.0/ROADMAP.md:68`、`plans/0.2.0/implementation-progress.md:10-30` | 「P0 和 P1 已全部修完」这句话不成立，且与自称「真源」的进度表、与代码三方不一致 | `ROADMAP.md:68`「**现状：P0 和 P1 已全部修完并进包。**」；`implementation-progress.md` 的 F01–F19 **19 行全是 ☐**（`grep -c "☐"` = 23，`grep -c "✅"` = 4，且那 4 个 ✅ 都在轮次表里），其中 F04（撤字）与 F18（旧 sessionId）在本表中已用代码证明**没修**。反过来 F01/F10/F11/F13 明明已修（`main/index.ts:468`、`artifacts.ts:114`、`index.ts:516`、`history.ts`+`verify-history-budget` 30 条全绿）却仍画着 ☐ | 先逐条核对 F01–F19 再改状态；ROADMAP:68 在核对完之前不能写「全部修完」 |
| **P1** | `packages/agent/src/index.ts:789` | 交卷「重试未判题」用的是库里的旧答案，学生改过的答案不会被判 | `:789` `const baseAnswers = retrying && existing && existing.answers.length > 0 ? existing.answers : input.answers`；`:824` `const answer = baseAnswers[index]!` 直接拿去判。可达路径：`renderers.tsx:209-213` 只提交 `pendingQuestions`（没有作答记录的题），已判题被排除，但 `baseAnswers` 取的是**整份旧答案**，于是重判时 `answer.answer` 是旧的那份。`R09-questions.md:112/125/153` 只说「未判题可重试、已判题不重复记分」，**没有**任何一条裁决说重试要用旧答案 | 按 `questionId` 合并：旧记录顺序不变、新答案优先；补一条断言「重试时判题收到的答案 = 学生改后的答案」 |
| P2 | `apps/desktop/src/main/errors.ts:36` | `/400/` 匹配的是「字符串里出现 400 这三个字符」，不锚定状态码，正常错误会被误判成「模型名不对」 | 实跑（把该文件原样复制到临时目录 import 同一个函数）：`'DeepSeek API error: max_tokens=4000 exceeds the limit'` → 「模型名不对：在『设置』里把模型改回 deepseek-chat 再试。」；`'…requested 40023 tokens'` → 同上。学生按这句话改模型名是白改 | 收窄成状态码锚定（如 `/\b400\b\s*(Bad Request)?/` 或从错误对象取 status），并把「上下文超长」单独给一条人话 |
| P2 | `apps/desktop/src/renderer/src/renderers.tsx:100-104`、`packages/shared/src/index.ts:802-813` | 空题目集是一句死话，没有任何可点的下一步；schema 又允许空集落库 | `renderers.tsx:100-104` 只渲染 `MarkdownView` 或 `<Empty>这份题目集没有可渲染的题目。</Empty>`；`QuestionSetContentSchema.questions` 是 `z.array(...).default([])`，**没有 `min(1)`**，所以 `questions: []` 能通过校验、`finalizeArtifacts` 能落库 | schema 加 `min(1)`；渲染层给两个按钮（重新出题 / 先讲重点）走 `send(text)` |
| P2 | ~~`packages/agent/src/news-lab.ts:291-299`~~（文件已于 2026-11-07 删除） | 6188af7 改了一个**没有任何调用方**的文件，改动不生效，但提交信息说「news-lab 实时检索同样 crawl:false」，会让人以为这条链路已优化 | `grep -rn "news-lab" packages/ apps/ scripts/` 只命中 `news-lab.ts` 自身与 `lib/`（gitignore 的构建产物 + sourcemap），源码零导入；`mvp-v3.md` 第 5 节把 `news-lab.ts` 列为待删除项 | 要么随旧管线一起删，要么在本轮明确标注「已死、不修」，别在死文件上做无效果优化 |
| P2 | `apps/desktop/src/renderer/src/App.tsx:729-730` 对照 `:938` | 启动自检的提示会被学生发的第一条消息清掉，于是「安装包不完整」这件事又变回静默 | `:729-730` `if (warning) setNotice(warning)`；`:938` `send()` 开头 `setNotice('')`。`main/index.ts:512-519` 只负责算 `startupHealth`，没有把「不完整」做成常驻条 | 自检结果放独立状态（常驻横幅），不要复用会被清空的 `notice` |
| P2 | `apps/desktop/src/renderer/src/App.tsx:967`、`:975`、`packages/agent/src/index.ts:482`、`packages/agent/src/team.ts:245-246` | 渲染层还留着按角色分派的判定，但 `plan.steps` 恒为空，这些分支永远不成立；单代理之后也没人关掉这些「兼容字段」 | `index.ts:482` `steps: []`；`App.tsx:967` `result.plan.steps.some((step) => step.agent === 'case')`、`:975` `…step.agent === 'knowledge'`；`team.ts:245-246` 注释写「单代理没有成员；字段留着，前端与落库格式不变」，但没有写谁在哪一轮删 | 删掉这两处角色判定（依据面板自动打开只按 `citations` 判），给 `members`/`subagents` 字段写明退场轮次 |
| P2 | `docs/requirements/R07-news.md:74`、`:75`、`docs/requirements/R21-response-speed.md:86` | 文档里的行号存在但**指的已不是那件事**；`verify-doc-refs.py` 只验「这一行存在」，验不出语义错位 | R07:74 说「最新 `fetched_at` 距今不足 30 分钟则跳过（`packages/news/src/index.ts:56`、`:251-259`、`:356-360`）」——`:251-259` 实际是 `searchAndIngest` 的错误收集与 `upsertNews`，`:356-360` 是 `runRefresh` 的 catch；真正的判定在 `:268-273`（`ensureFresh`）。R07:75 说单飞在 `:243-249`，实际在 `:260-266`。R21:86 说「对照 `App.tsx:723-726`」，这四行现在是启动自检 effect（`:724-730`），不是不撤字那段（`:751-754`） | 改成 `ensureFresh:268-273`、`refresh:260-266`、`App.tsx:751-754`；`verify-doc-refs.py` 无法覆盖此类问题，需人工抽查 |

---

## 三、看不见的自检：实验记录（都做过还原）

### 实验 A（能变红）—— 证明断言是活的

把 `read-tools.ts:81` 的 `if (input.localHits === 0) return true` 改成 `if (input.localHits >= 0) return false`（恒不联网）：

```
5b. 什么时候该自动联网（本地没有 / 学生要最新且本地太旧）
  ❌ 本地没命中 → 联网
  ✅ 本地命中、普通提问 → 不联网
  ❌ 学生说「最新」且本地 6 天前 → 联网
  ✅ 学生说「最新」且本地今天就有时 → 不联网
  ❌ 要最新但不知道本地最新到哪天 → 联网
  ✅ 普通提问且本地有时间 → 不联网
有 3 条不通过
```

还原后 `git checkout -- packages/agent/src/tools/read-tools.ts`，确认 `:81` 回到 `if (input.localHits === 0) return true`，`git status` 里该文件消失。

### 实验 B（不变红）—— 这条最要紧

把 `apps/desktop/src/main/index.ts:468` 的 `signal: controller.signal,` **整行删掉**（即 97621ab 自称已修的那个 P1：主进程建了 AbortController 却没把 signal 交给执行链），再跑 `verify-cancel.ts`：

```
1. 没点停止：正常跑完                     ✅ ✅
2. 中途停止：必须快速退出，而不是等模型吐完   ✅ ✅ ✅
3. 已经停过再调用：不发请求直接退出          ✅
全部通过
```

**结论：`verify-cancel.ts` 覆盖不到它要防的那个 bug。** 它只测 `runAgentLoop({signal})`（`scripts/verify-cancel.ts:63-71` 直接调库函数），没有测 `main/index.ts` 里「`learning:cancel` → `turnControllers` → `hooks.signal`」这条接线。所以「停止按钮真停」这件事**目前没有任何自动化证据**，只能靠手点。

还原后确认 `:468` 已回位、`grep RED-EXPERIMENT` 无残留、`git status` 干净。

---

## 四、「已声称修复」逐条对照（我亲手验的）

| 声称 | 我的复核结论 | 证据 |
|---|---|---|
| P0 启动失败无窗口 → 已修 | **分类逻辑成立，但没有一个能证明「弹窗真的会出来」的自动化验证** | `apps/desktop/src/main/index.ts:382-425` 的 try/catch 与重置流程确实在；`health.ts:44-81` 的 `startupFailure` 分类被 `verify-startup-failure` 10 条断言覆盖（全绿）。但 `verify-startup-failure` 只 import 纯函数（`scripts/verify-startup-failure.ts:8` import `health.js`），不经过 Electron 的 `dialog` / `renameSync` / `relaunch`。本机无法跑 Electron 界面，**这一段标「未验证」** |
| P1 停止按钮假停 → 已修 | **接线确实补上了，但没有任何测试盯着它** | `main/index.ts:468` 已传 `signal`；`tool-loop.ts:234`/`:382` 两处 `if (input.signal?.aborted) throw`，`:242` 也把 `signal: input.signal` 传进 `ctx.llm.stream`。但实验 B 证明 `verify-cancel` 删掉这行照样全绿 |
| P1 停止按钮可用 | **不成立** | `App.tsx:1490-1521`：出字之后按钮消失（见 P1 第 2 条） |
| 新闻检索 3 分钟 → 1.9 秒 | **代码路径成立，数字我复验不了** | `read-tools.ts:18` 15 秒上限、`:455` `crawl:false`、`news/index.ts:212-216` 新增 `{crawl}` 分支都成立；`verify-news-search` 14 条全绿（含超时兜底）。但「1.9 秒」是 `probe/` 里的联网实测，`review-kit.md` §七 明确把 `probe/` 排除在审查范围外，**我未复跑** |
| 错误文案不再露英文栈 | **成立，但 `/400/` 会误伤** | `verify-errors` 16 条全绿，含 `isHuman()` 反裸英文断言；`/400/` 的误判见 P2 第 1 条，现有用例覆盖不到 |
| D-7 说 D2 之后删 `history.ts` → 检查是否遗留 | **不构成问题，不列为 finding** | `decisions.md` D-7「退场条件：D2 落地后…本文件删除」；`plans/0.2.0/README.md` 轮次表里 D 轮仍是 ☐，条件未成立。且 `history.ts` 仍在被使用（`packages/agent/src/index.ts:31` import，`:445` 调用 `buildHistoryView`），删了会断链 |
| 4 条 P2「现在不需要做」 | **不同意分级，其中 3 条应算 P1** | `ROADMAP.md:68-73` 把「空返回丢字」「重试旧答案」「首轮失败旧 sessionId」「空题目集」都记 P2。按 `review-kit.md` §五 的定义（P1 = 明显退化、需求未接通、文档与实现不一致），前三条分别命中 `R21:11`、判分错误、脏会话，我改判 P1；只有「空题目集」同意留 P2 |

---

## 五、文档 vs 代码抽查（3 处，都不靠印象）

1. **R07 §4.5 行号**：`docs/requirements/R07-news.md:74` 引 `packages/news/src/index.ts:251-259`、`:356-360` 作为「30 分钟新鲜度跳过」的依据。实际 `:251-259` 是 `searchAndIngest` 的 error 循环 + `upsertNews`，`:356-360` 是 `runRefresh` 的 catch；判定在 `:268-273`。**文档说的是假的（指错地方），脚本查不出来。**
2. **R07 §4.4 工具表**：`R07-news.md:66` 写的 `search_news` 参数只有 `query?`/`limit?`，实现多了 `online`（`read-tools.ts:433-436`）并且现在还会自动联网（`:449`）。**文档落后于实现。**
3. **R21 验收引用**：`R21-response-speed.md:86` 让复核人「对照 `App.tsx:723-726`」，那四行现在是被 53468bb 插入的启动自检 effect（`App.tsx:724-730`），不撤字那段在 `:751-754`。**行号漂了，而 `verify-doc-refs.py` 报「全部对得上」。**

补充（正向确认）：`decisions.md` D-2「界面只通过一层协议跟运行时说话」仍然成立——`apps/desktop/src/preload/index.ts:7-43` 是所有通道的唯一出口，渲染层没有直接拼 prompt 或直读库。

---

## 六、跑不起来的验证命令

**没有。** 上面 10 条全部真跑成功（109 条断言 0 失败）。

需要注意的两点（不算失败，但影响「干净」判断）：

- 每条 `pnpm exec tsx ...` 都会先触发一次隐式 install，输出 `[WARN] The install that runs before scripts failed, so your node_modules may be out of sync with your lockfile`（`ERR_PNPM_IGNORED_BUILDS`）。命令本身照常执行、退出码 0，但这台机器的 `node_modules` 与 lockfile 不保证一致，**结论只在当前 node_modules 上成立**。
- `pnpm run typecheck` 是 `tsc -b`，会写 `packages/*/lib`（已 gitignore），不污染工作树。

---

## 七、建议修复顺序（按工作量从低到高）

1. **`errors.ts:36` 的 `/400/`**（改一个正则 + 补 2 条断言，10 分钟）—— 会把学生引向完全错的自救动作。
2. **`read-tools.ts` 的 P0**（删 `FRESH_INTENT` + 改工具说明 + 补 `online` 断言，半小时）—— 破原则，且改完顺手消掉一条 P1（说明与实现相反）。
3. **停止按钮挪出 `else` 分支**（`App.tsx:1490-1521`，半小时）—— R21:12 明写，学生最直接感知。
4. **不撤字**（`App.tsx:751-754`，半小时）—— 一行 `reset` + 一条渲染层纯函数断言。
5. **空返回保留 `lastText` + `finalizeArtifacts` 进 finally**（`tool-loop.ts:388`、`team.ts:241`，半天）—— 同时救回「已出正文」和「已收齐产物」。
6. **会话 id 早发**（`team.ts` 加 `session` 事件 + `index.ts:405` 后 emit + `App.tsx` 收 + `main` 透传，半天）—— 消掉孤儿会话。
7. **重试按 questionId 合并答案**（`index.ts:789`，半天）—— 唯一真正的坑是 `storedResults[index]` 按下标复用，顺序必须保持旧记录顺序。
8. **补一条测得住接线的取消断言**（新建脚本，直接断言 `main/index.ts` 把 signal 传进 hooks；或把接线抽成纯函数，半天）—— 否则实验 B 那种「删掉实现照样全绿」会再次发生。
9. **核对并重写 F01–F19 状态 + 改掉 ROADMAP:68**（1 小时，纯文档，但要老实）—— 在此之前不要发版。
10. **空题目集兜底 + schema `min(1)`**（1 小时）。
11. **清理：删 `news-lab.ts` 或标注已死、删 `App.tsx:967/:975` 角色分支、给 `members` 写退场轮次、修 3 处文档行号**（半天，可以攒一批）。

---

## 八、复核环境说明（诚实记录）

- 基线 `git status` 为空；复核过程中工作树出现**一个非本会话创建的未跟踪文件** `plans/0.2.0/p2-fixes-plan.md`（mtime 2026-11-15 23:07）。我没有创建也没有修改它，未纳入本次判断；本次两条实验改动的两个文件都已 `git checkout --` 还原，`grep RED-EXPERIMENT` 无残留。
- 本报告的复核对象始终是 `f04fd73`（`git rev-parse HEAD` 复核前后一致）。
- 未做：Electron 界面手点、联网实测（`probe/` 在 `review-kit.md` §七 的范围之外）。
