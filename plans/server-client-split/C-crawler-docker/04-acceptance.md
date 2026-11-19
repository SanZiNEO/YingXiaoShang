# C · 采集服务 Docker 化 · 验收

> 轮次：C · 采集服务 Docker 化
> 文档角色：04-acceptance
> 冻结口径：[`../00-master/01-frozen-contracts.md`](../00-master/01-frozen-contracts.md) v1
> 写权：[`../00-master/02-ownership-and-parallel.md`](../00-master/02-ownership-and-parallel.md) §1
> 一句话：14 条 AC 全部命令可复现；每条都有明确的失败判据与证据落点，不靠「看着正常」判过。

## 1 验收口径

**过 = 下列三组同时成立**：

1. **硬指标**：`docker compose --profile crawler up -d` 后采集容器 `healthy`；容器内 `/health` 返回 200 且 `ok:true`；进程 UID 为 `10001`；镜像 `< 400 MB`；`restart` 与 `down`（不带 `-v`）再 `up` 后数据仍在；单轮脚本可跑；采集侧写库不越出三张表边界。
2. **反向验证**：§5 的 5 个 mutation 每个都能让指定 AC 变红；改回后变绿。
3. **证据**：每条 AC 在 `.scratch/run/C/` 留下命令原文与输出原文（compose 日志、体积输出、表清单、环境变量快照）。

不可替代项（不能用手工点一遍代替）：非 root UID、命名卷保卷、healthcheck unhealthy 判定、`.dockerignore` 排除生效、表清单越界核对。

可机器判定的断言才写进 AC，「服务看起来正常」这类人工观察不作为通过依据 [R36]。400 MB 体积判据来自 C 轮完成定义（`02-ownership-and-parallel.md` §4）。

## 2 前置条件

```powershell
cd E:\Documents\GitHub\YingXiaoShang

# 1) Docker 引擎可用（本机 Desktop 或远程 engine）
docker version

# 2) 准备本轮证据目录（不碰真实数据目录）
New-Item -ItemType Directory -Force .scratch\run\C | Out-Null

# 3) 验收用独立 project 名 yxs-c，避免与共享 yxs project 撞容器/卷
#    命令统一形式：
#    docker compose -p yxs-c -f services/deploy/compose.yml --profile crawler ...

# 4) 端口预检：8787 被占时按 +100 退避（8787 → 8887），并在报告写明实际端口
netstat -ano | findstr :8787
```

缺什么就明说「缺则跳过并标记」：

- 无 Docker 引擎 → AC-01 至 AC-06、AC-11 至 AC-13 标记 `skipped: no docker`，只保留静态核对（AC-07、AC-09 的源码侧 grep）。
- 宿主不是 Linux、没有 cron 守护 → AC-07 的 crontab 安装部分标记 `skipped: host non-linux`，只做条目五段格式与脚本路径静态核对。
- 无真实新闻源网络出口 → AC-08 允许用 `--source` 指定可达的快源或假源；整轮入库条数记 `0` 不算失败，失败判据只看退出码与统计行是否落库。

环境变量样例来自 `services/deploy/.env.example`；验收前可复制为 `.env` 再改，`.env` 不进版本库 [R6]。

## 3 用例清单

验收容器名固定 `yxs-crawler-c`（project `yxs-c`，命名对照见 `02-contract.md` §3.1）；下文 `<c>` 指代该容器，等价于 `yxs-crawler-c`。

