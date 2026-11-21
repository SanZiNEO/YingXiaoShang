#!/usr/bin/env bash
# restore-pg.sh — PostgreSQL 恢复到隔离新库（G 轮）
# 硬约束：不使用清理类开关；目标必须是新建的 yxs_g_ 前缀库；源库全程只读。
set -u
set -o pipefail

_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
YXS_LIB_PATH="${YXS_LIB_PATH:-$_SCRIPT_DIR/src/common.sh}"
# shellcheck source=/dev/null
. "$YXS_LIB_PATH"

yxs_tool_init restore-pg.sh

# PGHOST/PGPORT/PGDATABASE/PGUSER 与 YXS_G_SAMPLE 的默认值由 src/common.sh 统一给出
# 并 export（子进程 createdb/pg_restore/psql 靠环境变量连接）；此处不再重复兜底。

BACKUP=""
TARGET_DB_ARG=""
SAMPLE_ARG=""

# 硬约束：调用方显式传入清理类开关 → 退出 1。
# 判断走变量比较；这两个词永远不会出现在 pg_restore 的实际命令行里。
BANNED_1="--clean"
BANNED_2="--if-exists"
for ARG in "$@"; do
  if [ "$ARG" = "$BANNED_1" ] || [ "$ARG" = "$BANNED_2" ]; then
    yxs_die 1 "禁止在恢复时使用 --clean；恢复目标必须是新建的隔离库。"
  fi
done

while [ $# -gt 0 ]; do
  case "$1" in
    --backup)
      yxs_need_value "--backup" "$#" "备份产物路径"
      BACKUP="$2"; shift 2 ;;
    --target-db)
      yxs_need_value "--target-db" "$#" "恢复目标库名"
      TARGET_DB_ARG="$2"; shift 2 ;;
    --sample)
      yxs_need_value "--sample" "$#" "抽样行数"
      SAMPLE_ARG="$2"; shift 2 ;;
    *)
      yxs_die 1 "未知参数：$1。" ;;
  esac
done

yxs_need_arg "--backup" "$BACKUP" "备份产物路径"
yxs_sample "${SAMPLE_ARG:-}"
SAMPLE="${YXS_SAMPLE_OUT}"

# ---- 目标库名合规：^yxs_g_[a-z0-9_]+$，且不在受保护库清单（参数闸，先于环境探测）----
TS="$(yxs_utc_stamp)"
TS_LOW="$(printf '%s' "$TS" | tr 'TZ' 'tz')"
TARGET_DB="${TARGET_DB_ARG:-yxs_g_restore_$TS_LOW}"
case "$TARGET_DB" in
  yxs|postgres|template0|template1)
    yxs_die 1 "目标库名只能以 yxs_g_ 开头，后跟小写字母、数字或下划线：$TARGET_DB。" ;;
esac
if ! [[ "$TARGET_DB" =~ ^yxs_g_[a-z0-9_]+$ ]]; then
  yxs_die 1 "目标库名只能以 yxs_g_ 开头，后跟小写字母、数字或下划线：$TARGET_DB。"
fi

# ---- 客户端工具探测 ----
yxs_require_cmd createdb
yxs_require_cmd pg_restore
yxs_require_cmd psql

# ---- 备份产物可读（custom 格式 TOC 可列）----
if [ ! -f "$BACKUP" ]; then
  yxs_die 2 "备份产物无法打开：$BACKUP：文件不存在。"
fi
PROBE_ERR="$(mktemp)"
if ! pg_restore -l "$BACKUP" >/dev/null 2>"$PROBE_ERR"; then
  reason="$(head -1 "$PROBE_ERR" | tr -d '\r')"
  [ -z "$reason" ] && reason="目录列表不可读"
  rm -f "$PROBE_ERR"
  yxs_die 2 "备份产物无法打开：$BACKUP：$reason。"
fi
rm -f "$PROBE_ERR"

TMP="$(yxs_tmpdir)"
trap 'rm -rf "$TMP"' EXIT

# ---- 目标库是否已存在（只读探测；存在即退出 1，不覆盖、不清理）----
EXIST_ERR="$TMP/exists.err"
EXISTS="$(psql -X -q -A -t -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '$TARGET_DB'" 2>"$EXIST_ERR")" || {
  reason="$(head -1 "$EXIST_ERR" | tr -d '\r')"
  yxs_die 2 "无法连接 PostgreSQL：$reason。请检查 PGHOST、PGPORT、PGUSER、PGPASSWORD。"
}
if [ "$EXISTS" = "1" ]; then
  yxs_die 1 "目标库已存在，为避免覆盖未执行恢复：$TARGET_DB。"
fi

