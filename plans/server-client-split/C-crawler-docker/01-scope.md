# C · 采集服务 Docker 化 · 范围与边界

> 轮次：C · 采集服务 Docker 化
> 文档角色：01-scope
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1（§10.1 端口、§10.2 环境变量、§10.4 镜像/compose 命名）
> 写权：[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1、§3
> 一句话：把现有 Python 采集服务打成非 root 的 `yxs-crawler:local` 镜像，用一份 compose 编排「采集 + 服务端 + 命名卷 + 健康检查」，`--profile crawler` 不依赖服务端也能独立验收。

## 1 目标

1. **采集服务可容器化构建**：以 `python:3.12-slim` 为基础镜像，只安装运行时依赖 `httpx / beautifulsoup4 / lxml`，镜像不含 Playwright 浏览器内核 [R1]。
   判断标准：`docker compose -f services/deploy/compose.yml --profile crawler build` 成功；镜像内 `pip list` 不出现 `playwright`；`docker image inspect yxs-crawler:local` 的 `Config.User` 为非 root 账号。
2. **双档 compose 可独立验收**：`profiles: [crawler]` 只起采集服务（含 HTTP 控制面与健康检查）；`profiles: [full]` 起采集 + 服务端。两档共用同一网络与数据卷 [R5]。
   判断标准：`docker compose --profile crawler up -d` 后 `curl http://127.0.0.1:8787/health` 返回 `ok:true`；`--profile full` 时服务端可经 `http://crawler:8787` 访问采集侧车。
3. **非 root 运行 + 容器内健康检查**：进程以专用 UID 运行，`HEALTHCHECK` 周期性请求 `/health`，不健康时容器进入 `unhealthy` 状态 [R2]。
   判断标准：`docker inspect` 中健康检查配置存在；连续三次探活失败后状态变为 `unhealthy`；容器内 `id` 输出不是 `root`（UID 0）。
4. **数据落在命名卷，重启与重建不丢**：`yxs-data` 卷挂载到容器内 `/data`，业务库为 `/data/data/learning.db`；`restart`、`down`（不带 `-v`）再 `up` 后文章数与运行记录仍在。
   判断标准：先记录 `news_articles` 行数，重启容器、`down` 再 `up`（不删卷）后行数一致；卷内伴随的 `-wal` / `-shm` 文件随卷保留。
5. **单轮可手动/定时触发**：提供单轮执行脚本 `run-round.sh` 与 30 分钟一轮的 cron 示例；脚本退出码与现有 CLI 对齐，日志走 stdout 不落容器内文件 [R6]。
   判断标准：手动执行 `run-round.sh` 完成一轮并写 `source_runs`；cron 文件在宿主或容器内任一形态下都能按 `*/30 * * * *` 触发同一脚本。
6. **体积受控**：采集镜像小于 400MB。
   判断标准：`docker images yxs-crawler:local --format "{{.Size}}"` 小于 400MB；超出时按 §7 风险 1 的分层与裁剪手段复测。镜像体积的实测值在验收文档记录，本轮不预设具体字节数。

目标排序是「先把现有进程原样装进容器（不改正业务逻辑）→ 再用 compose 把依赖与数据挂起来 → 最后谈定时触发与体积」；基础镜像选型与 slim 基线参照官方 Python 镜像说明 [R1]。

## 2 非目标

| 不做 | 为什么 |
|---|---|
| 不改采集业务逻辑（适配器、解析、去重、调度算法） | 本轮只做打包与编排；`src/**` 全部只读，业务行为以 B 轮质量结论为准，容器化不允许顺手改解析规则 |
| 不装 Playwright / Chromium 浏览器兜底 | `browser` 是 `pyproject.toml:13` 的可选额外组；冻结口径明确镜像不含浏览器，反爬源的兜底降级走现有 HTTP 路径 |
| 不写服务端 Dockerfile、不改仓库根 `.dockerignore` | 服务端镜像 `yxs-server:local` 的 build context 与 dockerfile 归 A 轮（冻结 §10.4）；C 只在 compose 里按冻结镜像名引用，不读 A 的 Dockerfile 内容 |
| 不做 SQLite → PostgreSQL 迁移、不接 PG 服务 | D 轮负责迁移工具与 PG 编排；本轮卷内仍是 SQLite，不引入 `PGHOST/PGPORT` 等连接配置 |
| 不做备份/恢复演练、不卷 WAL 快照策略 | G 轮负责备份口径；本轮只保证卷持久化，不实现 `.backup` / `VACUUM INTO` 流程 |
| 不做契约测试用例、不接 Prometheus 抓取 | E 轮核对契约，F 轮做指标与告警；采集控制面现有 `/health` `/stats` `/query` `/run` `/ingest` 端点原样暴露，不新增业务端点 |
| 不做 TLS 终止、反代、CORS 白名单、鉴权 | 采集侧车只在 `yxs-net` 内网被服务端访问；对外暴露由后续部署层承担，本轮不加证书与访问控制 |
| 不做多副本/水平扩缩、不做队列化重构 | 采集是单进程每源独立 `asyncio.Task`（`service.py:162-178`）；`deploy.replicas` 与外部消息队列不在本轮范围 [R4] |
| 不改造 Electron 桌面端的本地自动拉起逻辑 | 桌面端继续按现有方式在本机启动侧车（README §3.1）；compose 形态是服务器部署路径，H 轮只做 mutation 验证 |

## 3 真实依据（现状代码）

| # | 位置 | 现在是什么 | 为什么必须动 / 本轮怎么接 |
|---|---|---|---|
| 1 | `services/news-crawler-py/pyproject.toml:6-10` | 运行时依赖仅 `httpx>=0.28.1`、`beautifulsoup4>=4.12.0`、`lxml>=5.3.0`；`:5` 要求 Python `>=3.12,<3.14` | 镜像基础版本选 `python:3.12-slim` 与此范围对齐；安装清单只能出现这三个运行时包，`browser`/`dev` 两组（`:13-14`）不进镜像 |
| 2 | `services/news-crawler-py/src/news_crawler/http_api.py:38-39` | `DEFAULT_HOST = "127.0.0.1"`、`DEFAULT_PORT = 8787` | 容器内绑回环地址会导致探活与服务端跨容器访问失败；compose 必须用 `NEWS_CRAWLER_HOST=0.0.0.0` 覆盖，端口保持冻结的 8787（冻结 §10.1） |
| 3 | `services/news-crawler-py/src/news_crawler/http_api.py:127-128` 与 `:174-183` | `GET /health` 路由到 `_health`，返回 `ok: True`、`host`、`port` 与 `service.state()` 合并后的每源状态 | 这是 `HEALTHCHECK` 的唯一判据来源：HTTP 200 且 JSON 顶层 `ok == true` 即健康；不需要另写进程内探活脚本 |
| 4 | `services/news-crawler-py/src/news_crawler/cli.py:21` | `DEFAULT_DB = ".data/news.db"`，相对启动目录 | 容器内不能写镜像层、也不能落到开发期相对路径；compose 通过 `--db`（`cli.py:261-263`）把库指向卷内 `/data/data/learning.db` |
| 5 | `services/news-crawler-py/src/news_crawler/cli.py:309-315` | `serve` 的 `--host` / `--port` 从 `NEWS_CRAWLER_HOST` / `NEWS_CRAWLER_PORT` 读默认值 | 容器入口命令直接复用现有参数与环境变量，不为容器化新增 CLI 开关；未被代码读取的变量不写进 compose |
| 6 | `services/news-crawler-py/src/news_crawler/db.py:25-31` 与 `:38-52` | 采集侧自建表仅 `news_articles`（URL 唯一索引）与 `source_runs`（每源每轮一行统计）；`:71-72` 开 `WAL`、`busy_timeout=5000` | 卷内库与服务端共用同一份 `learning.db`；采集只 upsert 文章、插入统计行，WAL 参数沿用现状，不在容器层重复设置 |
| 7 | `services/news-crawler-py/src/news_crawler/output.py:74-88` | 正文 `content_hash` 变化时，删除该文章在 `news_tags`、`case_matches`、`ideology_tags` 里的草稿行（仅当表与 `review_status` 列存在） | 这是采集侧对共享库的全部「删除」动作；契约必须写明：除 `news_articles` / `source_runs` / `news_tags` 草稿清理外，不写其他业务表 |
| 8 | `services/news-crawler-py/src/news_crawler/service.py:37-39` 与 `:91` | `DEFAULT_WORKERS=8`，并发数回退到 `NEWS_CRAWLER_WORKERS`；`:162-178` 每源按自身 `interval_s` 独立循环 | 镜像内长驻模式沿用 `serve`；并发数由 env 可调，cron 单轮触发走 `once` 子命令，两套入口共用同一套 runner |
| 9 | `services/news-crawler-py/.gitignore:1-6` | 已忽略 `.pytest_cache/`、`.ruff_cache/`、`__pycache__/`、`*.pyc`、`.scratch/`、`.data/` | `.dockerignore` 在这六条基础上补 `.venv/` 与 `tests/`：测试与本地虚拟环境不进构建上下文，避免把 `.scratch` 下数百 MB 的历史快照拷进镜像 |
| 10 | `packages/db/src/index.ts:149-154` | 共享库 `news_tags` 表以 `article_id` 外键挂到 `news_articles`；标签行由匹配/标注侧写入 | 采集不向 `news_tags` 插入标签，只按现状清草稿；B 轮抽检脚本（`scripts/quality_report.py`）是宿主侧工具，镜像不 COPY `scripts/` |
| 11 | `docs/requirements/R17-local-data.md:47-56` | 数据目录布局为 `<home>/data/learning.db`（伴随 `-wal` / `-shm`）、`artifacts/<studentId>/<YYYY-MM>/`、`exports/` | 容器内 `/data` 即 `LEARNING_AGENT_HOME`，保留双层 `data/` 路径，与桌面端 `resolveAppHome()` 既有布局一致，服务端与采集不用做路径分支 |
| 12 | `services/news-crawler-py/src/news_crawler/cli.py:121`、`:128`、`:362` | 退出码：无入库目标返回 `2`；一轮中存在失败源返回 `1`；`Ctrl+C` 返回 `130` | `run-round.sh` 的退出码契约直接对齐这三档，宿主 cron 与 compose 重启策略据此判断本轮成败，不自造新码 |

这 12 条的共同判据是「容器化前后，采集进程对库、对 HTTP 面的行为不变」——打包层只换运行环境，不换业务语义；基础镜像与依赖口径参照官方 Python 镜像说明 [R1]。

## 4 与现行为的差异（有意变更）

| 项 | 现状（本机 venv） | 容器契约 | 影响谁 |
|---|---|---|---|
| 监听地址 | 默认 `127.0.0.1`（`http_api.py:38`、`cli.py:310`） | 容器内 `0.0.0.0:8787`，由 `NEWS_CRAWLER_HOST` 覆盖 | 服务端经 compose 网络别名 `crawler:8787` 访问；宿主端口映射 `8787:8787` 仅供手工排查 |
| 数据库路径 | 默认 `.data/news.db`（`cli.py:21`），相对启动目录 | 卷内 `/data/data/learning.db`，经 `--db` 传入；env 名 `NEWS_CRAWLER_DB`（冻结 §10.2） | 采集与服务端共用一份主库；G 轮备份范围按此路径取库 |
| 依赖安装 | 宿主 `.venv` 用 `uv sync`（README §1） | 镜像内只装三个运行时包，`dev`（pytest/ruff）与 `browser`（playwright）不安装 | 测试在宿主跑；镜像里不能执行 pytest 用例，也不能跑浏览器兜底 |
| 运行身份 | 宿主当前用户 | 镜像内非 root 专用 UID（10001），命名卷 `/data` 对该 UID 可写 | 卷初始化属主、文件权限见 §7 风险 4；进程不得 `chown` 或写镜像层 |
| 日志 | 控制台 print，stderr 可看 | 标准输出单行/逐行进容器日志，不写容器内日志文件 [R6] | F 轮后续若接日志采集，只消费 stdout；本轮不装日志驱动 |
| 定时方式 | 桌面端由 Electron 按 `LEARNING_AGENT_NEWS_REFRESH_MINUTES=30` 触发（`R17-local-data.md:44`） | 服务器形态：cron 示例 30 分钟一轮调 `run-round.sh`；`serve` 内每源仍按自身 `interval_s` 循环 | 两条触发路径并存；cron 是示例编排，不替换服务内调度 |
| 数据留存 | 本机目录随 `.learning-agent` 走 | 命名卷 `yxs-data` 持久化；`down` 不带 `-v` 不删卷 | D/G 轮与备份脚本都按命名卷取数据；禁止 `down -v` |

> 上表 7 条是拆分后必须成立的环境差异，不是顺手调整。其中「监听地址、库路径、运行身份」三条写进 C 的 `02-contract.md` §2–§3，由本轮自测用例逐条断言。

## 5 产物清单

全部为新建文件；清单与 `02-ownership-and-parallel.md` §1 的 C 轮写权逐条对齐。

```text
services/news-crawler-py/Dockerfile
  采集镜像构建文件：python:3.12-slim 基础；builder 阶段装构建依赖并产出 wheel，
  runtime 阶段只装运行时三依赖（多阶段分层减小体积 [R3]）；非 root USER；
  暴露 8787；HEALTHCHECK 调 /health；入口 news-crawler serve。
services/news-crawler-py/.dockerignore
  排除 .venv/ .data/ .pytest_cache/ .ruff_cache/ __pycache__/ *.pyc/ .scratch/ tests/；
  与宿主 .gitignore 重叠部分保持同口径。
services/deploy/compose.yml
  project 名 yxs；网络 yxs-net；命名卷 yxs-data -> /data；
  服务 crawler（profiles: crawler, full）；服务 server（profiles: full，
  只按冻结镜像名 yxs-server:local 引用，build 段归 A 轮）；健康检查与
  depends_on: condition: service_healthy 按 Compose 服务定义字段写 [R4]。
services/deploy/.env.example
  采集与服务端相关环境变量样例：LEARNING_AGENT_HOME、NEWS_CRAWLER_DB、
  NEWS_CRAWLER_HOST、NEWS_CRAWLER_PORT、NEWS_CRAWLER_WORKERS、
  NEWS_CRAWLER_BASE_URL；默认值与冻结 §10.2 一致。
services/deploy/cron/news-crawler.cron
  30 分钟一轮的 cron 示例：*/30 * * * * 调 run-round.sh；
  注释说明宿主 cron 与容器内 cron 两种形态的差异（见 §7 风险 2）。
services/deploy/scripts/run-round.sh
  单轮执行脚本：包装 news-crawler once（或 POST /run）；可选 --source 过滤；
  退出码对齐 CLI：0 有成功源 / 1 全部失败 / 2 缺入库目标 / 130 被中断；日志走 stdout。
services/deploy/scripts/healthcheck.sh
  探活包装脚本：请求 /health，判 HTTP 200 且 body ok=true；
  退出 0 健康 / 1 不健康；compose HEALTHCHECK 与手工排查共用同一判据。
```

**同时新增（不改动）**：无。除上述 7 个路径外，本轮不修改任何既有代码、配置或文档；`services/deploy/` 目录目前不存在，由本轮整体新建。多服务编排与健康依赖的组织方式参照 Compose 官方示例集 [R7]，但不照搬其语言栈与前端容器。

### 5.1 与 A 轮产物的引用关系

| 项 | C 轮写法 | 归属 |
|---|---|---|
| 服务端镜像 | compose 中 `image: yxs-server:local`；`build.context: .`、`dockerfile: apps/server/Dockerfile` 仅作声明性引用 | A 轮负责真正构建与 Dockerfile 内容；C 不新建、不改 A 的 Dockerfile |
| 服务端环境变量 | `YXS_SERVER_PORT`、`YXS_DB_PATH`、`NEWS_CRAWLER_BASE_URL` 在 compose 的 server 服务段出现 | 变量名以冻结 §10.2 为准；取值默认由 A 轮契约决定，C 不新增服务端变量 |
| 仓库根 `.dockerignore` | C 不创建、不修改；采集镜像用自己 context 下的 `.dockerignore` | A 轮仅在不存在时新建根 ignore（冻结 §10.4） |

## 6 并行边界

### 6.1 只读依赖与写权

- **只读**：`services/news-crawler-py/src/**`、`pyproject.toml`、`uv.lock`、现有 README 与 docs；`packages/db` 的表结构（只读对照列名）；冻结文件与 A 轮契约；A 轮产出的 `yxs-server:local` 镜像（只按名字引用）。
- **写权唯一**：`services/news-crawler-py/Dockerfile`、`services/news-crawler-py/.dockerignore`、`services/deploy/**`（compose、`.env.example`、cron、两个脚本）。除此之外的路径一律只读 [R10]。

### 6.2 运行期资源（九轮并行不抢）

| 项 | 生产名 | 本轮验收隔离名（`-c` 后缀） | 说明 |
|---|---|---|---|
| 采集容器 | `yxs-crawler` | `yxs-crawler-c` | 验收期避免与历史同名容器冲突；生产名只有一份 |
| 服务端容器（引用） | `yxs-server` | `yxs-server-c` | 仅 `full` profile 起；A 未就绪时 `crawler` profile 不创建该容器 |
| 数据卷 | `yxs-data` | `yxs-data-c` | 验收用独立卷，绝不覆盖本机 `.learning-agent` 与真实数据目录 |
| 网络 | `yxs-net` | `yxs-net-c`（验收 project 隔离时随 project 名派生） | bridge 网络；跨容器只走服务名别名 |
| 端口 | `8787`（采集）、`8080`（服务端，引用） | 被占则按 +100 退避（8887 / 8180） | 采集 8787 为冻结端口（冻结 §10.1）；PG 端口 55432/55433 归 D/G，不重叠 |
| 临时数据 | 命名卷内 | `.scratch/run/C/` 仅放本机验收脚本输出 | 禁止写 `%APPDATA%`、`~/.learning-agent`、`<repo>/.learning-agent` |

### 6.3 五条并行自证

1. **只读依赖**：本轮所有命令与文件改动都落在 §5 的 7 个新路径内；对 `src/**`、`packages/**`、`apps/**` 不执行写操作。若验收需要跑采集测试，在宿主现有 `.venv` 里跑，不修改测试文件。
2. **写权唯一**：`Dockerfile` / `.dockerignore` 的 owner 是 C（`02-ownership-and-parallel.md` §1 表）；`services/deploy/**` 全部归 C。A 的 `apps/server/**`、根 `.dockerignore`、根 `pnpm-lock.yaml` 与 C 无交集，不存在同一文件双方都写。
3. **端口 / 卷 / 容器名不冲突**：生产资源名见 §6.2；验收一律带 `-c` 后缀隔离卷与容器名。D 用 `yxs-pg-d`、G 用 `yxs-pg-g` 与 55432/55433 端口，与本轮 8787/8080 及 `yxs-data(-c)` 不撞。
4. **不依赖他轮产物**：`--profile crawler` 只构建/启动采集服务，不要求 A 的服务端镜像存在；compose 对 `yxs-server:local` 的引用在 `full` profile 下才解析。A 未完工时本轮可独立完成采集侧验收，不阻塞等待。
5. **冲突裁决**：文件归属以 `02-ownership-and-parallel.md` §1 为准；契约口径（端口、变量名、镜像名、卷名）以冻结 §10 为准。若实现中发现必须改一个不归 C 管的文件，在本文档 §7 登记「需要 owner 配合的变更」并给出精确建议，不直接改动。

compose 作为跨服务边界只暴露「服务名 + 端口 + 卷路径」这一层薄接口，与模板类项目把编排与业务镜像解耦的做法一致 [R10]；网络与健康依赖字段写法遵循 Compose 官方服务定义 [R4]。

## 7 未知与风险

| # | 风险 | 怎么验证是否发生 / 缓解 |
|---|---|---|
| 1 | 镜像体积超过 400MB：slim 基础镜像 + lxml 的原生 wheel、`uv.lock` 传递依赖、构建缓存都可能把体积推高 | 构建后执行 `docker images yxs-crawler:local --format "{{.Size}}"` 实测；多阶段构建让 builder 的 wheel/编译缓存不进 runtime 层 [R3]；分层 `docker history yxs-crawler:local` 查最大层。实测体积记入验收文档，不预设字节数；若超 400MB，先裁构建依赖与 `__pycache__`，再评估是否换更薄基础镜像 |
| 2 | cron 放容器内还是宿主：slim 基础镜像默认不带 cron 守护进程，容器内跑 cron 需要额外装 `cron` 包并起第二个进程；宿主 cron 则依赖宿主 Docker CLI 与 compose 文件路径稳定 | 两种形态各做一次单轮触发：容器内形态验证 `crond` 进程与脚本可执行权限；宿主形态验证 `docker compose exec -T crawler` 非交互执行。选型结论写进 `03-implementation.md`；本轮 `.env.example` 与 cron 文件同时标注两种形态，不把决策藏在注释里 |
| 3 | compose 网络内侧车别名：服务端用 `http://crawler:8787` 访问采集；若服务名、别名或端口与 compose 服务段不一致，`news.refresh` 会 502 | `full` profile 起栈后，在服务端容器内执行 `python -c "import urllib.request; urllib.request.urlopen('http://crawler:8787/health', timeout=5)"` 验证解析与连通；别名必须等于 compose 中 crawler 的服务名，端口等于 `NEWS_CRAWLER_PORT` |
| 4 | 卷权限：非 root UID 10001 对命名卷 `/data` 无可写权限时，建库目录失败，采集启动即崩 | 命名卷首次挂载时检查 `/data` 属主与权限；`docker compose exec crawler touch /data/data/.writetest && rm /data/data/.writetest` 验证可写。若权限不足，在镜像内创建数据目录并 chown 到运行 UID，不在容器内 `chmod 777` |
| 5 | WAL 文件随卷持久化但 `down` 后未 checkpoint：重启后 `-wal` 较大，极端情况下连接恢复读库 | `down`（不带 `-v`）再 `up` 后查询 `news_articles` 计数与 `source_runs` 最新一行；确认 WAL 正常回放。禁止 `down -v`；备份口径归 G 轮，本轮不实现快照 |
| 6 | 代码默认绑 `127.0.0.1`，compose 漏配 `NEWS_CRAWLER_HOST=0.0.0.0` 时探活连不上、服务端跨容器不通 | 验收第一项即 `curl 127.0.0.1:8787/health` 从宿主通；`docker compose exec crawler` 内 `curl`/stdlib 请求 `127.0.0.1:8787` 通。若容器内通、宿主不通，查端口映射；若都不通，查 host 绑定 |
| 7 | 现状代码从 `--db` 参数解析库路径，尚未读取 `NEWS_CRAWLER_DB` 环境变量（`cli.py:261-263`） | compose 入口命令显式传 `--db "${NEWS_CRAWLER_DB}"`，由脚本做 env 到参数的映射；不假设代码已支持该 env。验收时检查容器进程命令行含正确库路径；若后续 B 轮要代码直读 env，另走契约变更 |
| 8 | slim 镜像无 `curl`，健康检查若写成 `curl -f` 会因命令缺失直接 unhealthy | HEALTHCHECK 用 Python 标准库 `urllib.request` 发请求（镜像必有 Python）；`healthcheck.sh` 同一判据。参照官方镜像健康检查原型的思路，不额外装探活工具 [R8] |
| 9 | 定时触发与服务内调度重复跑：`serve` 已按每源 `interval_s` 循环，cron 再 30 分钟触发可能产生同轮并发 | 核对 `source_runs` 的 `trigger` 标签：服务内为 `schedule`，cron/手动为 `manual`（`service.py:85`、`cli.py:127`）；并发槽位由现有信号量限制。验收观察一轮内是否出现同源两条并发记录；若重复触发成为问题，在 `03-implementation.md` 决定 cron 只起 `once` 不挂 `serve`，还是关闭服务内调度 |
| 10 | 轮次监控缺失：采集某源连续失败时，宿主/运维侧没有主动告警通道 | 本轮只保证 `/stats` 可读每源失败明细；定时任务的心跳/失败回调监控参照 cron 监控项目的思路 [R9]，具体告警归 F 轮，不自建监控服务 |

## 参考

- [R1] Docker 官方 Python 镜像 — https://hub.docker.com/_/python — 支撑 §1 目标 1 与 §3 依据 1 的 `python:3.12-slim` 选型与体积基线 — 采用 slim 变体；不装 Playwright，不引入多标签体系。
- [R2] Dockerfile 参考（USER / HEALTHCHECK） — https://docs.docker.com/reference/dockerfile/ — 支撑 §1 目标 3 的非 root 运行与健康检查指令 — 采用专用非 root USER 与 HEALTHCHECK；不使用 `--platform` 多架构构建。
- [R3] Docker 多阶段构建 — https://docs.docker.com/build/building/multi-stage/ — 支撑 §5 Dockerfile 分层与 §7 风险 1 体积控制 — builder 产出 wheel、runtime 只留运行时；不把构建工具链留在最终镜像。
- [R4] Compose 服务定义（healthcheck / depends_on / volumes） — https://docs.docker.com/reference/compose-file/services/ — 支撑 §5 compose.yml 字段与 §6 资源隔离 — 采用 `healthcheck` 与 `depends_on: condition: service_healthy`；不使用 `deploy.replicas`。
- [R5] Compose profiles — https://docs.docker.com/reference/compose-file/profiles/ — 支撑 §1 目标 2 的 `crawler` / `full` 双档并行验收 — 直接采用 profile 划分启停范围。
- [R6] 12-Factor · Logs — https://12factor.net/logs — 支撑 §4 日志差异与 §5 `run-round.sh` 输出口径 — 采用日志当事件流走 stdout；不引入日志聚合服务。
- [R7] docker/awesome-compose — https://github.com/docker/awesome-compose — 支撑 §5 多服务编排布局参照 — 借鉴网络/卷/健康检查的组织方式；不照搬其语言栈与前端容器。
- [R8] docker-library/healthcheck — https://github.com/docker-library/healthcheck — 支撑 §7 风险 8 的探活命令选型 — 借鉴官方镜像用标准库探活的写法；不引入独立探活侧车容器。
- [R9] healthchecks/healthchecks — https://github.com/healthchecks/healthchecks — 支撑 §7 风险 10 的 cron 轮次监控思路 — 借鉴「每轮心跳、失败可观测」的概念；本轮不自建监控服务，告警归 F 轮。
- [R10] full-stack-fastapi-template — https://github.com/fastapi/full-stack-fastapi-template — 支撑 §6 与 A 轮的编排边界 — 借鉴 compose 分层与健康依赖；不引入其前端容器与 JWT 体系。