| 编号 | 操作 | 期望输出 | 失败判据 | 证据文件 |
|---|---|---|---|---|
| AC-01 | `docker compose -p yxs-c -f services/deploy/compose.yml --profile crawler up -d`，随后 `ps` | crawler 状态 `healthy`；网络 `yxs-net`、卷 `yxs-data`（project 内为 `yxs-c_yxs-data`）已创建 | `unhealthy`、`exited`；超过 `start_period` + 3 次重试仍 `starting` | `C/compose-ps.txt`、`C/compose-up.log` |
| AC-02 | 宿主：`curl.exe -s http://127.0.0.1:8787/health`；容器内：`docker exec <c> python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8787/health', timeout=5).status)"` | 宿主与容器内均 200；JSON `ok:true`，含 `host/port/sources`（处理器见 `http_api.py:174-183`，路由见 `http_api.py:127-128`） | 连接拒绝；非 200；`ok:false`；缺 `sources` 字段 | `C/health.json`、`C/health-in-container.txt` |
| AC-03 | `docker exec <c> id -u`；`docker exec <c> id -un` | `id -u` 输出 `10001`；用户名非 `root` | 输出 `0`；用户名为 `root` | `C/id.txt` |
| AC-04 | `docker images --format "{{.Repository}}:{{.Tag}} {{.Size}}" \| findstr yxs-crawler`；`docker image inspect yxs-crawler:local --format "{{.Size}}"` | 镜像名 `yxs-crawler:local`；体积 `< 400 MB`（inspect 字节数换算后 < 419430400） | 体积 ≥ 400 MB；镜像不存在；`Size` 字段为空 | `C/images.txt`、`C/size-inspect.txt` |
| AC-05 | 记基线：`docker exec <c> python -c "import sqlite3;c=sqlite3.connect('/data/data/learning.db');print(c.execute('SELECT COUNT(*) FROM news_articles').fetchone()[0])"`；`docker restart <c>`；再查计数 | 重启前后 `news_articles` 计数一致（重启后 ≥ 基线） | 计数归零；库文件丢失；重启后库打不开 | `C/restart-before.txt`、`C/restart-after.txt` |
| AC-06 | `docker compose -p yxs-c -f services/deploy/compose.yml down`（**禁止 `-v`**）；再 `--profile crawler up -d`；查 `news_articles` 计数与探针文件 | 计数仍在；`/data/.c-probe` 内容可读 | 计数归零；探针文件丢失；命令里出现 `-v` | `C/down-up-count.txt`、`C/probe.txt` |
| AC-07 | `bash -n services/deploy/scripts/run-round.sh`；静态核对 `cron/news-crawler.cron` 条目五段（分 时 日 月 周）与脚本路径；Linux 宿主再 `crontab -l` 核对已安装条目 | 脚本语法通过；cron 条目为 `*/30 * * * *` 五段；路径指向存在的 `run-round.sh`；宿主 crontab 可见该条目（Linux 环境） | `bash -n` 报错；条目段数 ≠ 5；脚本路径不存在；crontab 无条目 | `C/cron-check.txt` |
| AC-08 | `bash services/deploy/scripts/run-round.sh`（必要时先 `NEWS_CRAWLER_BASE_URL=http://127.0.0.1:8787`） | 退出码 0；`source_runs` 出现新一行（`trigger` 为 `manual` 或 `schedule`）；`/stats` 能读到本轮 `duration_ms/inserted/errors` | 退出码非 0；无新统计行；脚本路径/`docker compose` 调用失败 | `C/round-stats.jsonl`、`C/round-run.log` |
| AC-09 | 容器内列清单：`docker exec <c> python -c "import sqlite3;c=sqlite3.connect('/data/data/learning.db');print(sorted(r[0] for r in c.execute(\"SELECT name FROM sqlite_master WHERE type='table'\")))"`；源码侧：`Select-String -Path services\news-crawler-py\src\news_crawler\*.py -Pattern "news_articles|source_runs|news_tags|case_matches|ideology_tags"` | 采集 DDL 只建 `news_articles`、`source_runs`（schema 见 `db.py:24-57`）；DML 表集合 ⊆ 写入三表 + 两张草稿清理表；`chapters/knowledge_points/questions/student_profiles/artifacts/chat_sessions` 等业务表在采集源码中零引用（共享库业务表基线见 `packages/db/src/index.ts:92-436`） | 采集代码出现对业务表的 INSERT/UPDATE/DELETE；采集自建业务表；`news_tags` 被采集侧新建 | `C/table-list.txt`、`C/table-refs.txt` |
| AC-10 | `docker exec <c> printenv`；对照启动日志 `DB=` 行 | 含 `LEARNING_AGENT_HOME=/data`、`NEWS_CRAWLER_PORT=8787`、`NEWS_CRAWLER_DB=/data/data/learning.db`、`NEWS_CRAWLER_WORKERS=8`；日志 DB 路径与 env 一致（启动横幅见 `cli.py:195-199`） | 变量缺失；DB 路径落到容器临时层；端口 env 与控制面实际监听端口不一致 | `C/env.txt` |
| AC-11 | `docker run --rm yxs-crawler:local sh -c "ls /app; ls /app/scripts 2>/dev/null; ls /app/.venv 2>/dev/null; find /app -name '__pycache__' -o -name '*.pyc' -o -name '*.db' -o -name '*.jsonl'"` | 无 `.venv`、无 `scripts/`（不含 `quality_report.py`）、无 `__pycache__/*.pyc`、无 `*.db/*.jsonl` | 镜像内出现宿主 venv；出现 `scripts/quality_report.py`；混入本地库或 JSONL | `C/ignore-check.txt` |
| AC-12 | 写探针：`docker exec <c> sh -c "echo probe-ok > /data/.c-probe"`；`down` 再 `up -d`；`docker exec <c> cat /data/.c-probe` | 重建后探针文件内容仍为 `probe-ok` | 文件丢失；卷被重建为空 | `C/probe-rebuild.txt` |
| AC-13 | 受控实验：临时把 healthcheck 测试指向未监听端口（或容器内停止主进程），观察 compose 状态；实验后还原 | 探针退出非 0；容器状态转 `unhealthy`；`depends_on: service_healthy` 的服务端在 unhealthy 时不会被拉起 | healthcheck 失败仍报 `healthy`；无 `unhealthy` 状态流转 | `C/unhealthy.txt`、`C/healthcheck-restored.txt` |
| AC-14 | `docker compose -p yxs-c logs crawler`；容器内列日志文件：`docker exec <c> sh -c "find /app /data -name '*.log' 2>/dev/null"` | 启动横幅与轮次结果在容器 stdout（`docker logs` 可见）；容器内无自写 `.log` 文件 | 日志只写文件、stdout 为空；容器内出现持久化日志文件 | `C/logs-stdout.txt` |

