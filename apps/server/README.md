# @yxs/server

营小商学习助手服务端：一个 Node 22 进程同时提供 HTTP RPC 单端点、5 个专用通道（对话 SSE / 取消 / 单题作答 / 交卷 / 健康检查）、Prometheus 指标与结构化日志。

契约口径见 `plans/server-client-split/00-master/01-frozen-contracts.md`；生成的 OpenAPI 文档在仓库根 `docs/contracts/openapi.yaml`。

## 目录

```text
apps/server/
  src/            服务端源码（路由、鉴权、RPC 注册表、通道、观测）
  scripts/        smoke / probe / 建学生 / 证据采集 / OpenAPI 生成与自检
  test/           node:test 单测（不联网、不起端口）
  docs/           偏差记录与 mutation 记录
  Dockerfile     多阶段非 root 镜像（build context = 仓库根）
```

## 前置条件

- Node `^22.19.0`，pnpm `11.28.5`
- 依赖在仓库根安装：`pnpm install`（workspace 会一并装好 `packages/*`）

## 本地跑起来

```powershell
cd <仓库根>

# 1) 准备隔离数据（不要用 .learning-agent 真实目录）
New-Item -ItemType Directory -Force .scratch\run\A\home\data | Out-Null
Copy-Item .scratch\sample-home\data\learning.db .scratch\run\A\home\data\learning.db -ErrorAction SilentlyContinue

# 2) 建测试学生（口令经 scrypt 哈希后存入 auth.db）
$env:LEARNING_AGENT_HOME = (Resolve-Path .scratch\run\A\home).Path
pnpm --dir apps/server exec tsx scripts/add-student.mjs `
  --id 20230001 --name 张三 --cohort 2023 --password abc12345

