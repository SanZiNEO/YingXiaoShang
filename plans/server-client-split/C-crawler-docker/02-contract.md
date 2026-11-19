# C · 采集服务 Docker 化 · 契约

> 轮次：C · 采集服务 Docker 化
> 文档角色：02-contract
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1（§10.1 端口、§10.2 环境变量、§10.3 数据目录、§10.4 镜像/compose 命名；本文件只细化，不改端口、不改变量名）
> 一句话：compose 服务字段、卷/网络命名、环境变量、健康判据、写表边界、脚本退出码全部在此写死，实现与验收照这份对。

## 1 契约总览

| 层 | 冻结（冻结文件） | 本轮细化 |
|---|---|---|
| 镜像名 / build context | §10.4：采集镜像 `yxs-crawler:local`，context=`services/news-crawler-py`；服务端镜像 `yxs-server:local`，context=仓库根，dockerfile=`apps/server/Dockerfile` | 镜像内用户、入口命令、健康检查配置（§2、§4） |
| 端口 / 网络别名 | §10.1：采集 8787；服务端经 `http://crawler:8787` 访问 | compose 端口映射、`yxs-net` 内服务别名（§2、§5.2） |
| 环境变量 | §10.2：`LEARNING_AGENT_HOME`、`NEWS_CRAWLER_DB`、`NEWS_CRAWLER_BASE_URL` 等冻结名 | 每个变量的默认值、谁在 compose 里设、代码读取点（§3.2） |
| 数据目录 | §10.3：容器内 `/data/data/learning.db`，双层 `data/` 为故意布局 | 卷挂载点、伴随 `-wal`/`-shm`、采集不写的子目录（§3.3） |
| compose 命名 | §10.4：project `yxs`、网络 `yxs-net`、卷 `yxs-data`→`/data`、profiles `crawler`/`full` | 验收隔离后缀 `-c` 的容器名/卷名（§3.1） |
| 采集写表 | README 原文：只写 `news_articles` / `source_runs` / `news_tags` | 每张表的动作类型与禁区清单（§3.4） |

**契约稳定性**：本文件出现的 compose 服务名、卷名、网络名、环境变量名、健康检查判据、脚本退出码视为 v1 冻结。新增环境变量或新增写表对象属于破坏性变更，必须先升冻结文件版本；compose 文件后续可补注释，但字段取值不得与本表冲突。compose 服务段的字段组织遵循官方 Compose 服务定义 [R1]。

**边界声明**：服务端服务段在 compose 中只做引用——镜像名、build 声明按冻结 §10.4 写，服务端 Dockerfile 与运行时配置归 A 轮；C 不定义服务端的业务端点、鉴权与指标。

## 2 Compose 服务字段级契约

### 2.1 顶层字段

| 字段 | 冻结值 | 说明 |
|---|---|---|
| `name`（project） | `yxs` | 验收实验 project 用 `yxs-c`，避免与历史容器/卷混在同一 project（`02-ownership-and-parallel.md` §3） |
| `networks.yxs-net` | `driver: bridge` | 不接外部网络；跨容器通信只走服务名别名 |
| `volumes.yxs-data` | `external: false`，挂载到 `/data` | 验收卷名 `yxs-data-c`；禁止声明 `external: true` 后由人手建卷 |

### 2.2 `crawler` 服务（C 轮自有镜像）

