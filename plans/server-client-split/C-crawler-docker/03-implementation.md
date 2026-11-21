# C · 采集服务 Docker 化 · 实现方案

> 轮次：C · 采集服务 Docker 化
> 文档角色：03-implementation
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1
> 写权：[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1
> 一句话：把现有 Python 采集服务封成两阶段构建的非 root 镜像，compose 用命名卷挂 `/data`、用 `/health` 判健康；内置节拍调度为默认触发器，宿主 cron 脚本只是备选。

## 1 目录与模块

本轮只新建 7 个产物，全部落在 C 的写权范围内（[`02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1：`services/news-crawler-py/Dockerfile`、`.dockerignore` 与 `services/deploy/**` 归 C）。被打包进镜像的既有源码本轮一行不改，只在 Dockerfile / compose 里引用。

### 1.1 本轮产物目录树

```text
services/
├── news-crawler-py/
│   ├── Dockerfile                         # 采集镜像：两阶段 builder/runtime，非 root，EXPOSE 8787
│   ├── .dockerignore                      # 构建上下文排除清单（宿主 venv、数据、缓存、测试、宿主脚本）
│   └── src/news_crawler/                   # 既有源码（本轮只读引用，不改）
└── deploy/
    ├── compose.yml                        # crawler + server 两服务、yxs-net 网络、yxs-data 命名卷
    ├── .env.example                       # 环境变量样例（不含真实密钥）
    ├── cron/
    │   └── news-crawler.cron              # 宿主 cron 备选条目（30 分钟一轮）
    └── scripts/
        ├── run-round.sh                   # 单轮触发脚本：POST /run 或 exec 进容器跑 once
        └── healthcheck.sh                  # /health 探测，退出码 0/1，供 compose healthcheck 调用
```

### 1.2 产物逐文件职责

| 文件 | 职责边界 | 不负责什么 |
|---|---|---|
| `services/news-crawler-py/Dockerfile` | 定义 builder 阶段装依赖产 wheel、runtime 阶段只带运行时；建非 root 用户 UID 10001；声明 `EXPOSE 8787` 与默认 HEALTHCHECK | 不装 Playwright / 浏览器；不写业务代码；不跑迁移 |
| `services/news-crawler-py/.dockerignore` | 控制构建上下文体积，排除宿主 venv、本地数据、缓存、测试产物、宿主侧脚本 | 不排除 `pyproject.toml`、`uv.lock`、`src/`（builder 需要） |
| `services/deploy/compose.yml` | 唯一 compose 真相源：服务定义、profile 分档、命名卷、网络、健康检查、依赖条件 | 不构建 `yxs-server:local`（A 的镜像与 Dockerfile 归 A）；不改 A 的服务配置 |
| `services/deploy/.env.example` | 列出本轮用到的全部环境变量名、默认值、作用；供复制成 `.env` | 不放真实密钥；不定义代码里不存在的变量行为 |
| `services/deploy/cron/news-crawler.cron` | 备选触发器的宿主 cron 条目样例（30 分钟一轮） | 不装进镜像；不替代内置节拍调度 |
| `services/deploy/scripts/run-round.sh` | 单轮执行入口：先探 `/health`，通了就 POST `/run`，否则 `docker compose exec` 跑 `once`；透传退出码 | 不做入库逻辑；不清理卷数据 |
| `services/deploy/scripts/healthcheck.sh` | 容器内探测 `http://127.0.0.1:8787/health`，JSON `ok:true` 退 0，否则退 1 | 不做业务自愈；不重启服务 |

### 1.3 被打包的既有模块（只读引用）

| 模块 | 现状职责 | 本轮引用点 |
|---|---|---|
| `src/news_crawler/cli.py` | argparse 入口，子命令 `crawl / bench / schedule / once / serve / status / list-sources`（`cli.py:288-322`） | compose `command` 用 `serve`；`run-round.sh` 兜底用 `once` |
| `src/news_crawler/http_api.py` | 标准库 `http.server` 控制面，路由 `/health` `/stats` `/run` `/ingest` `/query`（`http_api.py:8-20`） | healthcheck 打 `/health`；`/run` 被脚本触发 |
| `src/news_crawler/service.py` | 长驻编排：共享信号量、单轮硬超时、每源独立节拍循环 | 内置调度是默认触发器；`state()` 喂给 `/health` |
| `src/news_crawler/db.py` | SQLite schema、WAL、`busy_timeout`、统计 DAL | 数据读写边界见 §4 |
| `src/news_crawler/output.py` | `JsonlSink` / `SQLiteSink` / `CompositeSink`，逐条 upsert | 表写入路径见 §4 |
| `src/news_crawler/runner.py`、`sources/*` | 抓取执行器与各源适配器 | 镜像原样带入；本轮不加新源 |

镜像分层与「依赖层先于代码层」的做法参照通用多阶段模式 [R25]；compose 里服务、健康检查与依赖条件的组织参照完整模板的分层方式 [R5]，但不引入它的前端容器与 JWT 体系。

## 2 依赖与构建

### 2.1 运行时依赖清单

`pyproject.toml:6-10` 冻结了三个运行时依赖：`httpx>=0.28.1`、`beautifulsoup4>=4.12.0`、`lxml>=5.3.0`。Python 版本约束在 `pyproject.toml:5`：`requires-python = ">=3.12,<3.14"`。

- **镜像只装运行时三个包**；`browser` 可选组（`playwright>=1.55.0`，`pyproject.toml:13`）与 `dev` 组（pytest / pytest-asyncio / ruff，`pyproject.toml:14`）都不进 runtime 阶段。理由：冻结口径规定镜像不含浏览器 [R23]，测试与 lint 是宿主侧动作。
- 入口脚本声明在 `pyproject.toml:17`：`news-crawler = "news_crawler.cli:main"`，镜像 runtime 通过这个命令起服务，等价于 `python -m news_crawler`（`__main__.py:1-4`）。
- 包构建后端是 hatchling（`pyproject.toml:19-21`），wheel 只打包 `src/news_crawler`（`pyproject.toml:23-24`）。

### 2.2 两阶段 builder / runtime

```dockerfile
# ---- builder：装构建工具、产 wheel ----
FROM python:3.12-slim AS builder
WORKDIR /build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
COPY pyproject.toml uv.lock ./
COPY src ./src
RUN pip install --upgrade pip \
 && pip install --wheel-dir /wheels .

# ---- runtime：只带运行时 Python 与已装包 ----
FROM python:3.12-slim AS runtime
WORKDIR /app
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN pip install --upgrade pip \
 && pip install /wheels/*.whl
COPY --from=builder /wheels /wheels
COPY src ./src
```

两阶段的边界：builder 里可以有编译工具链与源码树，runtime 里不留构建缓存、不留源码之外的测试与文档。这样最终镜像的层数与体积都只由「运行时必需物」决定 [R25]。

### 2.3 pip 安装顺序与层缓存

层缓存按「不易变 → 易变」排序，避免改一行业务代码就重装依赖：

1. 先 `COPY pyproject.toml uv.lock`：依赖清单没变时，pip 安装层直接命中缓存。
2. 再 `COPY src ./src`：代码层在后，源码改动只失效最后几层。
3. `PIP_NO_CACHE_DIR=1`：不在镜像层里留 pip 下载缓存（缓存只在 builder 临时层里有用）。
4. runtime 阶段从 builder 取 wheel 文件安装，不重新解析依赖树，锁文件解析结果只发生一次。

构建前可先用 Dockerfile linter 做静态检查，把用户、权限、层顺序问题拦在 `docker build` 之前 [R59]。

### 2.4 `python:3.12-slim` 选型理由

| 判据 | 结论 |
|---|---|
| 版本匹配 | `python:3.12-slim` 落在 `requires-python = ">=3.12,<3.14"`（`pyproject.toml:5`）区间内 |
| 体积基线 | slim 基于精简 Debian，不带编译工具链与文档页，比 `python:3.12` 全量镜像小；官方镜像基线与选型口径见 [R23] |
| 依赖兼容性 | `httpx` / `beautifulsoup4` 是纯 Python；`lxml` 在 PyPI 提供 manylinux wheel，slim 上无需 `gcc` 编译 |
| 不选 alpine | alpine 的 musl libc 与个别 wheel（含 lxml 历史上的边界情况）兼容性需要额外验证；本轮冻结口径是 slim，不引入第二套基线 |
| 不装浏览器 | Playwright 及其 Chromium 是 GB 级依赖，属 `browser` 可选组；直连受限时由宿主兜底，不进镜像 [R23] |

### 2.5 非 root 用户与端口

```dockerfile
RUN groupadd -g 10001 app \
 && useradd -u 10001 -g 10001 -m app \
 && mkdir -p /data \
 && chown -R 10001:10001 /app /data
USER 10001
EXPOSE 8787
```

- UID/GID 固定 10001：compose 命名卷首次初始化时按镜像内属主落权，避免容器内进程以 root 写卷后宿主侧排查权限混乱。非 root 运行与 `USER` 指令的官方语义见 [R24]；多用户 Dockerfile 的常见写法参照 [R58]。
- `EXPOSE 8787` 对应控制面默认端口（`http_api.py:38-39` 的 `DEFAULT_PORT = 8787`，CLI 环境变量 `NEWS_CRAWLER_PORT` 默认同值，`cli.py:312-315`）。`EXPOSE` 只是声明，实际端口映射由 compose `ports` 决定。
- 容器内监听地址必须是 `0.0.0.0`：默认值 `127.0.0.1`（`http_api.py:38`、`cli.py:309-310`）只回环，compose 网络内别的容器连不上；compose `command` 显式传 `--host 0.0.0.0` 覆盖。

## 3 关键实现

### 3.1 Dockerfile 逐行意图

| 行段 | 意图 | 失败时的表现 |
|---|---|---|
| `FROM python:3.12-slim AS builder` | 构建阶段基线；只在这里解析依赖 | 基础镜像拉不动 → 构建第一步即失败 |
| `COPY pyproject.toml uv.lock ./` | 先复制依赖清单，锁依赖层缓存 | 漏拷 `uv.lock` → 依赖版本在构建期被重新解析，缓存失效且可能漂移 |
| `COPY src ./src` | 源码进 builder | — |
| `RUN pip install --wheel-dir /wheels .` | 把本包与三个运行时依赖打成 wheel 落到 `/wheels` | 缺 `src` 或 `pyproject.toml` → hatchling 找不到包元数据 |
| `FROM python:3.12-slim AS runtime` | 运行阶段基线，与 builder 隔离 | — |
| `COPY --from=builder /wheels /wheels` | 只把 wheel 带进 runtime | 漏拷 → runtime `pip install` 找不到本地 wheel |
| `RUN pip install /wheels/*.whl` | 安装本包 + 运行时依赖，不含构建工具 | wheel 平台不符 → lxml 装不上 |
| `COPY src ./src` | 带入源码（wheel 已装包元数据，源码用于运行期导入与适配器发现） | 漏拷 → `python -m news_crawler` 找不到模块 |
| `RUN groupadd ... && useradd ... && chown ...` | 建 10001 用户并交 `/app` `/data` 属主 | 属主未交 → 非 root 进程写 `/data` 时权限拒绝 |
| `USER 10001` | 后续所有指令（含容器主进程）以 10001 跑 | 漏写 → 容器内是 root，AC 非 root 校验变红 |
| `EXPOSE 8787` | 声明控制面端口 | — |
| `HEALTHCHECK`（内联默认） | 镜像自带一份基础探活；compose 可按 §3.4 覆盖 | 探活失败 → compose 把容器标 unhealthy |
| `CMD ["news-crawler", "serve", ...]` | 主进程；compose `command` 可再覆盖参数 | 入口不存在 → 容器启动即退出 |

`USER`、`HEALTHCHECK`、`ENTRYPOINT/CMD` 的指令语义以 Dockerfile 官方参考为准 [R24]。

### 3.2 `.dockerignore` 逐条

构建上下文是 `services/news-crawler-py`（冻结口径 §10.4），排除清单逐条对应「不该进镜像的东西」：

| 条目 | 排除理由 | 不排除的对照 |
|---|---|---|
| `.venv/` | 宿主虚拟环境，含平台相关解释器与路径，进镜像只会污染 runtime | `src/` 必须保留 |
| `.data/` | 宿主本地 SQLite 与 WAL/SHM（`.gitignore:6` 同款），数据走卷不进镜像 | — |
| `.scratch/` | 开发探针、样本库、JSONL、HTML 转储（目录现状见服务目录） | — |
| `__pycache__/`、`*.pyc` | Python 字节码缓存，按宿主 Python 版本生成，无价值 | — |
| `.pytest_cache/`、`.ruff_cache/` | 测试与 lint 缓存，属 `dev` 工具链 | — |
| `tests/` | pytest 用例与假源，不进生产镜像 | — |
| `scripts/` | **宿主侧运维/探针脚本目录**，镜像不 `COPY scripts/` | — |
| `docs/`、`ADAPTERS.md`、`README.md` | 人读文档，运行时不需要 | — |
| `*.db`、`*.db-wal`、`*.db-shm`、`*.jsonl` | 本地数据与样例输出，防止把宿主库打进镜像层 | — |
| `.git/` | 版本元数据，体积大且运行时不可见 | — |

**一条硬事实（来自 `02-ownership-and-parallel.md` §2 冲突裁决表）**：B 轮的 `services/news-crawler-py/scripts/quality_report.py` 是**宿主侧运维脚本**——只读新闻库出质量报告，不在采集服务进程里运行；镜像不 `COPY scripts/`。因此 C 在 `.dockerignore` 里排除 `scripts/` 是安全的，不会把运行必需代码挡在镜像外。这条裁决同时意味着：若将来某个脚本要进容器，必须先改归属与裁决表，不能靠放开 `.dockerignore` 顺带解决。

### 3.3 compose 服务定义

`services/deploy/compose.yml` 的骨架（冻结名见 §10.4：project `yxs`、网络 `yxs-net`、卷 `yxs-data`、镜像 `yxs-crawler:local`）：

```yaml
name: yxs

networks:
  yxs-net:
    driver: bridge

volumes:
  yxs-data:

services:
  crawler:
    profiles: [crawler, full]
    image: yxs-crawler:local
    build:
      context: ../news-crawler-py
      dockerfile: Dockerfile
    environment:
      LEARNING_AGENT_HOME: /data
      NEWS_CRAWLER_HOST: "0.0.0.0"
      NEWS_CRAWLER_PORT: "8787"
      NEWS_CRAWLER_DB: /data/data/learning.db
      NEWS_CRAWLER_WORKERS: "${NEWS_CRAWLER_WORKERS:-8}"
    command:
      - "sh"
      - "-c"
      - 'exec news-crawler serve --host 0.0.0.0 --db "$$NEWS_CRAWLER_DB"'
    volumes:
      - yxs-data:/data
      - ./scripts/healthcheck.sh:/app/scripts/healthcheck.sh:ro
    ports:
      - "8787:8787"
    networks: [yxs-net]
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "python", "/app/scripts/healthcheck.sh"]
      interval: 30s
      timeout: 5s
      start_period: 20s
      retries: 3

  server:
    profiles: [full]
    image: yxs-server:local
    build:
      context: ../..
      dockerfile: apps/server/Dockerfile
    environment:
      LEARNING_AGENT_HOME: /data
      YXS_SERVER_HOST: "0.0.0.0"
      YXS_SERVER_PORT: "8080"
      YXS_DB_PATH: /data/data/learning.db
      NEWS_CRAWLER_BASE_URL: "http://crawler:8787"
    depends_on:
      crawler:
        condition: service_healthy
    networks: [yxs-net]
    volumes:
      - yxs-data:/data
```

要点：

- **profiles 分两档**：`crawler` 只起采集，可独立验收；`full` 同时起采集与服务端。profile 机制的官方约定见 [R27]。
- **不写 `container_name`**：容器名由 compose 按 project 派生——生产 project `yxs` 下是 `yxs-crawler-1`，验收 project `yxs-c` 下是 `yxs-c-crawler-1`。`container_name` 是宿主全局命名空间，写死会让同一台机器上的第二套栈起不来；隔离交给 `-p`，不需要额外后缀变量。
- **容器内固定值一律写字面量**：`LEARNING_AGENT_HOME` / `NEWS_CRAWLER_DB` / `YXS_DB_PATH` / 两个监听端口 / `NEWS_CRAWLER_BASE_URL` 都不做 `${VAR:-default}` 兜底。宿主导出的同名变量（桌面端常驻的 `LEARNING_AGENT_HOME` 就是典型）会被 compose 注入容器，把数据根指到容器内不存在的路径。唯一保留插值的是 `NEWS_CRAWLER_WORKERS`——它只改并发度，不改任何路径或端口。
- **`server` 服务只做声明性引用**：`yxs-server:local` 的镜像构建与 Dockerfile 内容归 A（`02-ownership-and-parallel.md` §1）；compose 里的 `build.context` / `dockerfile` 仅按冻结 §10.4 声明路径，C 不创建、不改写 A 的 Dockerfile；`depends_on: condition: service_healthy` 保证服务端等采集健康后再启动 [R26]。
- **`YXS_SERVER_HOST` 必须显式给**：代码默认 `127.0.0.1`（`apps/server/src/env.ts:60`），容器内只绑回环时宿主 `8080:8080` 映射拿不到连接。
- **网络别名**：服务端经 `http://crawler:8787` 访问采集（冻结 §10.1），不走宿主端口回环。
- **同一命名卷挂两个服务**：`yxs-data:/data`，采集与服务端共用 `/data/data/learning.db`；卷只声明一次，服务间不复制库文件。
- 入口命令用 `sh -c` 把 env 映射到 `--db`：代码只认 `--db` 参数（`cli.py:261-263`），`$$NEWS_CRAWLER_DB` 由 shell 在容器内展开，不在宿主侧插值。端口由 `NEWS_CRAWLER_PORT` env 传入，命令行不重复写 `--port`。
- 验收隔离：project `yxs-c`，容器 `yxs-c-crawler-1`、卷 `yxs-c_yxs-data`（命名对照见 `02-contract.md` §3.1）。
- healthcheck 引用挂载进来的脚本（§3.4），脚本以只读卷方式挂到 `/app/scripts/healthcheck.sh`，镜像内不另存一份副本。

### 3.4 `healthcheck.sh`

slim 镜像不带 `curl`，脚本探测走 Python 标准库 `urllib`，不引入额外系统包。文件虽是 `.sh` 后缀，内容是 Python 脚本，由 compose `healthcheck.test` 的 `python /app/scripts/healthcheck.sh` 直接解释执行（契约 `02-contract.md` §4.1）：

```python
#!/usr/bin/env python3
# 容器内回环探测；地址固定 127.0.0.1，不读 NEWS_CRAWLER_HOST（那是对外监听地址）
import json
import sys
import urllib.request

URL = "http://127.0.0.1:8787/health"

try:
    with urllib.request.urlopen(URL, timeout=5) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    sys.exit(0 if payload.get("ok") is True else 1)
except Exception:
    sys.exit(1)
```

- 退出码 0 = `/health` 200 且 `ok:true`；非 0 = 进程未起、端口不通、库打不开或 `ok:false`。compose 据此把容器标 `unhealthy` [R26]。
- `/health` 处理器在 `http_api.py:174-183`：返回进程状态与每源最近运行；路由匹配在 `http_api.py:127-128`。
- compose 健康检查参数（`interval 30s / timeout 5s / start_period 20s / retries 3`）与依赖等待的写法参照成熟 compose 健康检查样例 [R60]。
- 脚本由 compose 只读挂入 `/app/scripts/healthcheck.sh`，源文件归 C 的 `services/deploy/scripts/`；镜像构建上下文是 `services/news-crawler-py`，不复制 `services/deploy` 目录。

### 3.5 `run-round.sh` 与 cron 的关系：容器内 cron 与宿主 cron 二选一

**默认方案 A：容器内长驻 `serve` + 内置节拍调度，不装 cron。**

`CrawlService._schedule_loop` 已经为每个已注册源起独立 `asyncio.Task`，按该源 `descriptor.policy.interval_s` 循环，先跑完的源立刻释放共享槽位再睡自己的周期（`service.py:162-178`）。`serve` 命令起的就是这套长驻编排（`cli.py:189-206`）。容器内只跑这一个主进程，日志走 stdout [R6]，没有第二套时钟。

**备选方案 B：宿主 cron 调 `run-round.sh`，30 分钟一轮。**

`cron/news-crawler.cron` 是装在**宿主** crontab 里的样例条目，不装进采集镜像：

```cron
# 备选触发器：宿主每 30 分钟调一次单轮脚本；方案 A 启用时不要同时启用本条目
# /opt/yxs 是示例部署目录，按实际位置替换；脚本相对路径保持不变
*/30 * * * * cd /opt/yxs/services/deploy && bash ./scripts/run-round.sh
```

`run-round.sh` 的两种触发路径；脚本用 `exec` 替换进程，把 CLI 退出码原样透出（完整实现见 `services/deploy/scripts/run-round.sh`，此处只摘骨架）：

```sh
#!/usr/bin/env bash
set -uo pipefail
BASE_URL="${NEWS_CRAWLER_BASE_URL:-http://127.0.0.1:8787}"
# 容器内固定 /data/data/learning.db；宿主兜底从 LEARNING_AGENT_HOME 派生，不写死绝对路径
CONTAINER_DB="/data/data/learning.db"
HOST_DB="${LEARNING_AGENT_HOME:-${HOME:-.}/.learning-agent}/data/learning.db"

# 路径一：控制面已起，POST /run 同步跑一轮（wait=true）
if python -c "import urllib.request; urllib.request.urlopen('$BASE_URL/health', timeout=5)" 2>/dev/null; then
  exec python - "$BASE_URL" <<'PY'
# … POST /run，解析 rounds 判成败
PY
fi

# 路径二：控制面不可达时，exec 进容器跑 once（trigger=manual）
# crawler 服务只在 crawler/full profile 下存在，必须带 --profile crawler
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/../compose.yml"
COMPOSE_CMD=(docker compose -f "$COMPOSE_FILE" --profile crawler)
if "${COMPOSE_CMD[@]}" ps --status running --format '{{.Service}}' 2>/dev/null | grep -qx crawler; then
  exec "${COMPOSE_CMD[@]}" exec -T crawler news-crawler once --db "$CONTAINER_DB" "$@"
fi
# 再退到本机 CLI / python -m，用 $HOST_DB
```

`COMPOSE_FILE` 由脚本自身位置推导（`$SCRIPT_DIR/../compose.yml`），不依赖 cwd——cron 里 `cd` 到部署目录只是为了让相对路径参数可读，脚本本身在任何 cwd 下都能定位 compose 文件。

退出码对齐现有 CLI（`02-contract.md` §4.3）：`0` 本轮至少一个源非 failure；`1` 全部源失败；`2` 缺入库目标；`130` 被 SIGINT 中断。脚本不自造新码；宿主 cron 与 compose `restart` 策略按这四档判断本轮成败。`"$@"` 透传可选的 `--source ID ...` 过滤参数。

**为什么不把 cron 守护进程装进容器**：

1. 单容器单进程是本轮镜像目标；容器内再起 cron daemon 要额外包一层监督，进程退出、日志、信号都要重新管 [R24]。
2. 节拍逻辑已经在服务内实现，内置循环与 `source_runs.trigger='schedule'` 统计闭环；第二套 cron 会产生重复轮次。
3. slim 镜像不加 cron 包，体积与攻击面都更小。

**互斥约束**：A 与 B 不能同时启用。两套触发器并发写同一个 SQLite 库，WAL 下不会损坏，但 `source_runs` 会出现重复轮次、源退避节奏被打乱。选 B 时 `serve` 改为按需 `once` 或缩短长驻服务职责；选 A 时注释掉宿主 cron 条目。后台任务监控的通用做法（外部轮询 + 失败告警）参照 cron 监控项目的思路 [R61]，但本轮不引入独立监控服务。

## 4 数据读写

### 4.1 只写三张表

采集侧写入边界严格限定在三张表；三张表均为 `STRICT` 表，字段可空性与类型由 schema 约束，读取侧不必按值猜类型 [R22]：

| 表 | 写入动作 | 代码位置 |
|---|---|---|
| `news_articles` | 逐条 upsert：URL 唯一，正文未变记 `skipped`，正文变化清旧草稿后更新 | `output.py:105-134`；schema 在 `db.py:25-31` |
| `source_runs` | 每轮结束逐源插一行统计（`trigger` 区分 `schedule/manual/bench`） | `db.py:110-133`；schema 在 `db.py:38-52` |
| `news_tags` | 仅在正文变化时清理该文章的草稿标签（`review_status='draft'`），不新建标签行 | `output.py:74-88`；表结构归下游 `packages/db`（`packages/db/src/index.ts:149-155`） |

边界说明（既有行为，本轮不改）：`output.py:74-88` 的 `_drop_drafts` 在正文变化时顺带清理 `case_matches`、`ideology_tags` 的草稿行；这是下游匹配体系已有的联动清理，采集侧不向这两张表 INSERT/UPDATE。采集镜像**不创建、不迁移、不改写** `chapters`、`knowledge_points`、`questions`、`student_profiles`、`artifacts`、`chat_*` 等任何其它业务表；表清单越界核对见 `04-acceptance.md` AC-09。

### 4.2 WAL 与并发

- 连接打开时即设 `PRAGMA journal_mode=WAL` 与 `PRAGMA busy_timeout=5000`（`db.py:71-72`），连接初始化在 `db.py:65-75`。
- 采集侧与服务端共用 `/data/data/learning.db`：WAL 允许读写并发，`busy_timeout` 在写竞争时等待而非立刻报锁；采集不另开第二套连接池配置。
- 逐条入库、不攒批：一条抓到立刻 upsert 一条（`output.py:90-134`），单条详情失败只记进该源 `failures`，不中断整轮。

### 4.3 `/data` 卷挂载与保卷

- 容器内数据根固定 `/data`（`LEARNING_AGENT_HOME=/data`，冻结 §10.3）；库文件路径 `/data/data/learning.db`，`data/data/` 这一层是与桌面端既有布局对齐的故意结构，不做路径分支。
- compose 用命名卷 `yxs-data:/data`（§3.3），不是 bind mount；卷名冻结 §10.4。
- **`down` 不带 `-v`**：`docker compose down` 只删容器与网络，保留命名卷；数据在 `down` 再 `up` 后仍在。任何轮次禁止 `down -v`（`02-ownership-and-parallel.md` §3 硬规则）。
- 容器不把数据写进镜像层：`.dockerignore` 排除所有 `*.db*` 与 `*.jsonl`（§3.2），重建镜像不丢失库数据。

### 4.4 配置与数据路径的差距（未知与风险 + 验证方法）

- 现状代码只从 CLI 参数读 `--db`、`--max-run-s`（`cli.py:260-263`、`cli.py:316`），未直读 `NEWS_CRAWLER_DB` 环境变量；`NEWS_CRAWLER_HOST/PORT/WORKERS` 有环境变量读取（`cli.py:309-315`、`service.py:91`）。compose 的 `command` 用 `sh -c 'exec news-crawler serve --host 0.0.0.0 --db "$$NEWS_CRAWLER_DB"'` 把 env 映射成参数：`$$` 让 compose 不做宿主侧插值，由容器内 shell 展开。
- 验证方法：容器起后 `docker compose -p yxs-c -f services/deploy/compose.yml --profile crawler exec crawler printenv` 核对变量；`... exec crawler news-crawler serve --help` 核对参数；启动日志里的 `DB=` 路径（`cli.py:195-199`）必须是 `/data/data/learning.db`。若后续代码改为直读 env，再去掉 `sh -c` 这层映射。

## 5 配置

配置全部来自环境变量与 compose `command`，启动期一次读完；不在镜像里写第二份默认值表。`12factor` 的配置外置原则见 [R6]。

### 5.1 环境变量表

| 变量 | 默认值 | 作用 | 谁设 | 取值方式 | 代码现状 |
|---|---|---|---|---|---|
| `LEARNING_AGENT_HOME` | `/data`（容器内） | 数据根目录 | compose `environment` | 字面量 | 经 `--db` 路径间接使用 |
| `NEWS_CRAWLER_HOST` | `127.0.0.1` | 控制面监听地址；容器内必须 `0.0.0.0` | compose 覆盖 | 字面量 | `cli.py:309-310` 读 env |
| `NEWS_CRAWLER_PORT` | `8787` | 控制面端口 | compose | 字面量 | `cli.py:312-315` 读 env；`http_api.py:38-39` 同值 |
| `NEWS_CRAWLER_DB` | `/data/data/learning.db` | SQLite 库路径 | compose `command` 内 `$$NEWS_CRAWLER_DB` | 字面量 | 代码认 `--db` 参数，env 经 `sh -c` 展开（§4.4） |
| `NEWS_CRAWLER_WORKERS` | `8` | 共享并发槽位数 | 宿主 `.env` 可选 | `${NEWS_CRAWLER_WORKERS:-8}` | `service.py:91` 读 env（`ENV_WORKERS`，`service.py:39`） |
| `NEWS_CRAWLER_BASE_URL` | `http://crawler:8787` | compose 网络内服务端访问采集的别名 | `server` 服务环境 | 字面量 | 采集侧自身不读，供 A 的服务端用 |
| `YXS_SERVER_HOST` | `0.0.0.0` | 服务端监听地址；代码默认 `127.0.0.1` | `server` 服务环境 | 字面量 | `apps/server/src/env.ts:60` |
| `YXS_SERVER_PORT` | `8080` | 服务端监听端口 | `server` 服务环境 | 字面量 | 冻结 §10.1 |
| `YXS_DB_PATH` | `/data/data/learning.db` | 服务端主库路径 | `server` 服务环境 | 字面量 | 冻结 §10.2 |

「取值方式」的判据：改了这个值会不会让容器内路径/端口契约失效。会失效的一律写字面量——宿主导出的同名变量（桌面端常驻 `LEARNING_AGENT_HOME` 是最常见的一例）会被 compose 注入，导致数据写到容器内不存在的位置。

### 5.2 `.env.example` 逐项

`services/deploy/.env.example` 只列**宿主可调**项；验收时复制为 `.env` 再改，`.env` 本身不进版本库。当前全文只有一项：

```dotenv
# 跨源共享并发槽位数；默认 8，按宿主 CPU/网络可调
NEWS_CRAWLER_WORKERS=8
```

固定项（路径、端口、监听地址、卷位置）不写进样例：compose 不对这些键做插值，写进去也不会生效，只会让人误以为能改。要改端口/路径必须改 `compose.yml`。

- 不设 `DEEPSEEK_API_KEY` 等 LLM 密钥：采集侧车不调模型，密钥归 A 的服务端。
- 端口占用退避按冻结 §3：宿主映射端口冲突时 `+100` 递增（8787 → 8887），并在验收报告写明实际端口；容器内端口不变，改宿主侧映射时同步改 `compose.yml` 的 `ports`。

## 6 失败处理

| 失败路径 | 判定 | 处置 / 用户侧表现 | 是否自动重试 |
|---|---|---|---|
| `/health` 不通过 | 进程未起、端口不通、库打不开或 `ok:false`；`healthcheck.sh` 退非 0 | compose 标记 `unhealthy`；`depends_on: service_healthy` 的服务端不会启动；`restart: unless-stopped` 按策略重启容器 | 重启由 compose 策略负责；轮次内单源失败不重试整轮 |
| 宿主端口被占 | `8787` 映射失败，容器启动报错 | 查占用进程；按 §5.1 退避换宿主端口映射，容器内仍 8787 | 否，人工改 `ports` |
| 卷权限拒绝 | 非 root（10001）对 `/data` 无写权限 | 命名卷首次初始化继承镜像内属主；若是 bind mount 需在宿主 `chown` 10001；启动日志或 `/health` 报库打不开 | 否，先修卷属主 |
| cron 条目未生效 | 宿主 cron 没跑 `run-round.sh`，`source_runs` 无 `trigger='manual'` 新行 | 先手工跑一次脚本验证退出码；再查 `crontab -l`、宿主 cron 服务状态、脚本可执行位与日志路径 | 否 |
| SQLite 写竞争 | `busy` / 锁等待 | WAL + `busy_timeout=5000`（`db.py:71-72`）等待；超时后该源记 failure，不拖垮其它源 | 连接层等待，不自动重试已入库行 |
| 上游源反爬 / 改版 / 超时 | 单源本轮 failure，`failures` 明细落库 | `/health` 与 `/stats` 可查；不影响其它源；`--max-run-s` 超时取消该源本轮 | 源策略内指数退避；整轮不自动重跑 |
| 镜像构建缺依赖 | builder 解析不到 wheel / runtime 缺模块 | 构建期即失败；核对 `.dockerignore` 没误排 `src/`、`pyproject.toml`、`uv.lock` | 否 |

失败对外只保留分类与一行状态，堆栈进容器日志（stdout），不向控制面响应泄漏内部路径 [R6]。

## 7 性能与资源

### 7.1 镜像体积预算（判据 < 400 MB，冻结 `02-ownership-and-parallel.md` §4 C 的 DoD）

镜像各层预算拆解如下；除判据外，分层数字均为**待实测**，不填估算值，构建后用命令实测回填验收报告。

| 层 | 内容 | 体积预算 | 测量命令 |
|---|---|---|---|
| 基础镜像 | `python:3.12-slim`（Debian slim + Python 3.12） | 待实测 | `docker history yxs-crawler:local --format "{{.Size}} {{.Comment}}"` |
| 系统包层 | 本轮不额外 apt 安装（无 curl、无浏览器、无编译工具链） | 新增≈0，待实测 | 同上 history 逐层 |
| pip 依赖层 | `httpx`、`beautifulsoup4`、`lxml`（wheel） | 待实测 | `docker run --rm yxs-crawler:local python -c "import httpx, bs4, lxml, site; print(site.getsitepackages())"` |
| 应用代码层 | `src/news_crawler` 包 | 待实测（宿主可先量源码目录体积作对照） | `docker image inspect yxs-crawler:local --format "{{.Size}}"` |
| 数据 / WAL 层 | 不进镜像，走 `yxs-data` 卷 | 0 | 确认镜像内无 `*.db*` |
| 合计判据 | 整镜像 | **< 400 MB** | `docker images --format "{{.Repository}}:{{.Tag}} {{.Size}}"` |

测量命令（PowerShell，仓库根执行）：

```powershell
cd E:\Documents\GitHub\YingXiaoShang
docker images --format "{{.Repository}}:{{.Tag}} {{.Size}}" | findstr crawler
docker image inspect yxs-crawler:local --format "{{.Size}}"
```

400 MB 判据来自 C 轮完成定义（`02-ownership-and-parallel.md` §4）；slim 基线与不含浏览器的选型依据见 [R23]。

### 7.2 单轮采集时长与并发

| 指标 | 预期 / 判据 | 怎么量 |
|---|---|---|
| 单源单轮硬超时 | 90 秒（默认 `--max-run-s`，`service.py:38`、`cli.py:316`）；超时记 failure | `/stats` 读该源 `duration_ms` 与 `failures` |
| 跨源并发槽位 | 默认 8（`service.py:37`、`service.py:91`） | 启动日志 `workers=`（`cli.py:195-199`） |
| 整轮墙钟 | 取决于启用源数与详情并发，**待实测**；首轮含网络抓取，单源数十秒量级，不写死总秒数 | `GET /stats?limit=20` 逐源 `duration_ms` 求和对照 |
| 容器内存 | 待实测；预算目标不超过运行时基线 + 依赖常驻占用 | `docker stats $(docker compose -p yxs-c -f services/deploy/compose.yml --profile crawler ps -q crawler)` |
| 启动到可服务 | 待实测；以 `/health` 从容器启动到 200 的时间为准 | `docker start` 后轮询 `/health` |

单轮耗时不替源适配承诺数字：源集合仍在增加（README §2「源数量未知」），实测值落 `.scratch/run/C/` 证据目录。

## 8 实施顺序

每一步做完都有可验证的出口，失败可回退到上一步；顺序参照「先能构建、再能跑、再验持久化、最后量资源」的小步交付 [R24]。

1. **`.dockerignore` 先行**：按 §3.2 写排除清单。验证：构建前用 hadolint 或列构建上下文目录，确认 `.venv`、`.scratch`、`tests`、`scripts`、`*.db*` 不在上下文内。
2. **Dockerfile 两阶段骨架**：builder 产 wheel，runtime 装 wheel + 拷源码。验证：`docker build -f services/news-crawler-py/Dockerfile -t yxs-crawler:local services/news-crawler-py` 构建成功。
3. **非 root 与端口**：建 UID 10001、交 `/app` `/data` 属主、`USER 10001`、`EXPOSE 8787`。验证：`docker run --rm yxs-crawler:local id -u` 输出 `10001`。
4. **compose 骨架**：`crawler` 服务 + `yxs-net` + `yxs-data` 卷 + healthcheck；`server` 按 `full` profile 占位引用冻结镜像名。验证：`docker compose -f services/deploy/compose.yml --profile crawler config` 渲染无错。
5. **脚本与样例配置**：`healthcheck.sh`、`run-round.sh`、`news-crawler.cron`、`.env.example`。验证：`python -m py_compile scripts/healthcheck.sh`（探活脚本是 Python 内容）、`bash -n scripts/run-round.sh` 语法通过；`.env.example` 变量名与 §5.1 表一致。
6. **起服务探活**：`docker compose --profile crawler up -d`，等容器 healthy；`/health` 返回 `ok:true`。验证：AC-01、AC-02。
7. **持久化与边界核对**：`restart`、`down`（不带 `-v`）再 `up` 后数据仍在；SQL 查表清单确认只写三张表。验证：AC-05、AC-06、AC-09。
8. **资源实测与证据落盘**：量镜像体积、读单轮耗时、存 compose 日志与输出到 `.scratch/run/C/`。验证：AC-04、AC-08；证据清单见 `04-acceptance.md` §4。

## 参考

- [R5] full-stack-fastapi-template — https://github.com/fastapi/full-stack-fastapi-template — 支撑 §1 compose 分层与 §3.3 服务/健康检查布局 — 借鉴 compose 组织方式；不引入前端容器与 JWT 体系。
- [R6] 12-Factor · Logs — https://12factor.net/logs — 支撑 §3.5 单进程 stdout 日志与 §5 配置外置 — 直接采用；不引入日志聚合服务。
- [R22] SQLite STRICT tables — https://www.sqlite.org/stricttables.html — 支撑 §4.1 表结构边界与字段类型约束 — 采用 STRICT 表口径；不按运行时值推断列类型。
- [R23] Docker 官方 Python 镜像 — https://hub.docker.com/_/python — 支撑 §2.4 slim 选型与 §7.1 体积基线 — 采用 slim；不装 Playwright 浏览器。
- [R24] Dockerfile 参考 — https://docs.docker.com/reference/dockerfile/ — 支撑 §2.5 `USER`/`EXPOSE`/`HEALTHCHECK` 与 §3.1 逐行意图 — 采用非 root 与内联探活；不用多架构 `--platform`。
- [R25] Docker 多阶段构建 — https://docs.docker.com/build/building/multi-stage/ — 支撑 §2.2 两阶段拆分与 §2.3 层缓存 — 采用 builder/runtime 分离；不保留源码构建层。
- [R26] Compose 服务定义 — https://docs.docker.com/reference/compose-file/services/ — 支撑 §3.3 healthcheck、depends_on 条件与卷定义 — 采用 `service_healthy` 依赖；不用 `deploy.replicas`。
- [R27] Compose profiles — https://docs.docker.com/reference/compose-file/profiles/ — 支撑 §3.3 `crawler`/`full` 两档 — 直接采用。
- [R58] jessfraz/dockerfiles — https://github.com/jessfraz/dockerfiles — 支撑 §2.5 非 root 用户与目录属主写法 — 借鉴普通用户建法；不照搬其桌面用途的系统包集合。
- [R59] hadolint — https://github.com/hadolint/hadolint — 支撑 §2.3 构建前静态检查 — 借鉴 Dockerfile lint 思路；不要求把它装进镜像。
- [R60] peter-evans/docker-compose-healthcheck — https://github.com/peter-evans/docker-compose-healthcheck — 支撑 §3.4 健康检查与服务依赖等待 — 借鉴 healthcheck 挂载与等待模式；不引入其中的第三方依赖容器。
- [R61] healthchecks/healthchecks — https://github.com/healthchecks/healthchecks — 支撑 §3.5 后台轮次外部监控思路 — 借鉴「周期任务可被外部探活」；本轮不引入独立监控服务。
