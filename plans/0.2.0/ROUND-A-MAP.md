# A 轮派单：原生组合与兼容边界

> 建立时间：2026-11-03。依据：审计文档 §4.3、§4.3.1、§4.11 阶段 A。
> 本文件是 A 轮的唯一索引。**这一轮只核实事实，不改产品代码。**

## 〇、本轮口径

1. **只核实，不实施**：A 轮结束时产出的是一份「要挂哪些组件、怎么挂、哪里挂不上」的结论，不是代码。
2. **版本全钉死**：审计 §4.11 要求「固定匹配版本、验证真实导出」。不用 `^`、不用 `latest`。
3. **不整套搬**：`dsh-base` 全量配置不搬（审计 §4.3「明确不搬」）。
4. **协议先核实再换**：现有适配器走 `/chat/completions`，本地 example 的 `dsh-llm-deepseek` 走 Messages。**不核实清楚不许动 provider**。

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

| 编号 | 目标（一句话） | 验收 |
|---|---|---|
| A1 | 版本与可达性核对 | ☐ 上表 A1-1…A1-6 已核，缺的 9 个包确认同版本可装 |
| A2 | provider 协议核对：现有 `/chat/completions` 与 `dsh-llm-deepseek` 的 Messages 差异，以及所选模型是否支持 | ☐ 写清「能直接用原生 provider / 需要最小适配 / 不可行」三者之一，附端点和报文对照 |
| A3 | session 持久化与投影：`create/resume/close` 的调用条件、数据落在哪个目录 | ☐ 写清挂载顺序与离开顺序，以及和现有 `%APPDATA%/营小商` 的关系 |
| A4 | 产品资源根与打包：原生 skill filesystem 的 `includeDefaultRoots: false` + 自定义根在 electron-builder 下能否打进去 | ☐ 写清资源目录路径、打包产物里应出现的文件、缺失时怎么发现 |
| A5 | 挂载结论：一份「挂什么/不挂什么/为什么」清单 | ☐ 清单可直接被 B 轮照着实施，含被否方案与理由 |

## 四、待裁决（阻塞项）

1. **A2 若判定「需要最小适配」**：允许写多厚的适配层？审计只允许「范围明确的 provider 适配」，需要人定边界。
2. **A4 若原生 skill 根在打包后不可读**：退回自研 loader 与审计 §4.5.4「不补写平行实现」冲突，需要人裁决。
3. **参考仓库是否入库**：审计文档里 27 条链接指向 `example/`，而 `.gitignore:44` 排除了 `/example`，clone 后点不开（见 `pending-discussions.md` P-2）。

## 五、A 轮结束后应能回答

- 挂哪几个包、各什么版本、谁依赖谁？
- 一次对话从 UI 到模型再到写库，经过哪些原生服务、在哪个点拿到 turn 终态？
- 哪些现有代码会被删、哪些会被改、哪些一行不动？
- 有没有哪一条在 Electron/Node 环境根本走不通？
