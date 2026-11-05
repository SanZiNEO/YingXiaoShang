# A 轮结论：挂什么、怎么挂、删什么

> 依据：`ROUND-A-MAP.md` §2 与 §6、§7 实测；审计 §4.3.1 的复用清单。
> 这份文件是 B 轮的实施依据。**A 轮只核实，本文件不含代码改动。**

## 一、挂载清单（进产品）

| 原生组件 | 用途 | 版本 | 备注 |
|---|---|---|---|
| `@deepseek-ai/cordis` | 服务容器 | `~4.0.5` | 仓库已有 |
| `dsh-scope` | 作用域，其他包 peer 依赖 | `0.2.1-rc.2` | A1 补声明 |
| `dsh-llm` | LLM 服务与规范 stream | 同上 | 仓库已有 |
| `dsh-llm-deepseek` | DeepSeek Messages 传输 | 同上 | **A2 已验：官方端点可用，不写适配层** |
| `dsh-llm-deepseek-api-key` | 从环境/设置取 key | 同上 | 与现有 `settings.ts` 对接，不另建凭据源 |
| `dsh-agent` | Agent 注册表 | 同上 | 现有 `packages/api` 已引用 |
| `dsh-agent-loop` | 主循环、取消、自然结束 | 同上 | **替代 `tool-loop.ts`** |
| `dsh-session` | 会话事件源 | 同上 | |
| `dsh-session-persistence` + `-jsonl` | 持久化（每会话 `.jsonl.zstd`） | 同上 | `DSH_HOME = %APPDATA%/营小商/dsh` |
| `dsh-session-projection` | 投影到业务表 | 同上 | 现有 SQLite 作业务投影 |
| `dsh-tools` | 工具注册/校验/派发/并发 | 同上 | **替代自研派发器** |
| `dsh-system-prompt` | 提示词装配（section/context 注册） | 同上 | 替代 `env()` 手拼 |
| `dsh-skill` + `dsh-skill-filesystem` + `dsh-tool-skill` | skill 发现与加载 | 同上 | `includeDefaultRoots:false` + `bundledSkillDir` |
| `dsh-token-meter` + `dsh-compaction-basic`（+ `-tool-result-pruner`） | 上下文压力与压缩 | 同上 | 替代自写字符预算 |

## 二、不挂（明确不搬）

| 不挂 | 原因 |
|---|---|
| `dsh-base` / `dsh-sdk-minimal` 整套 profile | 含编码助手人格、个人 skill 根、shell、subagent、goal、强制续行（审计 §4.3「明确不搬」） |
| subagent / goal / stop-hook 续行 | 与 R01 单一说话人冲突 |
| shell、通用文件系统、浏览器、MCP | 审计 §2.3 非目标；产品只需要领域工具 |
| 遥测、账号、云端 settings | 与 R17「本地数据」冲突 |
| CLI（`@deepseek-ai/dsh`） | 依赖 `node-pty` 原生编译（A0 实测卡住）；产品不需要 CLI |

## 三、挂载顺序（B 轮照这个顺序试）

```text
scope → session → session-persistence(jsonl) → session-projection
   → tools → system-prompt → llm(+deepseek, api-key) → agent → agent-loop
```

理由（A3 实测约束）：**只有通过句柄获取的会话才持久化**，而获取点是 `agent-loop`。
所以持久化与投影必须先于 loop 就绪；loop 是最后一个启动的。卸载按逆序，`close()` 会先排空再释放。

## 四、三类代码的命运

| 类别 | 文件 | 处理 |
|---|---|---|
| **删除** | `packages/agent/src/tool-loop.ts`、`tool-result-pruner.ts`、`dsml.ts`（文本解析旁路） | 随原生 loop/tools 切换删除，**不留 fallback**（审计 §4.3.2） |
| **改造** | `team.ts`（装配 → 原生组件注册）、`index.ts`（会话归属与投影）、`main/llm.ts`（SSE → 原生 provider）、`prompts.ts`（→ system-prompt section）、`tools/*`（→ dsh-tools 声明）、`App.tsx`（事件映射、不撤字） | 保留业务语义，换实现 |
| **不动** | `pipeline/`、`data/`、`packages/db`、`packages/questions` 的判分与入库、`packages/knowledge`、`packages/news`、`packages/artifacts` 的领域服务 | 数据最值钱，一行不动 |

## 五、B 轮的验收标准（写死，防止含糊）

1. 在 Electron 里真实跑通一次：`send → 流式返回 → 自然结束`，**没有固定限轮、没有强制收口**。
2. 带一个真实工具（如 `read_kp`）跑通一次 `tool_use → 执行 → 继续 → end_turn`。
3. 取消：点停止后不再发新请求、不再起新工具，已显示文字保留。
4. 重启后能 resume 同一会话。
5. 事件能到界面：`started / stream / tool start / tool end / terminal`，`terminal` 恰好一次。

## 六、未验证（B 轮要顺手确认）

| 项 | 为什么没结论 |
|---|---|
| Messages 端点与 chat/completions 的限流、计费是否一致 | 只做了单次调用（A2） |
| 原生 provider 的流式增量粒度 | 只测了非流式 |
| `dsh-tools` 与领域工具现有 `ToolSpec` 的形态差异 | 未读实现，只读了 README |
| `bundledSkillDir` 在 electron-builder 产物里能否读到 | 需真实打包（A4 已列为 B 轮验证） |
| 与现有 `learning.db` 的投影映射工作量 | 未评估，等 B3 建图 |

## 七、结论

**可行**。两条曾经可能致命的风险都已排除：

- 协议：不用适配层（A2 实测）
- 包：不用重新下载，只补声明（A1 修正后）

剩下的都是「按顺序挂、按契约改」的工程量，没有方向性未知。