| 字段 | 冻结值 / 写法 | 说明与约束 |
|---|---|---|
| `image` | `yxs-crawler:local` | 标签固定 `:local`，不推远端仓库（冻结 §10.4） |
| `build.context` | `services/news-crawler-py` | Python 服务自包含，不依赖 pnpm workspace；context 不给仓库根 |
| `build.dockerfile` | `Dockerfile` | 相对于 context；文件归 C 写权 |
| `container_name` | 生产 `yxs-crawler`；验收 `yxs-crawler-c` | 容器名带 `-c` 后缀做验收隔离，与生产名区分 |
| `profiles` | `["crawler", "full"]` | `crawler` 档只起采集，可独立验收；`full` 档与服务端同起 [R2] |
| `ports` | `["8787:8787"]` | 宿主映射仅供手工排查；容器间访问走 `yxs-net` 别名，不经宿主端口 |
| `volumes` | `["yxs-data:/data"]`（验收 `yxs-data-c:/data`） | 唯一挂载点；不挂宿主真实数据目录 |
| `environment` | 见 §3.2 表 | 变量名与默认值不得超出冻结 §10.2 与本节清单 |
| `healthcheck.test` | `["CMD", "python", "/app/scripts/healthcheck.sh"]` | 脚本判据见 §4.1；镜像内不假设存在 `curl` |
| `healthcheck.interval` | `30s` | 周期性探活间隔 |
| `healthcheck.timeout` | `5s` | 单次探活超时；超时按失败计 |
| `healthcheck.retries` | `3` | 连续 3 次失败才标记 `unhealthy`，抑制单次抖动 |
| `healthcheck.start_period` | `20s` | 启动宽限期：期内失败不计入重试计数 |
| `depends_on` | 无 | 采集不依赖服务端；`crawler` profile 下服务端容器根本不创建 |
| `restart` | `unless-stopped` | 崩溃自动重启；被人手 `stop` 后不自动拉起 |
| `networks` | `["yxs-net"]` | 服务名 `crawler` 即网络内别名，服务端用它寻址 |
| `command` / 入口 | `news-crawler serve --host 0.0.0.0 --db "${NEWS_CRAWLER_DB}"` | 入口复用现有 `serve` 子命令（`cli.py:189-206`）；host 必须显式覆盖为 `0.0.0.0` |

### 2.3 `server` 服务（引用 A 轮产物，C 不写其 Dockerfile）

| 字段 | 冻结值 / 写法 | 说明与约束 |
|---|---|---|
| `image` | `yxs-server:local` | 只按冻结镜像名引用；C 不保证该镜像在并行期已存在 |
| `build.context` | `.`（仓库根） | 声明性写出，供 A 轮镜像构建；理由见冻结 §10.4（workspace 包必须随 context 拷入） |
| `build.dockerfile` | `apps/server/Dockerfile` | 文件归 A 所有；C 不创建、不改写 |
| `container_name` | 生产 `yxs-server`；验收 `yxs-server-c` | 与采集容器同样的 `-c` 隔离规则 |
| `profiles` | `["full"]` | 只在全量档起；`crawler` 档不得创建该容器 |
| `ports` | `["8080:8080"]` | 冻结 §10.1 服务端端口 |
| `volumes` | `["yxs-data:/data"]`（验收 `yxs-data-c:/data`） | 与采集共用同一份卷、同一份主库 |
| `environment` | `YXS_SERVER_PORT=8080`、`YXS_DB_PATH=/data/data/learning.db`、`NEWS_CRAWLER_BASE_URL=http://crawler:8787` | 变量名归冻结 §10.2；取值默认由 A 契约细化，C 不新增服务端变量 |
| `depends_on` | `crawler: { condition: service_healthy }` | 等采集健康后再起服务端；不用 `condition: service_started` [R1] |
| `restart` | `unless-stopped` | 与采集一致 |
| `networks` | `["yxs-net"]` | 与采集同一网络，别名互通 |

### 2.4 不在 compose 里声明的项

- 不声明 `deploy.replicas`、负载均衡、外部反代；采集是单进程调度模型（`service.py:162-178`）。
- 不声明 PostgreSQL 服务；D/G 轮的 PG 编排各自独立，端口 55432/55433 与本轮不重叠。
- 不声明日志驱动、卷驱动、secret/key 管理；这些属后续部署层。

## 3 数据结构与命名

### 3.1 命名对照表（生产 / 验收隔离）

卷、网络、容器名的命名与挂载方式遵循 Compose 服务定义的资源模型 [R1]；验收隔离后缀只改变实验资源名，不改变生产命名口径。

