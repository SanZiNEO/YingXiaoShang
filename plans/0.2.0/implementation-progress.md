# 0.2.0 实现进度（真源）

> 每关掉一项就在对应行写日期与证据。**不攒到最后一起写。**
> 编号与审计文档的 F 编号对应。
>
> **2026-11-07 全面重核**：这张表此前 19 行统一画着 ☐，但其中一半早已在后续轮次修掉。
> 现在每一行的状态都是**照代码重新核对的**，「证据」列写清凭什么这么说。
> 独立复核记录见 `review-findings.md`（main @ f04fd73），修复方案见 `p2-fixes-plan.md`。

## 一、P0（会挂住 / 错交付 / 断闭环）

| 编号 | 问题 | 状态 | 证据 |
|---|---|---|---|
| F01 | 循环请求不传 `signal`，读取流可长期等待 | ✅ 2026-11-07 | `main/index.ts:466` 把 `turn.signal` 交给 `handleConversation`；`tool-loop.ts` 每轮开头与请求前检查 aborted。**新增 `verify-cancel-wiring.ts`**：删掉那行会变红（旧 `verify-cancel.ts` 删了仍全绿，是假保护） |
| F02 | SSE 只用 `finish_reason` 判停读，最后一律发 `finish: stop` | ✅ | `main/llm.ts:178` 用 `choice.finish_reason` 判定结束 |
| F03 | `team.ts` 写死 `maxRounds=10`，耗尽后还有第 11 次收口 | ☐ **未修** | `tool-loop.ts:230` `maxRounds: 10` 仍在；收口轮仍只给 writers。**按审计 F03/§4.4.3 应随原生 loop 删除**，属 B 轮范围 |
| F08 | `artifacts.collect` 只暂存却返回「已收齐/已关闭」 | ✅ 2026-11-07 | `team.ts` 的 `finalizeArtifacts` 移进 `finally`：这一轮即便抛错（空返回/断网/停止），已收齐的产物照样落库；空题目集在 `artifacts.ts:88` 当场退回给模型 |
| F09 | 页面分片合并 `content.html`，但 `body` 被新分片覆盖 | ✅ | `artifacts.ts:83` `incoming.body.length > 0 ? incoming.body : existing?.body ?? ''` |
| F10 | 新出的题只写 artifact 不写题库，交卷必失败 | ✅ 2026-11-07 | `question-registry.ts` + 交卷前补登记（`index.ts:705`）；`verify-question-submit.ts` 覆盖 |
| F11 | 聊天 turn 写 `record_json: {}`，记录器遇空即停 | ✅ | `recorder.ts` 跳过无 record 的老轮次推进水位；`ROUND-C-ARCHIVE.md` 记录实测 8/8 |

## 二、P1

