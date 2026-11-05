# A 轮派单：原生组合与兼容边界

> 建立时间：2026-11-03。依据：审计文档 §4.3、§4.3.1、§4.11 阶段 A。
> 本文件是 A 轮的唯一索引。**这一轮只核实事实，不改产品代码。**

## 〇、本轮口径

1. **只核实，不实施**：A 轮结束时产出的是一份「要挂哪些组件、怎么挂、哪里挂不上」的结论，不是产品代码。**但可以做一次抛包试验**（A0）：把 DSH 整套装进一个独立试验目录跑起来，验证它能跑——这是证据，不进产品代码。
2. **先全量堆上去，再砍**（学长口径）：不先挑「只要 llm + loop」，而是把 DSH 能跑的东西先搭起来，再剪。理由：先挑后接，剪掉的边界倚靠猜测；先堆后剪，砍哪一刀都能亲眼看到影响。
3. **版本全钉死**：审计 §4.11 要求「固定匹配版本、验证真实导出」。不用 `^`、不用 `latest`。
4. **不整套搬进产品**：试验目录里可以全量，产品树里只留真用得上的（审计 §4.3「明确不搬」清单仍然生效）。
5. **协议先核实再换**：现有适配器走 `/chat/completions`，`dsh-llm-deepseek` 走 Messages。**不核实清楚不许动 provider**。

## 一、范围

**做**：版本可达性、provider 协议、session 持久化与投影、资源根与打包方式、挂载清单。

**不做**：写运行时代码、改提示词、改需求文档、动数据库。

## 二、已核实事实（2026-11-03）

| 编号 | 事实 | 依据 |
|---|---|---|
| A1-1 | 仓库已声明 16 个 `@deepseek-ai/*` 包，版本统一 `0.2.1-rc.2`，`cordis` 为 `~4.0.5` | `package.json`、各 `packages/*/package.json` |
| A1-2 | **实际装到的只有 4 个**：`cordis`、`dsh-llm`、`dsh-skill`、`dsh-tools`（分布在 `packages/agent`、`packages/api`、`packages/bp`） | `node_modules/.pnpm` |
| A1-3 | **要接原生 loop 还缺 9 个包**：`dsh-agent-loop`、`dsh-system-prompt`、`dsh-session-persistence*`、`dsh-session-projection`、`dsh-skill-filesystem`、`dsh-tool-skill`、`dsh-token-meter`、`dsh-compaction-basic`、`dsh-compaction-tool-result-pruner` | 审计 §4.3.1 清单 × 实际 store |
| A1-4 | 上述 9 个包 **npm 上都有**，且与核心包**同批次发版**（每个包 43 个版本，`0.2.1-rc.2` 均存在） | `registry.npmjs.org` |
| A1-5 | **`latest` 标签是旧的**：`dsh-agent-loop` 的 latest 是 `0.1.0-rc.6`，`dsh-system-prompt`/`dsh-token-meter`/`dsh-skill` 的 latest 是 `0.0.1-rc.1` | 同上 |
| A1-6 | `dsh-agent-loop@0.1.0-rc.6` 的 peer 要求 `^0.1.0-rc.6` 的 llm/agent/tools/session/system-prompt/persistence —— **和仓库现有 `0.2.1-rc.2` 不兼容** | `registry.npmjs.org` peerDependencies |

**A1 结论**：可行，但**必须逐个钉 `0.2.1-rc.2`**。若图省事写 `latest` 或 `^0.1.0`，会装出一套 peer 互相打架的组合，症状是运行时报「找不到服务」而不是安装报错——很难查。

## 三、任务清单