| 类型 | 生产名 | 验收名（`-c` 后缀） | 冻结依据 |
|---|---|---|---|
| project | `yxs` | `yxs-c` | 冻结 §10.4；`02-ownership-and-parallel.md` §3 |
| 网络 | `yxs-net` | `yxs-net-c`（随验收 project 派生） | 冻结 §10.4 |
| 数据卷 | `yxs-data` | `yxs-data-c` | 冻结 §10.4；验收不得覆盖生产卷 |
| 采集容器 | `yxs-crawler` | `yxs-crawler-c` | 本节 §2.2 |
| 服务端容器 | `yxs-server` | `yxs-server-c` | 本节 §2.3 |
| 采集镜像 | `yxs-crawler:local` | 同 tag（镜像不按验收改名，避免重复构建） | 冻结 §10.4 |
| 服务端镜像 | `yxs-server:local` | 同 tag | 冻结 §10.4 |

### 3.2 环境变量表（与冻结 §10.2 一致）

| 变量 | 默认值 | 谁设 | 用途 | 代码读取点 / 备注 |
|---|---|---|---|---|
| `LEARNING_AGENT_HOME` | `/data` | compose `crawler` / `server` 服务 environment | 数据根目录；容器内布局按此派生 | 冻结 §10.2；桌面端口径见 `docs/requirements/R17-local-data.md:40` |
| `NEWS_CRAWLER_DB` | `/data/data/learning.db` | compose environment；`.env.example` 给样例 | 采集 SQLite 主库路径 | 现状代码经 `--db` 参数解析（`cli.py:261-263`），入口命令把该 env 映射为 `--db`；不假设代码已直读此 env |
| `NEWS_CRAWLER_HOST` | `0.0.0.0` | compose environment | 控制面监听地址；代码默认 `127.0.0.1`，容器内必须覆盖 | `cli.py:309-310` |
| `NEWS_CRAWLER_PORT` | `8787` | compose environment | 控制面端口 | `cli.py:313-315`；冻结 §10.1 |
| `NEWS_CRAWLER_WORKERS` | `8` | env 可选，不配则用代码默认 | 跨源并发槽位数 | `service.py:37`、`:91` |
| `NEWS_CRAWLER_BASE_URL` | 网络内 `http://crawler:8787`；宿主直连兜底 `http://127.0.0.1:8787` | `server` 服务 environment | 服务端调用采集侧车的基址 | 冻结 §10.1 网络别名；§10.2 宿主默认值 |
| `YXS_SERVER_PORT` | `8080` | `server` 服务 environment（A 所有） | 服务端监听端口 | 冻结 §10.1；C 只引用不实现 |
| `YXS_DB_PATH` | `/data/data/learning.db` | `server` 服务 environment（A 所有） | 服务端主库路径 | 冻结 §10.2；与采集同库 |

约束：`.env.example` 只列上表变量并给默认样例；不在 compose 中写死 API Key、口令等敏感值；`DEEPSEEK_API_KEY` 等 A 侧变量不在本轮样例中出现。

### 3.3 容器内数据目录布局

卷 `yxs-data` 挂到 `/data`，目录结构沿用桌面端既有布局（`docs/requirements/R17-local-data.md:47-56`），双层 `data/` 是故意保留的口径：

```text
/data/                              # LEARNING_AGENT_HOME（卷挂载点）
  data/
    learning.db                     # 业务主库（采集与服务端共用）
    learning.db-wal                # WAL 日志，随库同目录持久化
    learning.db-shm                # 共享内存索引，随库同目录持久化
  artifacts/<studentId>/<YYYY-MM>/ # 服务端产物目录；采集不写
  exports/                         # 服务端导出目录；采集不写
```

镜像内布局：代码 COPY 到 `/app`，Python 包 `news_crawler` 安装进运行环境；脚本位于 `/app/scripts/`（`run-round.sh`、`healthcheck.sh`）。镜像层内不放置数据库文件；所有运行期写入只发生在 `/data` 卷内。