# ---- 源库行数采集（只读；恢复后复核是否变化）----
collect_source_rows() {
  local out="$1" db="$2"
  local enum_sql="SELECT n.nspname, c.relname, COALESCE((
    SELECT string_agg(a.attname, ',' ORDER BY k.ord)
    FROM unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
  ), 'ctid')
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_index ix ON ix.indrelid = c.oid AND ix.indisprimary
  WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  ORDER BY 1, 2;"
  psql -X -q -A -F'|' -t -d "$db" -c "$enum_sql" >"$TMP/src-tables.tsv" 2>"$TMP/src-enum.err" || return 1
  : >"$out" || return 1
  local schema table pk qual ident rows
  while IFS='|' read -r schema table pk; do
    [ -z "${schema:-}" ] && continue
    qual="$schema.$table"
    ident='"'"$schema"'".'"$table"'"'
    rows="$(psql -X -q -A -t -d "$db" -c "SELECT count(*) FROM $ident" 2>"$TMP/src-count.err" | tr -d '[:space:]')" || return 1
    printf '%s|%s\n' "$qual" "$rows" >>"$out"
  done <"$TMP/src-tables.tsv"
  return 0
}

SRC_BEFORE="$TMP/source-before.txt"
collect_source_rows "$SRC_BEFORE" "$PGDATABASE" \
  || yxs_die 2 "无法连接 PostgreSQL：读取源库行数失败。请检查 PGHOST、PGPORT、PGUSER、PGPASSWORD。"

# ---- createdb 新建隔离库 ----
CREATE_ERR="$TMP/createdb.err"
if ! createdb --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" "$TARGET_DB" 2>"$CREATE_ERR"; then
  reason="$(head -1 "$CREATE_ERR" | tr -d '\r')"
  if grep -qi 'already exists' "$CREATE_ERR"; then
    yxs_die 1 "目标库已存在，为避免覆盖未执行恢复：$TARGET_DB。"
  fi
  yxs_die 2 "备份命令失败：createdb --host=<host> --port=$PGPORT --username=<user> <db>：$reason。"
fi

yxs_log "target_db=$TARGET_DB"

# ---- pg_restore 到新库（固定参数；无清理类开关，不 DROP 源库对象）----
RESTORE_ERR="$TMP/restore.err"
if ! pg_restore --dbname="$TARGET_DB" --no-owner --no-privileges "$BACKUP" 2>"$RESTORE_ERR"; then
  reason="$(head -1 "$RESTORE_ERR" | tr -d '\r')"
  yxs_die 2 "备份命令失败：pg_restore --dbname=<db> --no-owner --no-privileges <dump>：$reason。"
fi

yxs_log "restore=$BACKUP"

# ---- 新库表枚举 + 行数/抽样指纹 ----
CAND_DIR="$TMP/candidate"
mkdir -p "$CAND_DIR" || yxs_die 2 "临时目录创建失败：${CAND_DIR}。"
CAND_RAW="$TMP/cand-tables.tsv"
ENUM_SQL="SELECT n.nspname, c.relname, COALESCE((
  SELECT string_agg(a.attname, ',' ORDER BY k.ord)
  FROM unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
), 'ctid')
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_index ix ON ix.indrelid = c.oid AND ix.indisprimary
WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY 1, 2;"

psql -X -q -A -F'|' -t -d "$TARGET_DB" -c "$ENUM_SQL" >"$CAND_RAW" 2>"$TMP/cand-enum.err" \
  || yxs_die 2 "无法连接 PostgreSQL：枚举恢复库表失败。请检查 PGHOST、PGPORT、PGUSER、PGPASSWORD。"

CAND_ENTRIES="$TMP/cand.entries"
: >"$CAND_ENTRIES" || yxs_die 2 "临时文件创建失败：${CAND_ENTRIES}。"
CAND_TABLE_COUNT=0

while IFS='|' read -r SCHEMA TABLE PK; do
  [ -z "${SCHEMA:-}" ] && continue
  QUAL="$SCHEMA.$TABLE"
  IDENT='"'"$SCHEMA"'".'"$TABLE"'"'

  ROWS="$(psql -X -q -A -t -d "$TARGET_DB" -c "SELECT count(*) FROM $IDENT" 2>"$TMP/cand-count.err" | tr -d '[:space:]')" \
    || yxs_die 2 "读取恢复库表 $QUAL 行数失败：$(head -1 "$TMP/cand-count.err" | tr -d '\r')。"

  if [ "$PK" = "ctid" ]; then
    ORDER_COLS="ctid"
  else
    ORDER_COLS="$(printf '%s' "$PK" | sed 's/,/, /g')"
  fi

  JSONL="$TMP/$TABLE.jsonl"
  SAMPLE_SQL="COPY (SELECT row_to_json(x) FROM (SELECT * FROM $IDENT ORDER BY $ORDER_COLS LIMIT $SAMPLE) x) TO STDOUT"
  psql -X -q -A -t -d "$TARGET_DB" -c "$SAMPLE_SQL" >"$JSONL" 2>"$TMP/cand-sample.err" \
    || yxs_die 2 "读取恢复库表 $QUAL 抽样失败：$(head -1 "$TMP/cand-sample.err" | tr -d '\r')。"

  ENTRY="$(yxs_py fingerprint-rows --table "$QUAL" --pk "$PK" --input "$JSONL" --out "$CAND_DIR" --sample "$SAMPLE" --rows "$ROWS")" || exit $?
  printf '%s\n' "$ENTRY" >>"$CAND_ENTRIES"
  CAND_TABLE_COUNT=$((CAND_TABLE_COUNT + 1))
