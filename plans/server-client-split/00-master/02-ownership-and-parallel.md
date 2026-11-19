# 02 · 文件归属与并行隔离

> 目的：九轮在**同一时刻**开工，不互相等、不互相踩。本文回答三件事：谁写哪个路径、谁独占哪个运行时资源、撞车时按什么规则裁决。

## 1. 文件写权矩阵

「写」= 本轮可以新建/修改；未列出的路径一律**只读**（可以读、可以 import、可以跑，但不许改一个字符）。

| 路径 | 唯一 owner | 允许新建 | 说明 |
|---|---|---|---|
| `apps/server/**` | **A** | 全部 | 服务端代码、Dockerfile、scripts、tests、README |
| `docs/contracts/openapi.yaml` | **A** | 是 | 契约产物，E 只读 |
| `.dockerignore`（仓库根） | **A** | 是（仅当不存在） | 服务端构建用；不得删除已有条目 |
| `pnpm-lock.yaml`、`package.json`（仓库根） | **A** | 只允许 `pnpm install` 产生的变更 | 因为 `apps/server` 进 `apps/*` workspace；其余轮次禁止跑根 `pnpm install` |
| `services/news-crawler-py/scripts/quality_report.py` | **B** | 是 | 只读新闻库的抽检脚本 |
| `services/news-crawler-py/docs/**` | **B** | 是 | `news-source-quality.md`、`quality-report.sample.json` |
| `services/news-crawler-py/Dockerfile`、`.dockerignore` | **C** | 是 | 采集镜像 |
| `services/deploy/**` | **C** | 全部 | compose、`.env.example`、cron、`run-round.sh`、`healthcheck.sh` |
| `tools/migrate-pg/**` | **D** | 全部 | 迁移工具，独立包 |
| `tools/contract-tests/**` | **E** | 全部 | 契约测试，独立包 |
| `tools/loadtest/**` | **F** | 全部 | 压测工具，独立包 |
| `tools/backup/**` | **G** | 全部 | 备份/恢复/演练，shell + lib |
| `tools/automated-testing/mutations/**` | **H** | 全部 | 5 个 patch + 说明 |
| `tools/automated-testing/scripts/run-mutation.ps1` | **H** | 是 | 应用/还原/断言 |
| `tools/automated-testing/mutation-report.md` | **H** | 是 | 报告与 31 条证据索引 |
| `tools/miniprogram-mock/**` | **I** | 全部 | 静态 5 页 + fixtures |
| `packages/**` | 无人 | **禁止** | 只读引用 |
| `apps/desktop/**` | 无人 | **禁止**（H 的临时 patch 例外，见 §5） | 桌面端保持可运行 |
| `docs/**`（除 `docs/contracts`） | 无人 | **禁止** | 需求文档不是本轮产物 |

**约定冲突**：如果某个轮次认为自己必须改一个不归它管的文件，正确做法是**在自己的 `01-scope.md` 里写「需要 owner 配合的变更」**并给出精确 diff 建议，而不是直接改。派任务时由人决定是否合并。

## 2. 为什么这样切不会互相破坏

| 潜在冲突 | 处理 |
|---|---|
| A 和 C 都要 Docker | A 只写 `apps/server/Dockerfile` + 根 `.dockerignore`；C 只写采集 `Dockerfile` + `services/deploy/compose.yml`。compose 通过冻结镜像名引用 A，不读 A 的文件内容。 |
| A 和 E 都要 OpenAPI | A 生成并拥有 `openapi.yaml`；E 只读，缺失时按冻结表核对并标 `pending`（`01-frozen-contracts.md` §8）。 |
| A 和 F 都要 `/metrics` | 指标名与桶在 §9.2 冻结；A 负责实现，F 只负责抓取、汇总、写告警规则，不改服务端。 |
| C 的 `.dockerignore` 会不会排掉 B 的脚本 | B 的 `quality_report.py` 是**宿主侧运维脚本**，镜像不 COPY `scripts/`；因此 C 排除 `scripts/` 是安全的，且必须写进 C 的 `03-implementation.md`。 |
| D 和 G 都要 PostgreSQL | 端口分配不同（D=55432，G=55433）；D 只读 `learning.db`，G 只做备份产物；互不写对方库。 |
| D 改不改运行时 SQL 方言 | 不改。`packages/db` 里 SQL 仍是 SQLite 方言；D 只在迁移工具内部做映射（`plans/server-client-split/D-pg-migration/README.md` 原文要求）。 |
| H 的 patch 会不会弄坏 E 的 electron 目标 | **互斥锁**，见 §4 与 §5。 |
| E/F 都要起服务端 | E 的 http 目标需要 A 在跑；并行期可先用 `--target stub`（E 自带）与 F 的 mock 目标；真机联调是**可选加跑**，不是开工前置。 |
| 各工具包都改根 lockfile | 新工具目录都在 `tools/` 下，**不在** `pnpm-workspace.yaml` 的三条 glob（`packages/*`、`profiles/*`、`apps/*`）里，所以各自 `pnpm install --ignore-workspace`、各自 lockfile，根 lockfile 只被 A 碰。 |

## 3. 运行期资源分配（九轮并行不抢资源）