# 3) 起服务（mock 模型，断网可跑）
$env:YXS_LLM = 'mock'
$env:YXS_MOCK_SCRIPT = 'tools'
$env:YXS_MOCK_DELAY_MS = '120'   # 让取消/心跳有可观测量；纯 smoke 时可省略
$env:YXS_SERVER_PORT = '8080'
pnpm --filter @yxs/server dev
```

另开一个终端验证：

```powershell
curl.exe -s http://127.0.0.1:8080/health
pnpm --filter @yxs/server smoke
```

## 脚本

| 命令 | 作用 |
|---|---|
| `pnpm --filter @yxs/server dev` | tsx watch 起开发服务 |
| `pnpm --filter @yxs/server start` | 跑编译产物 `lib/index.js` |
| `pnpm --filter @yxs/server build` | `tsc -p tsconfig.json` 编译到 `lib/` |
| `pnpm --filter @yxs/server typecheck` | `tsc -p tsconfig.json --noEmit` |
| `pnpm --filter @yxs/server test` | `node --import tsx --test test/*.test.ts` |
| `pnpm --filter @yxs/server smoke` | 五步 smoke：登录 → 提问 → 出题 → 交卷 → 查档案 |
| `node scripts/probe-methods.mjs` | 30 方法 + 4 legacy 逐条打合法输入，输出 JSONL |
| `pnpm --filter @yxs/server gen:openapi` | 从注册表元数据生成 `docs/contracts/openapi.yaml` |
| `pnpm --filter @yxs/server check:openapi` | 自检 enum=30、5 通道、legacy=4、30 个 Result schema |
| `pwsh -File scripts/evidence.ps1` | 按 AC-A-01..A-21 采集证据到 `.scratch/run/A/evidence/` |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `YXS_SERVER_PORT` | `8080` | 监听端口（容器内 `0.0.0.0:8080`） |
| `LEARNING_AGENT_HOME` | 开发 `<repo>/.learning-agent`；容器 `/data` | 数据根目录 |
| `YXS_DB_PATH` | `<home>/data/learning.db` | 业务主库 |
| `YXS_AUTH_DB_PATH` | `<home>/data/auth.db` | 登录与 token（独立库，不进 packages/db） |
| `YXS_TEMPLATES_DIR` | 开发 `apps/desktop/templates`；容器 `/app/templates` | 产物模板目录，启动期校验存在 |
| `LEARNING_AGENT_PROMPTS_DIR` | `packages/agent` | 提示词目录（容器内 `/app/packages/agent`） |
| `YXS_LLM` | `mock` | `mock` 或 `deepseek` |
| `DEEPSEEK_API_KEY` | — | deepseek 模式的模型密钥 |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 模型名 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 模型网关 |
| `YXS_TOKEN_TTL_DAYS` | `7` | token 有效期（天） |
| `YXS_METRICS_TOKEN` | 空 | 非空时 `/metrics` 需要 Bearer 校验 |
| `YXS_CORS_ORIGINS` | 空 | 逗号分隔白名单；空表示不响应跨域 |
| `NEWS_CRAWLER_BASE_URL` | `http://127.0.0.1:8787` | 新闻侧车地址 |
| `YXS_NEWS_OFFLINE` | `0` | `1` 时新闻刷新直接返回上游失败 |
| `YXS_SEED_DB` | — | 业务库不存在时从该种子库复制 |
| `YXS_MOCK_SCRIPT` | 空 | `tools` 时 mock 脚本化产出题目集 |
| `YXS_MOCK_DELAY_MS` | `0` | mock 每个 chunk 的固定间隔（毫秒）。取消 / 心跳 / 断线验收需要非 0 值，例如 `120` |

## smoke 五步

1. **login**：学号 `20230001` / 口令 `abc12345`（可用 `YXS_SMOKE_STUDENT` / `YXS_SMOKE_PASSWORD` 覆盖），断言 token 长度 43。
2. **chat-greeting**：发「你好」，首帧 `session`、末帧 `done`、`text` ≥ 3 帧。
3. **question-set**：发「出两道题练习一下」，从 `done.artifacts` 找 `question_set`；题目 id 从 `artifact.content_json.questions[].id` 读取（真实 id 形如 `q_<hash>`，不硬编码）。
4. **answer-set**：用上一步读出的 id 交卷，断言 `status=completed`。
5. **readback**：`questions.attempts` 回读这些题，`profile.get` / `memory.facts` 查档案。

每步打印 `PASS <step>` 或 `FAIL <step>: 原因`，失败以非零码退出。`YXS_BASE_URL` 可覆盖目标地址。

## 证据采集

```powershell
pwsh -NoProfile -File apps\server\scripts\evidence.ps1
```

每条 AC 一个目录 `.scratch/run/A/evidence/<AC 编号>/`，含 `request.txt`、`response.json`、`status.txt`；脚本可重复执行，会覆盖旧证据。需要先按上面的步骤起好服务并建好测试学生。

脚本会消耗登录次数（上限 5 次/分钟），所以内部对 `429` 会等一个窗口再重试；`AC-A-16` 需要把服务端 stdout 重定向到文件并设 `YXS_LOG_FILE` 才有日志样本，`AC-A-19`/`AC-A-21` 在本机分别因为「没有 docker」「需要人工断网」记为 `skipped`。

## 契约测试（打真实 HTTP）

`tools/contract-tests` 是独立包，不参与 workspace 安装，直接用 node 跑：

```bash
# 服务端起在 18099（避开常驻的 8080）
LEARNING_AGENT_HOME=<隔离目录> YXS_LLM=mock YXS_SERVER_PORT=18099 \
  node --import tsx apps/server/src/index.ts

cd tools/contract-tests
node run.mjs --target http --base-url http://127.0.0.1:18099 \
  --student-id 20230001 --password <口令> --report report/<名字>
```

`E-071`（取消）需要 `YXS_MOCK_DELAY_MS=120` 让 mock 有可观测量，否则一轮流在毫秒内结束、`chat/cancel` 抢不到在途请求。`E-006`（`news.refresh`）需要 Python 侧车在线，否则按契约返回 502。

## RPC 超时

`/api/v1/rpc` 默认 10s，`news.refresh` 30s，`artifacts.export` 20s（冻结 §2）。超时返回 `504 TIMEOUT` + `这一步等太久了，已经停下，可以直接重试。`，并 `AbortController.abort()` 把 signal 交进 handler（`news.refresh` → `fetch`、`news.match` → matcher 的模型调用），不是只让 HTTP 提前返回。实现见 `src/rpc/timeout.ts`。

## 镜像

```powershell
docker build -f apps/server/Dockerfile -t yxs-server:local .
docker run --rm -p 8080:8080 -v yxs-data:/data yxs-server:local
```

多阶段构建：build 阶段装依赖并编译 `packages/*` 与 `apps/server`；runtime 阶段只带 `node_modules`、`packages`、`apps/server/lib` 与模板目录，以 UID/GID `10001` 运行，`HEALTHCHECK` 探 `/health`。

> 本机没有 docker 命令，镜像未实跑；详见 `docs/deviation-notes.md`。
