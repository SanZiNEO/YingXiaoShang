# 0.2.0 实现进度（真源）

> 每关掉一项就在对应行划掉并写日期。**不攒到最后一起写。**
> 编号与审计文档的 F 编号对应；具体做法见各轮 `ROUND-X-MAP.md`。

## 一、P0（会挂住 / 错交付 / 断闭环）

| 编号 | 问题 | 状态 |
|---|---|---|
| F01 | 循环请求不传 `signal`，读取流可长期等待 | ☐ |
| F02 | SSE 只用 `finish_reason` 判停读，最后一律发 `finish: stop` | ☐ |
| F03 | `team.ts` 写死 `maxRounds=10`，耗尽后还有第 11 次收口；收口的 writers-only 执行端不拦 | ☐ ⊘ 不修（随原生 loop 删除） |
| F08 | `artifacts.collect` 只暂存却返回「已收齐/已关闭」 | ☐ |
| F09 | 页面分片合并 `content.html`，但 `body` 被新分片覆盖 | ☐ |
| F10 | 新出的题只写 artifact 不写题库，交卷必失败 | ☐ |
| F11 | 聊天 turn 写 `record_json: {}`，记录器遇空即停 | ☐ |

## 二、P1

| 编号 | 问题 | 状态 |
|---|---|---|
| F04 | 工具事件撤回已出文字 | ☐ |
| F05 | 事件缺终态与 tool-call id；界面不处理 `tool-end` | ☐ |
| F06 | 缓存命中不等于有进展 | ☐ |
| F07 | 无统一参数 schema 校验，错误一律解释成「参数太长」 | ☐ |
| F12 | 产物校验发生在循环之后 | ☐ |
| F13 | 历史无条数/体积预算 | ☐ |
| F14 | skill 未接原生注册表 | ☐ |
| F15 | 读正文硬切前 4k/12k 字，无续读信息 | ☐ |
| F16 | `read_kp` 与 `read_material` 共用已读键 | ☐ |
| F17 | 单一 stream 不绑会话，晚到事件会串台 | ☐ |
| F18 | 失败前没有 started 回执，失败刷新仍用旧 sessionId | ☐ |
| F19 | 路由常量写 `deepseek-flash`，实际由设置决定 | ☐ |

## 三、轮次进度

| 轮次 | 结论 / 交付物 | 状态 |
|---|---|---|
| 0 交付 | 待定（见 `pending-discussions.md` P-1） | 🟡 |
| A 原生组合与兼容边界 | ✅ 关单：A0 装包+CLI 路线否；A1 store 已齐（缺声明）；A2 原生 provider 直连可跑；A3 session 三约束；A4 skill 根方案；A5 见 ROUND-A-CONCLUSION.md | ✅ |
| B 最小原生链路 | B1 挂载 ✅　B2 建 agent ✅　B3 真实对话 ✅　B4 工具调用 ✅（1.7s，自然结束）；B5 取消 / B6 流式事件待做 | 🔵 |
| C 业务接入 | — | ☐ |
| D context 与桌面视图 | — | ☐ |
| E 切换与清理 | — | ☐ |
| F 验收 | — | ☐ |

## 四、沿革记录（只记结论，不写过程）

- 2026-10-29：曾把 `maxRounds` 10→3 当作提速手段。⊘ 不做——与审计 F03、§4.4.3 冲突，判断错误，PR 已关闭。
- 2026-10-29：自查脚本发现流式路径会把 DSML 标记漏给学生。旧循环内不修（该文件将被删除），改为在 B 轮确认原生 provider 不再走文本解析旁路。
- 2026-11-03：A 轮口径从「挑需要的组件逐个接」改为「**先全量抛上去跑通，再砍**」，并增加 A0 抛包试验。理由：先挑后接时，剪掉的边界只能靠猜；先堆后剪，每一刀都能看到影响。产品树里仍然只留真用得上的（审计 §4.3 不搬清单不变）。
- 2026-11-03：采纳 `SKILL.md`（设计文档六段结构）与 `omp-主代理-轮次任务模板`（派单五要素/验收/红线），落为 `plans/0.2.0/主代理-轮次任务模板.md`，仅换验证手段（gradle → pnpm/tsx），方法论不变。

## 五、A0 抛包试验（2026-11-03，`G:/市场营销ai/probe/a0-dsh/`）

| 步骤 | 结果 |
|---|---|
| `npm install` 8 个核心包（`0.2.1-rc.2`） | ✅ 33 个包 39 秒装完（走 npmmirror），`@deepseek-ai` 目录 30 个 |
| 版本一致性 | ✅ `dsh-agent-loop@0.2.1-rc.2` 的 peer 全部精确钉 `0.2.1-rc.2`，与仓库现有 `cordis ~4.0.5` 兼容 |
| 装 `@deepseek-ai/dsh@0.2.1-rc.2`（带 CLI `dsh`） | ❌ 依赖 `node-pty@1.2.0-beta.15`，需要 `node scripts/prebuild.js \|\| node-gyp rebuild`，**npm 默认拦掉 install scripts**，`dsh` 未落地 |
| 尝试 CLI profile 路线 | ⏸ 暂停，见下 |

**结论（重要）**：CLI / profile 路线需要原生编译（`node-pty`），而产品不需要 CLI。
**B 轮应走编程装配**（`ctx.agents.create()`），不走 `dsh --profile`。
这条要写进 A5 结论。

**下一步两条路**：

1. `npm approve-scripts` 放行 node-pty，再用 CLI 验证一遍——只为了拿到「官方 profile 长什么样」的参照；
2. 直接手写 cordis 装配（`AgentRegistry` + `AgentLoop` + `SystemPrompt` + `Tools` + `LLM/DeepSeek`），
   README 已给出最小用法：`ctx.agents.create({ sessionId, agentOptions: { provider, model } })`。
   推荐这条：与产品的最终形态一致，不引入 CLI 依赖。