### 3.4 写表清单与「不写别的表」约束

采集进程对主库的全部写动作限定如下：

| 表 | 动作 | 证据 |
|---|---|---|
| `news_articles` | upsert：按 `url` 唯一索引插入或更新；`content_hash` 相同只刷新 `fetched_at`，变化时更新正文并清旧草稿 | `db.py:25-31`；`output.py:90-99` |
| `source_runs` | 每源每轮插入一行统计（`trigger` ∈ `schedule`/`manual`/`bench`） | `db.py:38-52`；`db.py:110-115` |
| `news_tags` | 仅删除：正文变化时清除该文章 `review_status='draft'` 的草稿标签行；不向 `news_tags` 插入标签 | `output.py:74-88`；表结构见 `packages/db/src/index.ts:149-154` |

**禁区**：

- 其余业务表（`chapters`、`sections`、`knowledge_points`、`content_blocks`、`ideology_points`、`ideology_tags`、`case_matches`、`questions`、`question_kps`、`question_attempts`、`student_profiles`、`growth_records`、`evidence`、`chat_sessions`、`chat_messages`、`memory_facts`、`memory_episodes`、`artifacts`、`turns`、`learning_states` 等，清单见 `packages/db/src/index.ts:92-436`）采集不得 `CREATE` / `INSERT` / `UPDATE` / `DELETE`。
- `case_matches`、`ideology_tags` 只在现有草稿清理逻辑触发时被删除（`output.py:74-88`），采集不新建这两类行。
- `auth.db` 归 A 轮所有（冻结 §3.4），采集镜像不挂载、不打开、不建该库。
- 采集不在卷内创建第二份 SQLite 文件；JSONL 调试输出默认关闭，`--output` 只在手工排查时临时使用。

## 4 健康检查命令与错误失败码

### 4.1 健康检查（compose `HEALTHCHECK`）

判据来源是现有 `GET /health` 控制面（`http_api.py:127-128`、`:174-183`），不另写业务探活逻辑：

| 项 | 契约值 |
|---|---|
| 探测目标 | `http://127.0.0.1:8787/health`（容器内回环） |
| 成功条件 | HTTP 200，响应体 JSON 可解析且顶层 `ok == true` |
| 失败条件 | 连接被拒 / 超时 / 非 200 /  body 非 JSON / `ok == false`，任一项即退出 1 |
| `healthcheck.sh` 入参 | 无参；地址与端口从 `NEWS_CRAWLER_HOST` / `NEWS_CRAWLER_PORT` 推导，默认 `127.0.0.1:8787` |
| `healthcheck.sh` 退出码 | `0` 健康；`1` 不健康 |
| 探测实现 | Python 标准库 `urllib.request`；镜像内不依赖 `curl` / `wget`（slim 基线不带） |

`healthcheck.sh` 输出一行状态到 stdout（如 `healthy source_count=16`），不写日志文件；探活细节参照官方镜像健康检查原型的做法 [R7]。compose 侧时间参数：`interval: 30s`、`timeout: 5s`、`retries: 3`、`start_period: 20s`（§2.2）。

### 4.2 控制面错误映射（沿用现状，不新增错误码）

| HTTP | `error` 字段 | 触发条件 | 证据 |
|---|---|---|---|
| 400 | `bad_request` | 请求体不是合法 JSON；`limit` 非整数；`url` 为空；`sources` 含未注册源 | `http_api.py:191-193`、`:221-225`、`:265-268`、`:233-236` |
| 404 | `not_found` | GET/POST 路径不在路由表 | `http_api.py:134-136`、`:156` |
| 422 | `ingest_failed` | 单条链接抓取：URL 非法或正文不足（`AdhocError`） | `http_api.py:279-285` |
| 502 | `ingest_failed` | 单条链接上游抓取异常 | `http_api.py:286-291` |
| 503 | `no_database` / `query_unavailable` | 未配置数据库；查询模块未安装 | `http_api.py:196-201`、`:330-341` |
| 500 | `internal` | 控制面未捕获异常（带 `message` 与限长 `trace`） | `http_api.py:137-147`、`:160-170` |

