#!/usr/bin/env bash
# SQLite 在线备份：inspect 门禁 → 基线指纹 → 在线快照/VACUUM INTO → quick_check → manifest。
set -u
set -o pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=src/common.sh
source "$SELF_DIR/src/common.sh"
yxs_tool_init "backup-sqlite.sh"

SOURCE=""
OUT=""
HOST=""
METHOD="auto"
LABEL=""
SAMPLE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      yxs_need_value --source $# "SQLite 源库路径"; SOURCE="$2"; shift 2 ;;
    --out)
      yxs_need_value --out $# "备份根目录"; OUT="$2"; shift 2 ;;
    --host)
      yxs_need_value --host $# "主机名"; HOST="$2"; shift 2 ;;
    --method)
      yxs_need_value --method $# "备份方法"; METHOD="$2"; shift 2 ;;
    --label)
      yxs_need_value --label $# "备注"; LABEL="$2"; shift 2 ;;
    --sample)
      yxs_need_value --sample $# "抽样行数"; SAMPLE="$2"; shift 2 ;;
    *)
      yxs_die 1 "未知参数：$1。" ;;
  esac
done

yxs_need_arg --source "$SOURCE" "SQLite 源库路径"

case "$METHOD" in
  auto|backup|vacuum) ;;
  *) yxs_die 1 "备份方法必须是 auto、backup 或 vacuum。" ;;
esac

yxs_sample "$SAMPLE"
SAMPLE="$YXS_SAMPLE_OUT"

# 受保护真实数据目录（先于存在性判断：命中即拒，不 stat 真实目录）
if yxs_is_protected "$SOURCE"; then
  yxs_die 1 "源路径位于受保护的真实数据目录，请改用 .scratch/run/G/ 下的副本：${SOURCE}。"
fi

# 源文件存在性
[[ -f "$SOURCE" ]] || yxs_die 1 "找不到源数据库文件：${SOURCE}。"

# inspect：schema 版本门禁 + 期望表集合门禁
INSPECT="$(yxs_py inspect-sqlite --path "$SOURCE")" \
  || yxs_die 2 "打开源数据库失败：${SOURCE}。"

UV="$(printf '%s' "$INSPECT" | sed -n 's/.*"userVersion": *\(-\?[0-9]\+\).*/\1/p')"
[[ "$UV" == "7" ]] \
  || yxs_die 2 "源库 schema 版本为 ${UV}，预期 7；请先在桌面端或 seed 流程跑齐本地迁移。"

for t in $YXS_EXPECTED_TABLES; do
  printf '%s' "$INSPECT" | grep -q "\"name\": *\"$t\"" \
    || yxs_die 2 "源数据库缺少表 ${t}。"
done

# 目录分层：<root>/<host>/<pathSlug>/<timestamp>
HOST_SLUG="$(yxs_slug_host "${HOST:-$(hostname)}")"
PATH_SLUG="$(yxs_path_slug "$SOURCE")"
STAMP="$(yxs_utc_stamp)"
CREATED_AT="$(yxs_utc_iso)"
ROOT_OUT="${OUT:-$(yxs_backup_root)}"
DEST_DIR="$ROOT_OUT/$HOST_SLUG/$PATH_SLUG/$STAMP"
mkdir -p "$DEST_DIR/samples" \
  || yxs_die 2 "备份目录创建失败：${DEST_DIR}/samples。"

DB_NAME="$(basename "$SOURCE")"
ARTIFACT="$DEST_DIR/$DB_NAME.sqlite"

# 基线指纹（在源库上做）；tables 数组走 mktemp 临时文件，不落备份目录
TMP_TABLES="$(yxs_tmpdir)/tables.json"
FP="$(yxs_py fingerprint-sqlite --path "$SOURCE" --out "$DEST_DIR" \
  --tables-file "$TMP_TABLES" --sample "$SAMPLE")" \
  || yxs_die 2 "打开源数据库失败：${SOURCE}。"

# 在线快照（auto：CLI .backup → Python backup() → VACUUM INTO；backup：在线分支；vacuum：VACUUM INTO）
BK="$(yxs_py backup-sqlite --src "$SOURCE" --dst "$ARTIFACT" --method "$METHOD")" \
  || yxs_die 2 "备份命令失败：sqlite3 backup：源库 ${SOURCE}。"
METHOD_USED="$(printf '%s' "$BK" | sed -n 's/.*"method": *"\([a-z]*\)".*/\1/p')"
SQLITE_VER="$(printf '%s' "$BK" | sed -n 's/.*"sqliteVersion": *"\([^"]*\)".*/\1/p')"

# 备份产物 quick_check（备份侧不跑 integrity_check）
QC="$(yxs_py check-sqlite --path "$ARTIFACT" --level quick)"
QC_RC=$?
if [[ $QC_RC -ne 0 ]]; then
  FIRST="$(printf '%s' "$QC" | sed -n 's/.*"first": *"\(.*\)".*/\1/p')"
  # 引擎自身退出 2 属环境/工具类，与「产物损坏」（3）分开归类。
  [[ $QC_RC -eq 2 ]] && yxs_die 2 "校验命令执行失败：check-sqlite --path ${ARTIFACT} --level quick：${FIRST}。"
  yxs_die 3 "备份产物快速校验未通过：${ARTIFACT}：${FIRST}。"
fi

BYTES="$(yxs_bytes "$ARTIFACT")"
SHA="$(yxs_sha256 "$ARTIFACT")"
[[ -n "$BYTES" && -n "$SHA" ]] \
  || yxs_die 2 "读取备份产物字节数/哈希失败：${ARTIFACT}。"
TABLE_COUNT="$(grep -o '"name"' "$TMP_TABLES" | wc -l | tr -d ' ')"

# 客户端版本记录（无 sqlite3 CLI 时记 Python stdlib sqlite 版本）
if command -v sqlite3 >/dev/null 2>&1; then
  CV="sqlite3=$(sqlite3 --version | awk '{print $1}')"
else
  CV="python-sqlite=${SQLITE_VER}"
fi

MANIFEST="$DEST_DIR/manifest.json"
MANIFEST_OUT="$(yxs_py manifest \
  --out "$MANIFEST" \
  --kind sqlite \
  --host "$HOST_SLUG" \
  --source "$SOURCE" \
  --db-name "$DB_NAME" \
  --schema-version "$UV" \
  --label "$LABEL" \
  --tool "backup-sqlite.sh" \
  --version "$(yxs_version)" \
  --client-versions "$CV" \
  --artifact "$ARTIFACT" \
  --format sqlite-copy \
  --tables "$TMP_TABLES" \
  --quick ok \
  --integrity null \
  --drill-ref null \
  --created-at "$CREATED_AT")" \
  || yxs_die 2 "写出 manifest 失败：${MANIFEST}。"
[[ -z "$MANIFEST_OUT" ]] || MANIFEST="$MANIFEST_OUT"

rm -f "$TMP_TABLES" || yxs_warn "临时文件清理失败：${TMP_TABLES}。"

yxs_log "source=$SOURCE"
yxs_log "method=$METHOD_USED"
yxs_log "artifact=$ARTIFACT"
yxs_log "bytes=$BYTES sha256=$SHA"
yxs_log "quick_check=ok"
yxs_log "tables=$TABLE_COUNT"
yxs_log "manifest=$MANIFEST"