| 轮次 | 端口 | 临时数据 | 容器/进程名 | 安装目录 |
|---|---|---|---|---|
| A | `8080`（`YXS_SERVER_PORT` 可改） | `.scratch/run/A/home/`（内含 `data/learning.db` 副本） | — | `apps/server`（根 workspace 内） |
| B | 无 | `.scratch/run/B/home/`（**只读**打开副本，禁止写库） | — | 复用仓库 `.venv` |
| C | `8787`（crawler），compose 内 `8080/5432` | 命名卷 `yxs-data`；验收另用 `yxs-data-c` | `yxs-crawler-c`、`yxs-server-c` | 无（镜像构建） |
| D | `55432`（PG） | `.scratch/run/D/learning.db`、`d_pg` 容器 | `yxs-pg-d` | `tools/migrate-pg` 本地 `pnpm install --ignore-workspace` |
| E | 随机空闲端口（`allocatePort` 风格） | `.scratch/run/E/home-*/` | — | `tools/contract-tests` 同上 |
| F | `18080`（被测服务/stub） | `.scratch/run/F/home/` | — | `tools/loadtest` 同上 |
| G | `55433`（PG） | `.scratch/run/G/`、`g_pg` 容器、`g_backups/` | `yxs-pg-g` | `tools/backup` 无 Node 依赖 |
| H | 由 Playwright 分配 | `.scratch/run/H/` | Electron 进程 | 复用 `tools/automated-testing` 现有 `node_modules` |
| I | 无（静态文件） | 无 | — | 无 |

**硬规则**：

- 任何轮次**不得**写用户的真实数据目录（`%APPDATA%`、`~/.learning-agent`、`<repo>/.learning-agent`）。要动库，先复制到 `.scratch/run/<轮次>/`。
- 任何轮次**不得** `docker compose down -v`；只能 `down`（保卷），且只用自己 project 名（`yxs` 之外的实验用 `yxs-c`）。
- 任何轮次**不得**删除 `.scratch/` 下别人的目录。
- 端口占用时按 `+100` 递增退避（8080 → 8180 → 8280），并在报告里写明实际端口。

## 4. 每轮的独立开工条件与完成定义

| 轮次 | 独立开工只需要 | 完成定义（DoD） |
|---|---|---|
| A | 本文件 + A 的 4 份文档 + `apps/desktop/src/main/index.ts` | `pnpm --dir apps/server typecheck` 通过；`smoke.mjs` 五步全绿（mock LLM）；`openapi.yaml` 覆盖 30 + 5；`/metrics` 有 §9.2 全部指标名；Dockerfile 可 `docker build` |
| B | 本文件 + B 文档 + 一份 `learning.db` 副本 | `quality_report.py` 跑两次输出字节一致（除时间戳字段）；报告含最差 5 源；JSON 通过 schema 自检 |
| C | 本文件 + C 文档（不需要 A 已完工） | `docker compose --profile crawler up -d` 健康；重启容器数据仍在；镜像 < 400 MB；`down` 后再 `up` 数据仍在 |
| D | 本文件 + D 文档 + SQLite 副本 | `migrate` 跑两遍行数不变（幂等）；`verify` 不一致时非零退出并打印第一处差异；`rollback` 默认 dry-run |
| E | 本文件 + E 文档 + 冻结表 | `coverage` 对冻结表 30+5 全绿；每个方法 ≥2 条用例；3 条 mutation 能让用例变红；`--target stub` 自洽可跑 |
| F | 本文件 + F 文档 + stub 目标 | 40/60 并发跑完输出 P50/P95/P99 与按学生 token；`alerts.yml` 能被 `promtool check rules` 通过 |
| G | 本文件 + G 文档 | `drill.sh` 完成「备份→真删→恢复→校验」并产出报告；SQLite 用 `.backup`/`VACUUM INTO` 而非 `cp` |
| H | 本文件 + H 文档 + 31 条用例可跑 | 5 个 patch 各自「红→还原→绿」；报告含命令与失败输出；`git status` 对 `apps/desktop`、`packages` 为空 |
| I | 本文件 + I 文档 | 5 页可 `index.html` 直接打开互跳；375px 无横向滚动；全部数据来自 `fixtures/*.json`，无网络请求 |

## 5. 撞车裁决与互斥

1. **文件被非 owner 修改**：owner 轮次在自己的 `04-acceptance.md` 记录「外部改动」并重新验证；不得擅自回滚别人的改动，交由人裁决。
2. **契约冲突**：以 `01-frozen-contracts.md` 为准；若实现确实做不到，写「契约例外申请」到该轮 `01-scope.md`，列明原因、影响轮次、替代方案。
3. **Electron 互斥锁**（H 与 E 的 electron 目标）：
   ```powershell
   # 原子创建目录作为锁；已存在说明有人在用
   New-Item -ItemType Directory -Path ".scratch\run\electron.lock" -ErrorAction Stop
   # 用完删除
   Remove-Item -LiteralPath ".scratch\run\electron.lock"
   ```
   拿不到锁：退避重试 30s（每 2s 一次），仍失败则跳过并在报告写明「未取得 electron 锁，本轮 electron 目标未执行」。
   **禁止**用 `git stash` 清场来抢锁。
4. **端口冲突**：按 §3 的 +100 退避；不得 kill 不明进程。若占用者是自己的历史进程，先记录 PID 再停。
5. **镜像/容器名冲突**：实验用 `-c`/`-d`/`-g` 后缀区分；生产名只有一份。

## 6. 九轮并行时间线

```text
day0  ├─ A ──────────────────────────────┐
      ├─ B ────────────────────┐          │
      ├─ C ────────────────────────┐      │
      ├─ D ──────────────────────────┐    │
      ├─ E ────────────────────────────────┤   （stub 目标先行，真机联调可选）
      ├─ F ────────────────────────────┐   │
      ├─ G ──────────────────────────────┐ │
      ├─ H ────────────────────────────────┤   （electron 锁）
      └─ I ────────────────┘              │
                                        merge 验收
```

没有任何一条边是「必须等 X 完成」。E 与 F 需要「活的服务端」时，用各自内置 stub 或 A 的 `YXS_LLM=mock` 实例；这是**加跑**，不是开工条件。