用例写法遵循「一条 AC 一个可观察结果 + 明确失败判据」；状态流转与依赖等待的 compose 口径参照健康检查样例 [R60]。

## 4 证据

- 落点：`.scratch/run/C/`，每条 AC 一个证据文件（文件名见 §3 末列）。证据存「命令原文 + 输出原文」，不存截图，便于在 CI 里复盘 [R36]。
- 统一采集目录已在 §2 创建；复跑前先清空旧证据，避免上一轮输出污染本轮判断。
- 关键采集命令（PowerShell，仓库根）：

```powershell
cd E:\Documents\GitHub\YingXiaoShang
$out = ".scratch\run\C"

# AC-01 / AC-14
docker compose -p yxs-c -f services/deploy/compose.yml --profile crawler up -d *> "$out\compose-up.log"
docker compose -p yxs-c -f services/deploy/compose.yml ps | Tee-Object "$out\compose-ps.txt"
docker compose -p yxs-c logs crawler | Tee-Object "$out\logs-stdout.txt"

# AC-02
curl.exe -s http://127.0.0.1:8787/health -o "$out\health.json"

# AC-03
docker exec yxs-crawler-c id -u | Tee-Object "$out\id.txt"

# AC-04
docker images --format "{{.Repository}}:{{.Tag}} {{.Size}}" | findstr yxs-crawler | Tee-Object "$out\images.txt"
docker image inspect yxs-crawler:local --format "{{.Size}}" | Tee-Object "$out\size-inspect.txt"

# AC-09 表清单与源码引用
docker exec yxs-crawler-c python -c "import sqlite3;c=sqlite3.connect('/data/data/learning.db');print(sorted(r[0] for r in c.execute(\"SELECT name FROM sqlite_master WHERE type='table'\")))" | Tee-Object "$out\table-list.txt"
Select-String -Path services\news-crawler-py\src\news_crawler\*.py -Pattern "news_articles|source_runs|news_tags|case_matches|ideology_tags" | Tee-Object "$out\table-refs.txt"
```