done <"$CAND_RAW"

CAND_JSON="$CAND_DIR/tables.json"
{
  printf '{"tables":[\n'
  FIRST=1
  while IFS= read -r LINE; do
    [ -z "$LINE" ] && continue
    [ "$FIRST" -eq 0 ] && printf ',\n'
    printf '%s\n' "$LINE"
    FIRST=0
  done <"$CAND_ENTRIES"
  printf '],"samplesDir":"%s/samples"}\n' "$CAND_DIR"
} >"$CAND_JSON"

# ---- 对 manifest 基线做行数/抽样比对（dump 同目录 manifest.json）----
MANIFEST="$(dirname "$BACKUP")/manifest.json"
COMPARE_SKIPPED=0
if [ ! -f "$MANIFEST" ]; then
  yxs_warn "manifest 不存在，跳过行数与抽样核对：$MANIFEST"
  COMPARE_SKIPPED=1
else
  yxs_py compare --manifest "$MANIFEST" --candidate "$CAND_JSON" --sample "$SAMPLE" || exit $?
fi

# ---- 源库行数前后复核（只读）；逐表定位首张不一致表 ----
SRC_AFTER="$TMP/source-after.txt"
collect_source_rows "$SRC_AFTER" "$PGDATABASE" \
  || yxs_die 2 "无法连接 PostgreSQL：读取源库行数失败。请检查 PGHOST、PGPORT、PGUSER、PGPASSWORD。"

declare -A AFTER_ROWS=()
while IFS='|' read -r q r; do
  [ -z "${q:-}" ] && continue
  AFTER_ROWS["$q"]="$r"
done <"$SRC_AFTER"

DIFF_TABLE=""
DIFF_BEFORE=""
DIFF_AFTER=""
while IFS='|' read -r q r; do
  [ -z "${q:-}" ] && continue
  after="${AFTER_ROWS[$q]:-}"
  if [ -z "$after" ] || [ "$after" != "$r" ]; then
    DIFF_TABLE="$q"; DIFF_BEFORE="$r"; DIFF_AFTER="${after:-0}"
    break
  fi
  unset AFTER_ROWS["$q"]
done <"$SRC_BEFORE"

# 恢复后新增的表也计为差异表
if [ -z "$DIFF_TABLE" ]; then
  for q in "${!AFTER_ROWS[@]}"; do
    DIFF_TABLE="$q"; DIFF_BEFORE="0"; DIFF_AFTER="${AFTER_ROWS[$q]}"
    break
  done
fi

if [ -n "$DIFF_TABLE" ]; then
  SRC_STATUS="changed"
else
  SRC_STATUS="unchanged"
fi

if [ "$COMPARE_SKIPPED" -eq 1 ]; then
  yxs_log "rows=skipped"
  yxs_log "samples=skipped"
else
  yxs_log "rows=$CAND_TABLE_COUNT"
  yxs_log "samples=$SAMPLE"
fi
yxs_log "source_rows=$SRC_STATUS"

if [ "$SRC_STATUS" = "changed" ]; then
  if [ -n "$DIFF_TABLE" ]; then
    yxs_die 3 "行数不一致：表 $DIFF_TABLE 备份前 $DIFF_BEFORE 行，恢复后 $DIFF_AFTER 行。"
  else
    # 表级定位不足：文件级有差异但逐表比对未定位到表（解析异常等）；按整库汇总值报出，不新增消息句式。
    BEFORE_TOTAL="$(awk -F'|' '{s+=$2} END {print s+0}' "$SRC_BEFORE")"
    AFTER_TOTAL="$(awk -F'|' '{s+=$2} END {print s+0}' "$SRC_AFTER")"
    yxs_die 3 "行数不一致：表 （整库汇总） 备份前 $BEFORE_TOTAL 行，恢复后 $AFTER_TOTAL 行。"
  fi
fi

exit 0
