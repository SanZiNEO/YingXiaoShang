#!/usr/bin/env bash
# backup-pg.sh — PostgreSQL custom 格式备份（G 轮）
# 只读源库；产物落 <备份根>/<host>/<pathSlug>/<timestamp>/，不做 pg_dumpall。
set -u
set -o pipefail

_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
YXS_LIB_PATH="${YXS_LIB_PATH:-$_SCRIPT_DIR/src/common.sh}"
# shellcheck source=/dev/null
. "$YXS_LIB_PATH"

yxs_tool_init backup-pg.sh

# PGHOST/PGPORT/PGDATABASE/PGUSER 与 YXS_G_SAMPLE 的默认值由 src/common.sh 统一给出
# 并 export（子进程 pg_dump/psql 靠环境变量连接）；此处不再重复兜底，避免两处默认值漂移。

DB_NAME=""
OUT_DIR=""
HOST_ARG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --db)
      yxs_need_value "--db" "$#" "数据库名"
      DB_NAME="$2"; shift 2 ;;
    --out)
      yxs_need_value "--out" "$#" "备份目录"
      OUT_DIR="$2"; shift 2 ;;
    --host)
      yxs_need_value "--host" "$#" "主机名"
      HOST_ARG="$2"; shift 2 ;;
    *)
      yxs_die 1 "未知参数：$1。" ;;
  esac
done

DB_NAME="${DB_NAME:-${PGDATABASE:-yxs}}"
yxs_sample ""
SAMPLE="${YXS_SAMPLE_OUT}"

# ---- 客户端工具探测 ----
yxs_require_cmd pg_dump
yxs_require_cmd pg_restore
yxs_require_cmd psql

# ---- 连接探测（只读）----
PROBE_ERR="$(mktemp)"
if ! psql -X -q -A -t -d "$DB_NAME" -c "select 1" >/dev/null 2>"$PROBE_ERR"; then
  reason="$(head -1 "$PROBE_ERR" | tr -d '\r')"
  [ -z "$reason" ] && reason="连接被拒绝或实例不可达"
  rm -f "$PROBE_ERR"
  yxs_die 2 "无法连接 PostgreSQL：$reason。请检查 PGHOST、PGPORT、PGUSER、PGPASSWORD。"
fi
rm -f "$PROBE_ERR"

# ---- 备份目录分层：host / pathSlug / timestamp ----
HOST_SLUG="$(yxs_slug_host "${HOST_ARG:-}")"
PATH_SLUG="$(yxs_path_slug "$DB_NAME")"
TS="$(yxs_utc_stamp)"
CREATED_AT="$(yxs_utc_iso)"
ROOT_DIR="${OUT_DIR:-$(yxs_backup_root)}"
DIR="$ROOT_DIR/$HOST_SLUG/$PATH_SLUG/$TS"
mkdir -p "$DIR" || yxs_die 2 "备份目录创建失败：$DIR。"

TMP="$(yxs_tmpdir)"
trap 'rm -rf "$TMP"' EXIT

ARTIFACT="$DIR/$DB_NAME.dump"

yxs_log "source=$DB_NAME"

# ---- pg_dump 固定口径：custom / no-owner / no-privileges ----
DUMP_ERR="$DIR/.dump.err"
if ! pg_dump --format=custom --no-owner --no-privileges --dbname="$DB_NAME" --file="$ARTIFACT" 2>"$DUMP_ERR"; then
  reason="$(head -1 "$DUMP_ERR" | tr -d '\r')"
  [ -z "$reason" ] && reason="pg_dump 退出非零"
  yxs_die 2 "备份命令失败：pg_dump --format=custom --no-owner --no-privileges --dbname=<db> --file=<artifact>：$reason。"
fi

yxs_log "dump=$ARTIFACT"

# ---- TOC 可读性：pg_restore -l ----
TOC_FILE="$DIR/toc.txt"
TOC_ERR="$DIR/.toc.err"
if ! pg_restore -l "$ARTIFACT" >"$TOC_FILE" 2>"$TOC_ERR"; then
  reason="$(head -1 "$TOC_ERR" | tr -d '\r')"
  [ -z "$reason" ] && reason="目录列表不可读"
  yxs_die 3 "备份产物无法打开：$ARTIFACT：$reason。"
fi
if [ ! -s "$TOC_FILE" ]; then
  yxs_die 3 "备份产物无法打开：$ARTIFACT：目录列表为空。"
fi
yxs_log "toc=$TOC_FILE"