- 复跑要求：所有 AC 在同一个 `yxs-c` project 上可重复执行；第二次跑前不删命名卷（AC-05/06/12 依赖跨重启数据），只清证据目录。
- 结构化日志走 stdout 落容器日志驱动，不在镜像内配日志文件路径 [R6]。

## 5 反向验证（mutation）

| # | 改坏哪里 | 预期变红的 AC | 还原后 |
|---|---|---|---|
| M1 | Dockerfile 删掉 `USER 10001`（或注释 `USER` 行），重建镜像 | AC-03：`id -u` 输出 `0`；AC-11 若顺带以 root 建缓存目录也会暴露 | 变绿 |
| M2 | compose `volumes` 把命名卷 `yxs-data:/data` 改成匿名卷（只写 `/data` 不挂名），或验收时误加 `down -v` | AC-06、AC-12：`down` 后探针文件与计数丢失 | 变绿 |
| M3 | 删掉 compose 服务的 `healthcheck` 块（或删掉 Dockerfile 内联 HEALTHCHECK） | AC-01、AC-13：`up` 后无法进入 `healthy`，`service_healthy` 依赖判据失效 | 变绿 |
| M4 | `.dockerignore` 放开 `.venv/`、`scripts/`、`.scratch/` 三条 | AC-11：镜像内出现宿主 venv / `quality_report.py` / 探针库；AC-04 体积随之上浮 | 变绿 |
| M5 | `healthcheck.sh` 里探测 URL 端口改成未监听端口（如 9999） | AC-02、AC-13：探针恒退 1，容器转 `unhealthy` | 变绿 |

执行约定：

```powershell
cd E:\Documents\GitHub\YingXiaoShang
git status --porcelain        # 确认只改动预期的本轮文件
# 手工改坏 → 跑对应 AC → 记录失败输出到 .scratch/run/C/mutation-<n>/
# 还原文件 → 再跑 → 记录通过输出
git status --porcelain        # 除 .scratch 与本轮 plans 文档外应为空
```

mutation 判据用「killed / survived」：用例变红 = killed，仍绿 = survived（说明用例没覆盖到这条契约）；术语参照 mutation 测试实践 [R52]，本轮只做 5 个手写改坏点，不引入 mutation 运行时。

## 6 排查表

| 症状 | 最可能原因 | 一条命令确认 |
|---|---|---|
| 容器一直 `starting` 后 `unhealthy` | 主进程没起 / `/health` 不通 / 库打不开 | `docker compose -p yxs-c logs crawler`；`docker exec <c> python /app/scripts/healthcheck.sh; echo $?` |
| `ps` 是 `healthy` 但宿主 `curl /health` 拒绝 | 端口映射或监听地址错（容器内仍绑 127.0.0.1） | `docker exec <c> python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8787/health').status)"`；看 compose `command` 的 `--host` |
| 镜像体积 ≥ 400 MB | `.dockerignore` 漏排 venv / scratch / 本地库 | `docker history yxs-crawler:local --format "{{.Size}} {{.Comment}}"`；AC-11 列镜像内大目录 |
| 容器内写 `/data` 报权限拒绝 | 卷属主不是 10001（bind mount 场景常见） | `docker exec <c> id -u`；`docker exec <c> ls -ld /data` |
| `down` 再 `up` 后数据没了 | 用了匿名卷，或执行了 `down -v` | 看 compose `volumes` 是否命名卷；`docker volume ls \| findstr yxs-data` |
| cron 到点没跑 | 脚本路径错 / 无可执行位 / crontab 未安装 | `bash -n services/deploy/scripts/run-round.sh`；Linux 宿主 `crontab -l`；手工执行一次看退出码 |
| 宿主 8787 起不来 | 端口被占（本机可能已有桌面端侧车） | `netstat -ano \| findstr :8787`；按 +100 退避改宿主映射端口 |
| builder 阶段 lxml 装不上 | slim 缺编译工具且无对应 wheel | 看 builder 日志 `pip install` 报错；确认 lxml 走 manylinux wheel 而非源码编译 |
| `/stats` 本轮 `errors` 偏高 | 上游源反爬 / 改版 / 详情超时 | `curl "http://127.0.0.1:8787/stats?limit=10"` 看 `failures` 明细 |
| 环境变量没进容器 | compose `environment` 漏写或 `.env` 未加载 | `docker exec <c> printenv`；`docker compose -p yxs-c config` 渲染核对 |

