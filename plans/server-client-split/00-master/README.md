# 00 · 总索引与并行派发手册

> 本目录是 A–I 九轮的**唯一公共口径**。九轮文档全部从这里取契约、取文件写权、取参考链接。
> 任何一轮的文档与这里冲突，以这里为准；要改口径，先改这里并在本文末尾登记变更。

## 1. 这份 plan 要解决什么

营小商现在是「Electron 主进程里塞着全部业务」的单体结构：30 个业务方法、SSE 式流式、SQLite、新闻侧车、打包全部绑在桌面端。
本 plan 把它拆成「HTTP 服务端 + 瘦客户端 + 可运维的采集/迁移/压测/备份/测试工具链」，并额外给出小程序纯 mock 原型。

拆分后的目标形态：

```text
                ┌──────────────────────────┐
   小程序 mock ─┤                          │
   Electron  ───┤  apps/server (HTTP+SSE)  ├── packages/db (SQLite / 未来 PG)
   curl/测试 ───┤  30 methods + 5 channels ├── services/news-crawler-py (8787)
                └──────────────────────────┘
                       │            │
                 docs/contracts   /metrics + 结构化日志
```

## 2. 九轮清单与文档产出

每轮固定 **4 份文档 + 1 份轮次索引**（`README.md` 保留原样，作为「要做什么」的原始口径，不改写）：

| 轮次 | 目录 | 本轮文档 |
|---|---|---|
| A | `A-server-core/` | `01-scope.md` `02-contract.md` `03-implementation.md` `04-acceptance.md` |
| B | `B-news-quality/` | 同上 4 份 |
| C | `C-crawler-docker/` | 同上 4 份 |
| D | `D-pg-migration/` | 同上 4 份 |
| E | `E-contract-tests/` | 同上 4 份 |
| F | `F-loadtest-observability/` | 同上 4 份 |
| G | `G-backup-restore/` | 同上 4 份 |
| H | `H-electron-mutation/` | 同上 4 份 |
| I | `I-miniprogram-mock/` | 同上 4 份 |

四份文档的职责切分（**不要合并、不要改名**）：

| 文件 | 回答的问题 | 主要读者 |
|---|---|---|
| `01-scope.md` | 这一轮做什么、不做什么、写哪些文件、跟别轮怎么隔开 | 派任务的主代理 |
| `02-contract.md` | 精确到字段/状态码/事件序列/表结构的契约 | 实现者、契约测试 |
| `03-implementation.md` | 落到目录、模块、函数、命令、伪代码级的实现方案 | 实现者 |
| `04-acceptance.md` | 怎么算过：命令、期望输出、失败判据、证据、mutation | 验收者 |

## 3. 并行派发：为什么九轮能同时开工

这是本 plan 的硬验收条件。三条设计保证：

1. **契约先冻结**（[`01-frozen-contracts.md`](01-frozen-contracts.md)）：30 个方法、5 个专用通道、错误码、端口、环境变量、镜像名、表结构口径全部在本文档里写死。任何一轮都不需要「等 A 先出 OpenAPI」才能开工——A 负责把它落成 `docs/contracts/openapi.yaml`，E 负责核对，二者都以冻结表为准，互不阻塞。
2. **文件写权隔离**（[`02-ownership-and-parallel.md`](02-ownership-and-parallel.md)）：每一轮只写自己名下的路径，共享文件（`services/news-crawler-py/Dockerfile`、`docs/contracts/openapi.yaml`、`services/deploy/compose.yml`）明确单一 owner，其余轮次只读。
3. **运行期资源隔离**（同文件 §3）：端口、临时数据库副本、容器名、临时 home 全部按轮次分配，九轮并行跑测试不抢端口、不写同一份 `learning.db`。

## 4. 文档写作规范（每个写文档的子代理必须遵守）

见 [`04-doc-template.md`](04-doc-template.md) 与 [`05-writing-brief.md`](05-writing-brief.md)。硬规则摘要：

- 每份文档 **≥ 7 个二级标题**，且必须包含「目标 / 非目标 / 真实依据 / 细化需求 / 契约 / 实现 / 验收 / 并行边界 / 参考」中的对应节。
- **每一个二级节至少出现 1 个外部参考标记** `[Rn]`，全篇 ≥ 8 个不同参考。
- 文档末尾必须有 `## 参考` 节，列出 `[Rn] 标题 — URL — 用来支撑哪一节 — 借鉴了什么/不照搬什么`。
- 引用本项目代码必须写 `路径:行号`（如 `apps/desktop/src/main/index.ts:203-393`），且行号必须真实存在。
- 禁止「TODO / 待补 / 略 / 后面再说」；写不出细节就写「未知与风险」，并给出验证方法。

## 5. 质量闸门（机器可查）

```powershell
# 在仓库根目录
python plans\server-client-split\00-master\check-docs.py
```

它检查：文档存在性、节数、每节是否带 `[Rn]`、参考节是否有 ≥5 条 URL、`路径:行号` 引用是否指向真实文件与真实行号、是否残留占位词。
**退出码必须为 0**，否则该轮不算交付。脚本自检输出要贴进 `04-acceptance.md` 的「验收证据」一节。

## 6. 用这套文档派任务（给主代理的操作步骤）

1. 读 [`01-frozen-contracts.md`](01-frozen-contracts.md) 与 [`02-ownership-and-parallel.md`](02-ownership-and-parallel.md)。
2. 取目标轮次的 `01-scope.md` + `02-contract.md` + `03-implementation.md` + `04-acceptance.md` 作为该轮提示词的正文。
3. 一轮派 2–3 个子代理：契约/方法一个、实现一个、验收/证据一个；每个子代理拿到的是同一轮的 4 份文档，但**只被要求负责其中一段**，避免重复劳动。
4. 九轮可以同一时刻全部派出，不需要串行等待。

## 7. 变更登记

| 日期 | 版本 | 改了什么 | 影响轮次 |
|---|---|---|---|
| 2026-11-19 | v1 | 首版：冻结 30 方法表、5 通道、错误码、端口、文件写权 | A–I |
| 2026-11-19 | v1.1 | A 轮四件套写完并通过 `check-docs.py --round A`（1063 行），作为其余八轮的质量基线；`check-docs.py` 的本地引用校验改为「只校验带行号的引用」，避免把产物清单里的待建文件判成错误 | A–I |