| 编号 | 问题 | 状态 | 证据 |
|---|---|---|---|
| F04 | 工具事件撤回已出文字 | ✅ 2026-11-07 | 抽出 `renderer/src/stream-state.ts`，tool 事件只更新阶段不清 `text`；**`verify-stream.ts`** 变红实验：改回清字 → 2 条失败 |
| F05 | 事件缺终态与 tool-call id；界面不处理 `tool-end` | 🟡 部分 | `tool-end` 事件已产生并转发（`team.ts:168`）；界面不消费它——当前无害（阶段文案由下一轮事件覆盖），保留 |
| F06 | 缓存命中不等于有进展 | ⊘ 不成立 | 工具输出缓存命中时不产生新的模型轮次（`tool-loop.ts` 的 `cache` 只在同一轮内复用），不会假装「有进展」 |
| F07 | 无统一参数 schema 校验，错误一律解释成「参数太长」 | ☐ **未修** | 仍是「工具 execute 抛错 + 对截断类错误特判」（`tool-loop.ts:325`）。没有 per-tool schema 校验 |
| F12 | 产物校验发生在循环之后 | ⊘ 设计如此 | 校验必须在整轮结束时做（模型可能分片写）；已由 F08 的 `finally` 保证「校验一定会执行」 |
| F13 | 历史无条数/体积预算 | ✅ | `history.ts` 纯函数（最近 3 轮逐字、助手≤1200、学生≤600、逐字≤7000、摘要≤700）；`verify-history-budget.ts` 30 条 |
| F14 | skill 未接原生注册表 | ☐ **未修 + 有死文件** | 提示词仍用 `prompts.ts` 直读 `agents/mentor` 与 `references/*`；`packages/agent/skills/case-coach/SKILL.md` **全仓库零引用**（死文件） |
| F15 | 读正文硬切前 4k/12k 字，无续读信息 | ☐ **未修** | `read-tools.ts:12` `MAX_BODY=4000`、`:377` `.slice(0, 12_000)`，截断处没有「还有更多，可换窄参数续读」的提示 |
| F16 | `read_kp` 与 `read_material` 共用已读键 | ✅ | 键已分域：`kp:` / `block:` / `ref:` / `news:`（`read-tools.ts:141/247/397/505`） |
| F17 | 单一 stream 不绑会话，晚到事件会串台 | ✅ 2026-11-07 | `applyStreamEvent` 先比 `requestId`，不匹配原样返回；`verify-stream.ts` 第 4 组断言 |
| F18 | 失败前没有 started 回执，失败刷新仍用旧 sessionId | ✅ 2026-11-07 | `index.ts:412` 建会话后立刻发 `type:'session'`；渲染层 `setSessionId`。**`verify-session-id.ts`** 断言「发事件在建会话之后、跑模型之前」 |
| F19 | 路由常量写 `deepseek-flash`，实际由设置决定 | ⊘ 常量未生效 | `main/llm.ts:96/214` 用 `settings.model` 发请求；`DEFAULT_ROUTE.model` 是死常量。**建议 B 轮清理**，避免下一个人误以为真用 flash |

## 三、体检报告的 4 条（原记 P2，复核改判）

复核按 `review-kit.md` §五 的 P1 定义（需求未接通 / 数据会错）改判其中 3 条为 P1。已全部修完：

| 原编号 | 问题 | 改判 | 状态 | 证据 |
|---|---|---|---|---|
| ① | 空返回时已流出正文被丢掉 | **P1** | ✅ | `tool-loop.ts:388` 空返回先返回 `lastText`；`verify-empty-return.ts`（第一轮吐字+工具调用、第二轮空）变红 3 条 |
| ② | 交卷重试用库里旧答案 | **P1** | ✅ | 抽出 `answer-merge.ts`；`verify-retry-answers.ts` 变红复现原 bug（「第 2 题用新答案」失败） |
| ③ | 新会话首轮失败仍用旧 sessionId | **P1** | ✅ | 同 F18 |
| ④ | 空题目集无引导 | P2 | ✅ | schema `questions.min(1)` + `artifacts.ts` 当场退回 + 界面两个按钮（`question-set.ts` 纯函数 + `verify-empty-question-set.ts`） |

## 四、复核发现的其它问题（本轮全修）