# ---- 产物字节数与 sha256（lib 统一计算，脚本不重复实现）----
BYTES="$(yxs_bytes "$ARTIFACT")" || exit $?
SHA="$(yxs_sha256 "$ARTIFACT")" || exit $?
yxs_log "bytes=$BYTES sha256=$SHA"

# ---- 表枚举与主键（pg_class/pg_index 现查，不硬编码 SQLite 清单）----
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

TABLES_RAW="$TMP/tables.tsv"
ENUM_ERR="$DIR/.enum.err"
if ! psql -X -q -A -F'|' -t -d "$DB_NAME" -c "$ENUM_SQL" >"$TABLES_RAW" 2>"$ENUM_ERR"; then
  reason="$(head -1 "$ENUM_ERR" | tr -d '\r')"
  yxs_die 2 "无法连接 PostgreSQL：$reason。请检查 PGHOST、PGPORT、PGUSER、PGPASSWORD。"
fi

ENTRIES_FILE="$TMP/tables.entries"
: >"$ENTRIES_FILE" || yxs_die 2 "临时文件创建失败：${ENTRIES_FILE}。"
TABLE_COUNT=0

while IFS='|' read -r SCHEMA TABLE PK; do
  [ -z "${SCHEMA:-}" ] && continue
  QUAL="$SCHEMA.$TABLE"
  IDENT='"'"$SCHEMA"'".'"$TABLE"'"'

  ROWS="$(psql -X -q -A -t -d "$DB_NAME" -c "SELECT count(*) FROM $IDENT" 2>"$DIR/.count.err" | tr -d '[:space:]')" \
    || yxs_die 2 "读取表 $QUAL 行数失败：$(head -1 "$DIR/.count.err" | tr -d '\r')。"

  if [ "$PK" = "ctid" ]; then
    ORDER_COLS="ctid"
  else
    ORDER_COLS="$(printf '%s' "$PK" | sed 's/,/, /g')"
  fi

  JSONL="$TMP/$TABLE.jsonl"
  SAMPLE_SQL="COPY (SELECT row_to_json(x) FROM (SELECT * FROM $IDENT ORDER BY $ORDER_COLS LIMIT $SAMPLE) x) TO STDOUT"
  psql -X -q -A -t -d "$DB_NAME" -c "$SAMPLE_SQL" >"$JSONL" 2>"$DIR/.sample.err" \
    || yxs_die 2 "读取表 $QUAL 抽样失败：$(head -1 "$DIR/.sample.err" | tr -d '\r')。"

  ENTRY="$(yxs_py fingerprint-rows --table "$QUAL" --pk "$PK" --input "$JSONL" --out "$DIR" --sample "$SAMPLE" --rows "$ROWS")" || exit $?
  printf '%s\n' "$ENTRY" >>"$ENTRIES_FILE"
  TABLE_COUNT=$((TABLE_COUNT + 1))
done <"$TABLES_RAW"

# ---- 汇总 tables 数组 JSON（manifest --tables 入参）----
TABLES_JSON="$DIR/tables.json"
{
  printf '[\n'
  FIRST=1
  while IFS= read -r LINE; do
    [ -z "$LINE" ] && continue
    [ "$FIRST" -eq 0 ] && printf ',\n'
    printf '%s\n' "$LINE"
    FIRST=0
  done <"$ENTRIES_FILE"
  printf ']\n'
} >"$TABLES_JSON"

# ---- 客户端版本首行（client-versions 留痕）----
first_version() { "$1" --version 2>/dev/null | head -1; }
CLIENT_VERSIONS="pg_dump=$(first_version pg_dump),pg_restore=$(first_version pg_restore),psql=$(first_version psql)"

MANIFEST="$DIR/manifest.json"
yxs_py manifest \
  --out "$MANIFEST" \
  --kind pg \
  --host "$HOST_SLUG" \
  --source "$DB_NAME" \
  --db-name "$DB_NAME" \
  --schema-version null \
  --label "" \
  --tool backup-pg.sh \
  --version "$(yxs_version)" \
  --client-versions "$CLIENT_VERSIONS" \
  --artifact "$ARTIFACT" \
  --format custom \
  --tables "$TABLES_JSON" \
  --quick ok \
  --integrity null \
  --drill-ref null \
  --created-at "$CREATED_AT" >/dev/null || exit $?

yxs_log "tables=$TABLE_COUNT"
yxs_log "manifest=$MANIFEST"

exit 0