C 轮不为上述错误新增中文消息或新 code；响应字段名 `error` / `message` / `elapsed_ms` 保持现状。容器化只改变「进程在哪跑」，不改变错误语义。

### 4.3 脚本退出码（`run-round.sh`）

| 退出码 | 含义 | 对齐现有 CLI |
|---|---|---|
| `0` | 本轮至少一个源状态非 `failure`；结果已落 `source_runs` | `cli.py:128`、`cli.py:219` |
| `1` | 本轮全部源失败；脚本仍输出每源失败明细 | 同上 |
| `2` | 缺入库目标（未配置库路径 / sink 为空），未执行抓取 | `cli.py:118-121`、`:211-214` |
| `130` | 收到 `SIGINT` 被中断 | `cli.py:360-362` |

宿主 cron 与 `restart` 策略按退出码判断：`0` 记成功；`1` 记本轮失败但不自动重启容器；`2` 视为配置错误，需人工查 env 与卷挂载；`130` 视为正常中断，不计失败。

## 5 事件与运行序列

### 5.1 `crawler` 档启动序列（独立验收路径）

```text
docker compose -f services/deploy/compose.yml --profile crawler up -d
  1. 创建 yxs-net 网络与 yxs-data 卷（首次）；复用已有资源（非首次）
  2. 启动 crawler 容器：非 root UID 10001，工作目录 /app
  3. 入口命令：news-crawler serve --host 0.0.0.0 --db /data/data/learning.db
  4. start_period 20s 内启动服务与每源调度循环；期间探活失败不计重试
  5. 首次探活通过 → 容器状态 healthy；/health 返回每源 running/next_run_at/last/totals
```

此序列不创建 `server` 容器，不要求 `yxs-server:local` 镜像存在；这是 `crawler` profile 可独立验收的契约保证 [R2]。

### 5.2 `full` 档启动序列（采集 + 服务端）

```text
docker compose -f services/deploy/compose.yml --profile full up -d
  1. 网络、卷同上
  2. crawler 先启动并通过 healthcheck（service_healthy）
  3. server 在 depends_on 条件满足后启动，挂同一 yxs-net、同一 yxs-data 卷
  4. server 经 http://crawler:8787 调 /run（news.refresh）与 /query（新闻检索）
  5. 任一方 unhealthy：另一方按自身 restart 策略运行，不互相阻塞退出
```

### 5.3 cron 单轮执行序列

```text
*/30 * * * *  run-round.sh [--source ID ...]
  1. 解析 NEWS_CRAWLER_DB / NEWS_CRAWLER_PORT 等 env（缺省取 §3.2 默认）
  2. 执行单轮：news-crawler once [--source ID ...] --db "$NEWS_CRAWLER_DB"
     （或对运行中容器 POST /run，body {"sources": [...], "wait": true}，
      对应 http_api.py:213-248）
  3. 每源 run_round(trigger="manual")：取槽位 → 抓取 → upsert 文章 → 写 source_runs
  4. 逐源结果行输出到 stdout；结束后按 §4.3 退出码退出
```

- 调度节奏：cron 表达式 `*/30 * * * *`（每 30 分钟一轮），与桌面端 `LEARNING_AGENT_NEWS_REFRESH_MINUTES=30` 口径一致（`docs/requirements/R17-local-data.md:44`）。
- 脚本接口：参数 `--source ID` 可重复，省略则跑全部启用源；无其他子命令。
- 日志：每轮一行汇总 + 每源一行明细，全部 stdout/stderr；容器内不落日志文件 [R5]。
- 轮次可观测性：每轮结果以 `source_runs` 行落库；失败明细在 `failures` JSON 字段。cron 心跳/告警不在本轮实现，参照 cron 监控项目的轮次记录思路留待 F 轮 [R8]。