排查表按「症状 → 最可能原因 → 一条确认命令」组织；健康类症状必须落到 `/health` 原文与容器状态上，不看平均值 [R60]。

## 7 自检输出

文档自检是交活前的最后一道机器闸：它只查结构、节数、引用与本地行号是否对得上，查不到内容对不对——内容由 §3 的 14 条 AC 负责。机器查形式、人查语义的分工同测试实践的底线要求 [R36]。

```powershell
cd E:\Documents\GitHub\YingXiaoShang
python plans\server-client-split\00-master\check-docs.py --round C
```

实跑输出（2026-11-19，退出码 0）：

```text
仓库根：E:\Documents\GitHub\YingXiaoShang
检查轮次：C
行数统计：
  C-*: 1086 行 / 4 份

全部通过：轮次齐全、节数达标、每节有引用、参考清单与本地行号引用都对得上。
退出码：0
```

> 说明：本轮子代理只写 `03-implementation.md` 与 `04-acceptance.md` 两份；`01-scope.md`、`02-contract.md` 由并行任务落盘后，本轮重跑脚本已四份齐备并通过。若后续文档有增删，以主代理在四份齐备后的最终一次重跑输出为准。

## 参考

- [R6] 12-Factor · Logs — https://12factor.net/logs — 支撑 §2 配置外置与 §3 AC-14 日志走 stdout — 直接采用；不引入日志聚合服务。
- [R23] Docker 官方 Python 镜像 — https://hub.docker.com/_/python — 支撑 §3 AC-04 体积基线与 §6 排查镜像分层 — 采用 slim；不装浏览器。
- [R24] Dockerfile 参考 — https://docs.docker.com/reference/dockerfile/ — 支撑 §5 M1 非 root 改坏点与 §6 权限排查 — 采用 `USER` 与指令语义。
- [R26] Compose 服务定义 — https://docs.docker.com/reference/compose-file/services/ — 支撑 §3 AC-01/13 healthcheck 与依赖条件 — 采用 `service_healthy`。
- [R27] Compose profiles — https://docs.docker.com/reference/compose-file/profiles/ — 支撑 §3 `--profile crawler` 起服务 — 直接采用。
- [R36] JavaScript Testing Best Practices — https://github.com/goldbergyoni/javascript-testing-best-practices — 支撑 §1 可机器判定口径与 §3 用例写法 — 采用可执行断言，不用人工观察。
- [R52] Stryker JS — https://github.com/stryker-mutator/stryker-js — 支撑 §5 mutation 范式 killed/survived — 借鉴范式；不引入 Stryker 运行时。
- [R58] jessfraz/dockerfiles — https://github.com/jessfraz/dockerfiles — 支撑 §3 AC-03 非 root 核对与 §5 M1 — 借鉴普通用户写法。
- [R60] peter-evans/docker-compose-healthcheck — https://github.com/peter-evans/docker-compose-healthcheck — 支撑 §3 AC-13 健康状态流转与 §6 排查表 — 借鉴健康检查等待模式。
- [R61] healthchecks/healthchecks — https://github.com/healthchecks/healthchecks — 支撑 §3 AC-07 周期任务外部监控思路 — 借鉴「周期任务可被探活」；不引入独立监控服务。