| 级别 | 位置 | 状态 | 证据 |
|---|---|---|---|
| P0 | `read-tools.ts` 用正则（`FRESH_INTENT`）判断学生意图，违反 `single-agent.md:35-36` | ✅ | 删除该正则；`shouldSearchOnline(localHits)` 只看「本地有没有命中」，要不要最新交回模型的 `online` 参数 |
| P1 | 工具说明写「默认只查本地、30 秒以上」，实现是自动联网、15 秒 | ✅ | 说明改为真实行为（先查本地 → 没命中自动联网一次，最多 15 秒）；删除不可达分支 |
| P1 | 停止按钮只在「还没出字」时存在 | ✅ | 抽出 `stopControls`，出字视图与等待视图共用 |
| P1 | `ROADMAP.md:68`「P0 和 P1 已全部修完」不成立 | ✅ | 已改写为「逐条状态见本表」并列出未修项 |
| P2 | `errors.ts` 的 `/400/` 把 `max_tokens=4000` 误判成「模型名不对」 | ✅ | 状态码锚定 + 上下文超长/输出上限两条独立文案；`verify-errors.ts` 新增 6 条 |
| P2 | `news-lab.ts` 无调用方，改它也无效 | ✅ 2026-11-07 已删 | 全仓库零导入，已删除；`verify-doc-refs.py` 随即报出 5 处文档引用，已同步修掉 |
| P2 | 启动自检提示被第一条消息清掉 | ☐ 待清理 | `App.tsx:729` 用 `notice`，`:938` `send()` 开头 `setNotice('')` |
| P2 | `App.tsx` 还留着按角色分派的分支（`plan.steps` 恒空） | ☐ 待清理 | `index.ts:482` `steps: []` |
| P2 | 文档行号指错地方（`R07:74/75`、`R21:86`） | ☐ 待清理 | 真实位置：`news/index.ts:268-273`（ensureFresh）、`:260-266`（单飞）、`App.tsx:751-754`（不撤字） |

## 五、轮次进度

| 轮次 | 结论 / 交付物 | 状态 |
|---|---|---|
| 0 交付 | 双击即用包 1105g（42 文件 / 158MB），启动器 exe | ✅ |
| A 原生组合与兼容边界 | A0 装包+CLI 路线否；A1 store 已齐；A2 原生 provider 直连可跑；A3 session 三约束；A4 skill 根方案 | ✅ |
| B 最小原生链路 | B1 挂载 ✅　B2 建 agent ✅　B3 真实对话 ✅　B4 工具调用 ✅（1.7s）　B6 增量帧 ✅；B5 取消 🟡（终态成立） | 🔵 |
| C 业务接入 | 学情档案闭环、历史瘦身、交卷修复、新闻检索 | ✅ |
| D context 与桌面视图 | — | ☐ |
| E 切换与清理 | `news-lab.ts` ✅ 已删；待办：`case-coach.ts` 死文件、`DEFAULT_ROUTE.model` 死常量 | 🟡 |
| F 验收 | — | ☐ |

## 六、沿革记录（只记结论，不写过程）

- 2026-10-29：曾把 `maxRounds` 10→3 当作提速手段。⊘ 不做——与审计 F03、§4.4.3 冲突，PR 已关闭。
- 2026-11-03：A 轮口径改为「先全量抛上去跑通，再砍」。
- 2026-11-07：**复核推翻了两条自述**。①「P0/P1 已全部修完」不成立（F04/F18 实际未修）；
  ②「停止按钮真停」缺自动化证据——删掉 `signal` 接线后 `verify-cancel.ts` 仍全绿。
  教训写进 `review-kit.md` 的用法：**测「库函数」不等于测「接线」**。
- 2026-11-07：新增 6 个断言脚本（stream / empty-return / retry-answers / cancel-wiring /
  empty-question-set / session-id），全部做过变红实验。

## 七、A0 抛包试验（2026-11-03，`G:/市场营销ai/probe/a0-dsh/`）

| 步骤 | 结果 |
|---|---|
| `npm install` 8 个核心包（`0.2.1-rc.2`） | ✅ 33 个包 39 秒装完（走 npmmirror），`@deepseek-ai` 目录 30 个 |
| 版本一致性 | ✅ `dsh-agent-loop@0.2.1-rc.2` 的 peer 全部精确钉 `0.2.1-rc.2`，与仓库现有 `cordis ~4.0.5` 兼容 |
| 装 `@deepseek-ai/dsh@0.2.1-rc.2`（带 CLI `dsh`） | ❌ 依赖 `node-pty@1.2.0-beta.15`，需要原生编译，npm 默认拦掉 install scripts |
| 尝试 CLI profile 路线 | ⏸ 暂停 |

**结论**：CLI / profile 路线需要原生编译，而产品不需要 CLI。**走编程装配**（`ctx.agents.create()`）。