### 5.4 持久化序列（重启 / down 再 up）

```text
前置：记录 n = SELECT COUNT(*) FROM news_articles; 记录最新 source_runs 一行
  A. docker compose restart crawler
     → 容器重建，卷不卸载；启动后 n 不变，WAL 正常回放
  B. docker compose down（禁止 -v）
     → 容器与网络删除；yxs-data 卷保留，/data/data/learning.db 与 -wal/-shm 仍在
  C. docker compose up -d
     → 容器重新挂卷；n 不变；最新 source_runs 行可查
```

判据：A、C 两步后文章数与最近统计行与前置一致；若 `down` 使用 `-v` 导致卷删除，属违规操作，不在本契约允许范围内。

## 6 兼容与版本

- **镜像标签**：采集与服务端镜像固定 `:local` 标签；compose 不写远端仓库地址、不做镜像拉取（`pull_policy` 默认仅在镜像缺失时构建）。
- **变量兼容**：环境变量名只引用冻结 §10.2；本轮新增的 `NEWS_CRAWLER_HOST` / `NEWS_CRAWLER_PORT` / `NEWS_CRAWLER_WORKERS` 均为代码现有读取点（§3.2），不引入代码不认的变量。后续如需代码直读 `NEWS_CRAWLER_DB`，先走契约变更，不改 compose 默认行为。
- **控制面兼容**：`/health`、`/stats`、`/query`、`/run`、`/ingest` 五个端点及其响应形状沿用 `http_api.py` 现状；C 不新增端点、不改名响应字段。
- **桌面端兼容**：本机 `.venv` 开发路径与 Electron 自动拉起逻辑不变；compose 是独立的服务器部署形态，两者不共享进程、不共享宿主端口配置。
- **前向兼容**：`server` 服务段在 A 轮镜像未就绪时可被注释或跳过；`crawler` 档不解析 `yxs-server:local`。服务端后续补全 build 细节时，不得改动采集段的镜像名、卷名与端口。
- **版本规则**：compose 字段取值、卷/网络/容器命名、健康判据、退出码如需破坏性调整，先升冻结文件版本号并登记；新增可选 env、新增注释不算破坏性变更。compose 文件本身的字段演进以官方 Compose 仓库的版本兼容说明为准 [R6]，本轮不使用尚未稳定的实验字段。

## 7 契约测试映射（本轮自测编号）

| 编号 | 契约点 | 断言 | 对应 § |
|---|---|---|---|
| `CT-C-01` | 非 root 运行 | `docker inspect yxs-crawler-c` 的 `Config.User` 非空且不是 `root` / `0` | §2.2、§3.3 |
| `CT-C-02` | 镜像不含 Playwright | 镜像内 `pip list` 不出现 `playwright`；`pyproject.toml:13` 的 `browser` 额外组未安装 | §2.2、§1 |
| `CT-C-03` | 端口与探活 | 宿主 `curl http://127.0.0.1:8787/health` 返回 200 且 `ok:true` | §2.2、§4.1 |
| `CT-C-04` | 健康检查失败路径 | 停掉进程后连续 3 次重试内容器状态变 `unhealthy`；`healthcheck.sh` 退出 1 | §4.1 |
| `CT-C-05` | 卷持久化 | §5.4 三步后 `news_articles` 行数与最近 `source_runs` 行不变；`-wal`/`-shm` 在卷内 | §5.4、§3.3 |
| `CT-C-06` | 写表边界 | 一轮跑前后，禁区表（`chapters`、`questions`、`artifacts`、`chat_messages`、`memory_facts` 等）行数一致；新增行只出现在 `news_articles` / `source_runs`，`news_tags` 仅有草稿删除 | §3.4 |
| `CT-C-07` | env 到参数映射 | 容器进程命令行含 `--db /data/data/learning.db`；`NEWS_CRAWLER_HOST=0.0.0.0` 生效 | §3.2、§2.2 |
| `CT-C-08` | profile 隔离 | `--profile crawler` 启动后只有 crawler 容器；`--profile full` 后 crawler 与 server 都在，且 server 晚于 crawler healthy | §2.2、§2.3、§5.2 |
| `CT-C-09` | 脚本退出码 | 全成功一轮退出 0；故意去掉库路径跑一轮退出 2；退出码与 §4.3 表一致 | §4.3、§5.3 |
| `CT-C-10` | 镜像体积 | `docker images yxs-crawler:local --format "{{.Size}}"` 小于 400MB；实测值记入验收文档，不预设字节数 | §1 目标 6 |
| `CT-C-11` | 网络别名 | `full` 档下 server 容器内请求 `http://crawler:8787/health` 通；别名等于 compose 服务名 `crawler` | §2.3、§5.2 |
| `CT-C-12` | 卷可写 | 非 root 用户在 `/data/data/` 下创建并删除测试文件成功；目录属主与 UID 匹配 | §3.3、§2.2 |
| `CT-C-13` | cron 接口 | `run-round.sh --source <id>` 单源可跑；cron 文件表达式为 `*/30 * * * *`；脚本无参时退出码符合 §4.3 | §5.3 |

