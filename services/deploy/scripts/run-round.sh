#!/usr/bin/env bash
# Single-round trigger for the news crawler.
#
# Path 1: control plane reachable -> POST /run (wait=true) to the running
#         service; exit 0 if at least one round status is not "failure",
#         exit 1 if all rounds failed or the request failed.
# Path 2: control plane unreachable -> run `news-crawler once` through the
#         first available channel: `docker compose exec`, installed CLI, or
#         `python -m news_crawler`.
#
# Exit codes align with the CLI: 0 success / 1 all failed / 2 missing DB
# target or no usable channel / 130 interrupted by SIGINT.
# Logs go to stdout/stderr only; no log files are written.

set -uo pipefail

trap 'exit 130' INT

# 库路径有两个语境，不能共用一个默认值：容器内固定 /data/data/learning.db
# （冻结 §10.3），而宿主上通常没有 /data，拿它当本地路径会写到根目录或直接权限拒绝。
# NEWS_CRAWLER_DB 是容器侧变量名，只在 `docker compose exec` 那条路径上生效。
#
# 宿主兜底按冻结 §10.2 的「<home>/data/learning.db」派生，且必须落到明确的用户目录：
# 早先用 `${HOME:-.}` 兜底，HOME 为空时（Git Bash / cron 精简环境常见）会退化成
# `./.learning-agent`，库文件位置随调用者的 cwd 漂移——cron 里就是随机目录。
# 现在三级都取不到就直接退出 2，不猜。
CONTAINER_DB="/data/data/learning.db"
if [ -n "${LEARNING_AGENT_HOME:-}" ]; then
    HOST_HOME="$LEARNING_AGENT_HOME"
elif [ -n "${HOME:-}" ]; then
    HOST_HOME="$HOME/.learning-agent"
elif [ -n "${USERPROFILE:-}" ]; then
    HOST_HOME="$USERPROFILE/.learning-agent"
else
    echo "run-round: 无法确定宿主数据目录（LEARNING_AGENT_HOME / HOME / USERPROFILE 均为空），未执行抓取" >&2
    exit 2
fi
HOST_DB="$HOST_HOME/data/learning.db"
if [ -n "${NEWS_CRAWLER_DB+set}" ]; then
    if [ -z "$NEWS_CRAWLER_DB" ]; then
        echo "run-round: NEWS_CRAWLER_DB 为空，缺少入库目标，未执行抓取" >&2
        exit 2
    fi
    CONTAINER_DB="$NEWS_CRAWLER_DB"
fi

# Base URL: explicit NEWS_CRAWLER_BASE_URL wins; otherwise derive from the
# same HOST/PORT pair the service reads, mapping listen-all addresses back to
# loopback (a client cannot request 0.0.0.0 directly).
PROBE_HOST="${NEWS_CRAWLER_HOST:-127.0.0.1}"
if [ "$PROBE_HOST" = "0.0.0.0" ] || [ "$PROBE_HOST" = "::" ] || [ -z "$PROBE_HOST" ]; then
    PROBE_HOST="127.0.0.1"
fi
BASE_URL="${NEWS_CRAWLER_BASE_URL:-http://${PROBE_HOST}:${NEWS_CRAWLER_PORT:-8787}}"

# Locate a Python interpreter for the stdlib health probe and /run POST.
# `command -v` 不足以判断可用：Windows 上 python3/python 可能是 Store 占位别名，
# 能被 command -v 找到却一执行就退出（本机实测退出码 49）。所以每个候选都真跑一次。
PY_BIN=""
for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 \
        && "$candidate" -c "import sys; sys.exit(0)" >/dev/null 2>&1; then
        PY_BIN="$candidate"
        break
    fi
done

# Collect repeated --source ID arguments for the /run body; the remaining
# arguments are forwarded unchanged to the fallback `once` invocation.
SOURCES=()
args=("$@")
i=0
while [ "$i" -lt "${#args[@]}" ]; do
    case "${args[$i]}" in
        --source)
            if [ "$((i + 1))" -lt "${#args[@]}" ]; then
                SOURCES+=("${args[$((i + 1))]}")
                i=$((i + 2))
            else
                i=$((i + 1))
            fi
            ;;
        --source=*)
            SOURCES+=("${args[$i]#--source=}")
            i=$((i + 1))
            ;;
        *)
            i=$((i + 1))
            ;;
    esac
done

# ---- Path 1: control plane reachable -------------------------------------

reachable=0
if [ -n "$PY_BIN" ]; then
    if "$PY_BIN" - "$BASE_URL" <<'PYEOF'
import sys
import urllib.request

base = sys.argv[1].rstrip("/")
try:
    with urllib.request.urlopen(base + "/health", timeout=5) as resp:
        if getattr(resp, "status", None) != 200:
            sys.exit(1)
except Exception:
    sys.exit(1)
sys.exit(0)
PYEOF
    then
        reachable=1
    fi
fi

if [ "$reachable" = "1" ]; then
    export RUN_ROUND_SOURCES="${SOURCES[*]:-}"
    "$PY_BIN" - "$BASE_URL" <<'PYEOF'
import json
import os
import sys
import urllib.request

base = sys.argv[1].rstrip("/")

raw = os.environ.get("RUN_ROUND_SOURCES", "")
sources = [s for s in raw.split() if s]
body = {"wait": True}
if sources:
    body["sources"] = sources
data = json.dumps(body).encode("utf-8")
req = urllib.request.Request(
    base + "/run",
    data=data,
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=180) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
except Exception as error:
    print("run-round: POST /run 失败: {}".format(error), file=sys.stderr)
    sys.exit(1)

if payload.get("ok") is not True:
    print("run-round: 控制面返回 ok=false", file=sys.stderr)
    sys.exit(1)

rounds = payload.get("rounds") or []
if not rounds:
    print("run-round: 响应中没有 rounds 明细", file=sys.stderr)
    sys.exit(1)

failed = True
for round_ in rounds:
    status = str(round_.get("status", ""))
    source = str(round_.get("source", ""))
    print("run-round: {} {}".format(source, status))
    if status != "failure":
        failed = False

sys.exit(0 if not failed else 1)
PYEOF
    exit $?
fi

# ---- Path 2: control plane unreachable -------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/../compose.yml"

if command -v docker >/dev/null 2>&1 && [ -f "$COMPOSE_FILE" ]; then
    # crawler 服务只在 crawler/full 两个 profile 下存在；不带 --profile 时
    # `ps` 看不到它、`exec` 会报 no such service，脚本会白白掉到本地 CLI 分支。
    # 只用 crawler 档：单轮触发不需要拉起服务端。
    COMPOSE_CMD=(docker compose -f "$COMPOSE_FILE" --profile crawler)
    # Only use compose exec when the crawler service is actually running.
    # A host with the docker CLI but no daemon (or a stopped stack) must fall
    # through to the local CLI instead of failing inside docker.
    if "${COMPOSE_CMD[@]}" ps --status running --format '{{.Service}}' \
        2>/dev/null | grep -qx crawler; then
        exec "${COMPOSE_CMD[@]}" exec -T crawler \
            news-crawler once --db "$CONTAINER_DB" "$@"
    fi
fi

if command -v news-crawler >/dev/null 2>&1; then
    exec news-crawler once --db "$HOST_DB" "$@"
fi

if [ -n "$PY_BIN" ] && "$PY_BIN" -c "import news_crawler" >/dev/null 2>&1; then
    exec "$PY_BIN" -m news_crawler once --db "$HOST_DB" "$@"
fi

echo "run-round: 找不到 docker / news-crawler / python 可用路径，无法执行单轮" >&2
exit 2