| 编号 | 目标（一句话） | 材料 | 交付物 | 验收 |
|---|---|---|---|---|
| A0 | 在仓库外建一个抛包试验，把 DSH 整套跑起来（不看业务） | `example/deepseek-harness-master`、npm `@deepseek-ai/*@0.2.1-rc.2` | `G:/市场营销ai/probe/a0-dsh/` 下的 `package.json` + 启动脚本 + 一段对话输出 | 能跑通一次「发一句话 → 模型流式回包 → 自然结束」；输出日志归档到 `probe/a0-dsh/run.log` |
| A1 | 版本与可达性核对 | 上表 A1-1…A1-6 | 本文件 §2 表格更新 | ☐ 9 个缺包确认同版本可装且互相 peer 不冲突 |
| A2 | provider 协议核对 | `apps/desktop/src/main/llm.ts`、`dsh-llm-deepseek` README | §6 实测记录 | ✅ **能直接用，不需要适配层**（2026-11-04 实测，见 §6） |
| A3 | session 持久化与投影：`create/resume/close` 调用条件、数据落哪 | `dsh-session`、`dsh-session-persistence*`、`dsh-session-projection` | 一节挂载顺序与卸载顺序 | ☐ 写清与现有 `%APPDATA%/营小商` 的关系 |
| A4 | 产品资源根与打包：skill filesystem 的 `includeDefaultRoots: false` + 自定义根能否打进安装包 | `dsh-skill-filesystem`、`electron-builder.yml` | 一节路径与打包清单 | ☐ 写清资源目录、产物里应出现的文件、缺失时怎么发现 |
| A5 | 挂载结论：一份「挂什么/不挂什么/为什么」清单 | A0–A4 全部结果 | `plans/0.2.0/ROUND-A-CONCLUSION.md` | ☐ B 轮能直接照着实施，含被否方案与理由 |

## 四、待裁决（阻塞项）

1. **A2 若判定「需要最小适配」**：允许写多厚的适配层？审计只允许「范围明确的 provider 适配」，需要人定边界。
2. **A4 若原生 skill 根在打包后不可读**：退回自研 loader 与审计 §4.5.4「不补写平行实现」冲突，需要人裁决。
3. **参考仓库是否入库**：审计文档里 27 条链接指向 `example/`，而 `.gitignore:44` 排除了 `/example`，clone 后点不开（见 `pending-discussions.md` P-2）。

## 五、A 轮结束后应能回答

- 挂哪几个包、各什么版本、谁依赖谁？
- 一次对话从 UI 到模型再到写库，经过哪些原生服务、在哪个点拿到 turn 终态？
- 哪些现有代码会被删、哪些会被改、哪些一行不动？
- 有没有哪一条在 Electron/Node 环境根本走不通？

## 六、A2 实测记录（2026-11-04）

`dsh-llm-deepseek` 用 **Messages 协议**，默认 `baseURL = https://api.deepseek.com/anthropic`。
用**同一个 key、同一个模型**实测三件事：

| # | 请求 | 结果 |
|---|---|---|
| A | `POST https://api.deepseek.com/chat/completions`（现有链路） | ✅ 200 / 0.8s；注意返回 `model` 是 **`deepseek-flash`**，即使请求写的是 `deepseek-chat` |
| B | `POST https://api.deepseek.com/anthropic/v1/messages` | ✅ 200 / 0.2s，返回含 `thinking` 块 + `text` 块，`stop_reason: end_turn` |
| C | 同上 + 声明一个 `tools`（`input_schema`） | ✅ 200 / 0.6s，返回 `tool_use` 块（`read_kp({"kpId":"kp-101"})`），`stop_reason: tool_use` |

**结论**：

1. **不需要写 provider 适配层**。原生 `dsh-llm-deepseek` 直接指向官方 Messages 端点即可，
   与审计 §4.3.1「不能把旧 chat/completions 基址直接塞给 Messages」并不冲突——官方两边都提供。
2. **终态是真实的**：`end_turn` / `tool_use` /（可预期的）`max_tokens`。这正是 F02 要的东西，
   比现有「一律发 finish: stop」准确。
3. **模型名要按实际写**：请求 `deepseek-chat` 会被路由到 `deepseek-flash`。
   配置里写哪个都行，但日志要记**实际返回的 model**，否则排查时会看错模型（对应 F19）。
4. **thinking 块默认返回**。界面按「不展示思考过程」处理即可——不渲染，不是不存在。

**残留风险**：Messages 端点的限流、并发、长上下文计费与 chat/completions 是否一致，未验证。
B 轮跑真实对话时顺手记录 token 用量对照。