用例组织按「一个编号一条断言、失败原因写在断言文本里」的方式，便于验收报告直接指到契约点；多服务编排的对照形态可参考 Compose 官方仓库与示例集 [R6] [R10]。

## 参考

- [R1] Compose 服务定义（healthcheck / depends_on / volumes） — https://docs.docker.com/reference/compose-file/services/ — 支撑 §2 服务字段级契约与 §5.2 健康依赖条件 — 采用 `healthcheck` 段与 `condition: service_healthy`；不使用 `deploy.replicas`。
- [R2] Compose profiles — https://docs.docker.com/reference/compose-file/profiles/ — 支撑 §2.2 `crawler` / `full` 双档与 §5.1 独立验收 — 直接采用 profile 启停范围划分。
- [R3] Dockerfile 参考（USER / HEALTHCHECK / ENTRYPOINT） — https://docs.docker.com/reference/dockerfile/ — 支撑 §2.2 非 root 用户与镜像入口契约 — 采用专用非 root USER；不用多架构 `--platform`。
- [R4] Docker 官方 Python 镜像 — https://hub.docker.com/_/python — 支撑 §3.2 slim 基线与 §4.1 标准库探活可行性 — 采用 `python:3.12-slim`；镜像内保证存在 Python 解释器。
- [R5] 12-Factor · Logs — https://12factor.net/logs — 支撑 §5.3 脚本日志走 stdout、不落容器文件 — 采用事件流日志；不引入日志聚合服务。
- [R6] docker/compose — https://github.com/docker/compose — 支撑 §7 用例的多服务编排对照 — 借鉴服务/网络/卷的组织形态；不引入其 Go 工具链。
- [R7] docker-library/healthcheck — https://github.com/docker-library/healthcheck — 支撑 §4.1 探活命令选型 — 借鉴官方镜像探活原型；不引入独立探活侧车。
- [R8] healthchecks/healthchecks — https://github.com/healthchecks/healthchecks — 支撑 §5.3 轮次心跳与失败可观测思路 — 借鉴每轮记录概念；本轮不自建监控服务。
- [R9] Docker 多阶段构建 — https://docs.docker.com/build/building/multi-stage/ — 支撑 §3.3 镜像内布局与 CT-C-10 体积控制 — builder 与 runtime 分层；构建工具链不进最终镜像。
- [R10] full-stack-fastapi-template — https://github.com/fastapi/full-stack-fastapi-template — 支撑 §2.3 采集与服务端的编排分层对照 — 借鉴 compose 服务划分与健康依赖；不引入其前端容器与 JWT。
