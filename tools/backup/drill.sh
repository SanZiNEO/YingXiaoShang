#!/usr/bin/env bash
# G 轮演练编排：备份 → 基线 → 删除前置闸 → 删除隔离副本 → 恢复 → 复校 → 出报告。
# 业务逻辑（哈希 / 校验 / manifest / 指纹 / 比对）全部走 src/common.sh 与内嵌 Python 引擎；
# 本脚本只做阶段编排、参数守卫与报告装配，不重复实现备份/校验/哈希/manifest 逻辑。
set -u
set -o pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=src/common.sh
source "$SELF_DIR/src/common.sh"
yxs_tool_init "drill.sh"

# ---------------------------------------------------------------------------
# 参数
# ---------------------------------------------------------------------------
KIND=""
SOURCE=""
SAMPLE_RAW=""
REPORT_FILE=""
RESTORE_TARGET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --kind)
      yxs_need_value --kind "$#" "演练库类型（sqlite|pg）"
      KIND="$2"; shift 2 ;;
    --source)
      yxs_need_value --source "$#" "SQLite 副本路径或 PG 源库名"
      SOURCE="$2"; shift 2 ;;
    --sample)
      yxs_need_value --sample "$#" "每表抽样行数"
      SAMPLE_RAW="$2"; shift 2 ;;
    --report)
      yxs_need_value --report "$#" "演练报告落点"
      REPORT_FILE="$2"; shift 2 ;;
    --restore-target)
      yxs_need_value --restore-target "$#" "SQLite 恢复目标路径"
      RESTORE_TARGET="$2"; shift 2 ;;
    *)
      yxs_die 1 "未知参数：$1。" ;;
  esac
done

case "$KIND" in
  sqlite|pg) ;;
  *) yxs_die 1 "演练类型必须是 sqlite 或 pg。" ;;
esac
yxs_need_arg --source "$SOURCE" "SQLite 副本路径或 PG 源库名"
yxs_sample "${SAMPLE_RAW:-}"
SAMPLE="${YXS_SAMPLE_OUT:-20}"

REPO_ROOT="$(yxs_repo_root)"
: "${YXS_G_BACKUP_DIR:-$(yxs_backup_root)}"
export YXS_G_BACKUP_DIR
export YXS_G_SAMPLE="$SAMPLE"

if [[ -z "$RESTORE_TARGET" ]]; then
  RESTORE_TARGET="$REPO_ROOT/.scratch/run/G/home/restored/learning.db"
fi

# ---- 恢复目标保护闸（必须先于任何 rm / cp，含各阶段内部的删除与写入）----
# restore-sqlite.sh 自己也有同样的闸；这里提前拦一次，让演练在任何阶段动手前
# 就以退出码 1 结束，不留下半途产物。PG 链路的「目标」是库名，不做路径判定。
if [[ "$KIND" == "sqlite" ]]; then
  if yxs_is_protected "$RESTORE_TARGET"; then
    yxs_die 1 "恢复目标位于受保护的真实数据目录，拒绝覆盖：${RESTORE_TARGET}。"
  fi
  if yxs_same_path "$RESTORE_TARGET" "$SOURCE"; then
    yxs_die 1 "恢复目标不能等于演练源副本，拒绝执行：${RESTORE_TARGET}。"
  fi
  if [[ -d "$RESTORE_TARGET" ]]; then
    yxs_die 1 "恢复目标必须是文件路径，不能是既有目录：${RESTORE_TARGET}。"
  fi
fi

# ---------------------------------------------------------------------------
# 全局状态（报告装配用；未跑到的字段保持空，报告里记 null / 待实测口径）
# ---------------------------------------------------------------------------
TMP_DIR="$(yxs_tmpdir)"
TRANSCRIPT="$TMP_DIR/drill.log"
: >"$TRANSCRIPT" || yxs_die 2 "演练临时日志无法创建：${TRANSCRIPT}。"

STARTED_AT="$(yxs_utc_iso)"
FINISHED_AT=""
HOST_SLUG="$(yxs_slug_host "${HOSTNAME:-$(hostname)}")"

DRILL_ID=""
MANIFEST_FILE=""
MANIFEST_REF=""
BACKUP_ARTIFACT=""
BACKUP_BYTES=""
BACKUP_SHA256=""
BACKUP_ELAPSED_MS=""
BACKUP_CHECKS_RAW=""
CLIENT_VERSIONS_RAW=""
SOURCE_RAW=""

DELETE_TARGET=""
DELETE_METHOD=""
DELETED_AT=""
ROWS_BEFORE=""
IRREVERSIBLE_NOTE=""

RESTORE_TARGET_PATH=""
RESTORE_TARGET_DB=""
RESTORE_ELAPSED_MS=""
RESTORE_COMMAND=""
RESTORE_EXIT_CODE=""

VERIFY_TABLES_RAW=""
FIRST_DIFF_RAW=""

CURRENT_STAGE=""
FAILED_STAGE=""
VERDICT="PASS"
REPORT_WRITTEN=""
LIMITATIONS=""
PG_SKIP_REASON=""

# ---------------------------------------------------------------------------
# 小工具：时间 / JSON 转义 / manifest 字段提取
# ---------------------------------------------------------------------------
epoch_ms() {
  local s ns
  s="$(date -u +%s)"
  ns="$(date -u +%N)"
  # %N 在部分环境返回前导零值，必须按十进制解析，避免 bash 按八进制报错。
  printf '%s' $((s * 1000 + 10#$ns / 1000000))
}

json_str() {
  local s="${1:-}"
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '"%s"' "$s"
}

# 空值输出 null，未跑到的字段不写空串。
json_opt_str() {
  if [[ -n "${1:-}" ]]; then json_str "$1"; else printf 'null'; fi
}

# 从日志行里取最后一条 key=value
parse_kv() {
  local file="$1" key="$2"
  grep -E "(^| )${key}=" "$file" | tail -1 \
    | sed -E "s/.*${key}=//; s/[[:space:]]+$//"
}

manifest_str() {
  sed -n 's/.*"'"$2"'": *"\([^"]*\)".*/\1/p' "$1" | head -1
}

manifest_num() {
  sed -n 's/.*"'"$2"'": *\(-\?[0-9][0-9]*\).*/\1/p' "$1" | head -1
}

# 提取 manifest 中某一对象的内部行（不含开/闭括号本身）；开闭括号由报告 heredoc 显式写出，
# 避免片段变量自带闭合括号再被模板叠加一层。manifest 为 indent=2 pretty JSON。
manifest_inner() {
  local file="$1" key="$2"
  sed -n "/\"$key\": {/,/^[[:space:]]*}/p" "$file" | sed '1d;$d'
}

# 从单行 compare JSON 中取 "tables" 数组片段
compare_tables() {
  sed -E 's/^.*"tables": (\[.*\]), "firstDiff":.*/\1/' "$1"
}

# 从单行 compare JSON 中取 "firstDiff" 值（null 或对象）
compare_first_diff() {
  sed -E 's/^.*"firstDiff": (null|\{.*\}).*/\1/' "$1"
}

# compare 引擎输出不含 sampleSize；装配 spec 时按 02 §3.4 逐表补：
# sampleSize = min(rowsBaseline, sample)，空表记 0；sampleResult / hashResult / rowsAfter
# 原样取自 compare 结果，不重算、不编造。
augment_tables() {
  local arr="$1" sample="$2"
  local entries=() obj name rb ra sr hr ss ra_json
  while IFS= read -r obj; do
    [[ -n "$obj" ]] || continue
    name="$(printf '%s' "$obj" | sed -n 's/.*"name": *"\([^"]*\)".*/\1/p')"
    rb="$(printf '%s' "$obj" | sed -n 's/.*"rowsBaseline": *\([0-9][0-9]*\).*/\1/p')"
    ra="$(printf '%s' "$obj" | sed -n 's/.*"rowsAfter": *\([0-9][0-9]*\).*/\1/p')"
    sr="$(printf '%s' "$obj" | sed -n 's/.*"sampleResult": *"\([^"]*\)".*/\1/p')"
    hr="$(printf '%s' "$obj" | sed -n 's/.*"hashResult": *"\([^"]*\)".*/\1/p')"
    [[ -n "$rb" ]] || rb=0
    if [[ "$rb" -lt "$sample" ]]; then ss="$rb"; else ss="$sample"; fi
    if [[ -n "$ra" ]]; then ra_json="$ra"; else ra_json="null"; fi
    entries+=("{\"name\": $(json_str "$name"), \"rowsBaseline\": $rb, \"rowsAfter\": $ra_json, \"sampleSize\": $ss, \"sampleResult\": $(json_str "$sr"), \"hashResult\": $(json_str "$hr")}")
  done < <(printf '%s' "$arr" | grep -oE '\{[^{}]*\}')
  printf '[%s]' "$(IFS=,; printf '%s' "${entries[*]}")"
}

record_stage_log() {
  local label="$1" log="$2"
  {
    printf '\n===== %s =====\n' "$label"
    cat "$log"
  } >>"$TRANSCRIPT"
}

# ---------------------------------------------------------------------------
# 阶段 1：备份
# ---------------------------------------------------------------------------
stage_backup() {
  local start_ms end_ms log rc
  start_ms="$(epoch_ms)"
  log="$TMP_DIR/backup.log"

  if [[ "$KIND" == "sqlite" ]]; then
    if yxs_is_protected "$SOURCE"; then
      yxs_die 1 "源路径位于受保护的真实数据目录，请改用 .scratch/run/G/ 下的副本：${SOURCE}。"
    fi
    # 自检复用入口：YXS_REUSE_MANIFEST 指向既有 manifest 时跳过本次备份，直接载入该清单，
    # 用于删除前置闸反例（不重复实现备份/manifest 逻辑，只读既有产物）。
    if [[ -n "${YXS_REUSE_MANIFEST:-}" && -f "${YXS_REUSE_MANIFEST:-}" ]]; then
      MANIFEST_FILE="$YXS_REUSE_MANIFEST"
      local art_name
      art_name="$(manifest_str "$MANIFEST_FILE" fileName)"
      BACKUP_ARTIFACT="$(dirname "$MANIFEST_FILE")/$art_name"
      BACKUP_BYTES="$(manifest_num "$MANIFEST_FILE" bytes)"
      BACKUP_SHA256="$(manifest_str "$MANIFEST_FILE" sha256)"
    else
      [[ -f "$SOURCE" ]] || yxs_die 1 "找不到源数据库文件：${SOURCE}。"
      "$SELF_DIR/backup-sqlite.sh" --source "$SOURCE" --sample "$SAMPLE" >"$log" 2>&1
      rc=$?
      record_stage_log "backup-sqlite.sh" "$log"
      [[ $rc -ne 0 ]] && { cat "$log"; return $rc; }

      MANIFEST_FILE="$(parse_kv "$log" manifest)"
      BACKUP_ARTIFACT="$(parse_kv "$log" artifact)"
      local bline
      bline="$(grep -E '(^| )bytes=' "$log" | tail -1)"
      BACKUP_BYTES="$(printf '%s' "$bline" | sed -E 's/.*bytes=([0-9]+).*/\1/')"
      BACKUP_SHA256="$(printf '%s' "$bline" | sed -E 's/.*sha256=([0-9a-f]+).*/\1/')"
    fi
  else
    # PG 链路：本机无 PG 客户端/实例时，前置探测记 skip 口径；实际退出码归环境类 2。
    local missing=""
    for c in pg_dump pg_restore psql; do
      command -v "$c" >/dev/null 2>&1 || missing="$missing $c"
    done
    if [[ -n "$missing" ]]; then
      PG_SKIP_REASON="skipped: no PG client/server（缺少命令:$missing）"
      LIMITATIONS="skipped: no PG client/server；本机无 pg_dump/pg_restore/psql/createdb 与 55433 实例。复跑方式：在装有与 postgres:16 同代 PG 客户端且 yxs-pg-g 可达的环境中，设置 PGHOST/PGPORT/PGUSER/PGPASSWORD（PGPASSWORD 只从环境读），再执行本演练命令。"
    fi
    "$SELF_DIR/backup-pg.sh" --db "$SOURCE" >"$log" 2>&1
    rc=$?
    record_stage_log "backup-pg.sh" "$log"
    [[ $rc -ne 0 ]] && { cat "$log"; return $rc; }

    MANIFEST_FILE="$(parse_kv "$log" manifest)"
    BACKUP_ARTIFACT="$(parse_kv "$log" dump)"
    local bline
    bline="$(grep -E '(^| )bytes=' "$log" | tail -1)"
    BACKUP_BYTES="$(printf '%s' "$bline" | sed -E 's/.*bytes=([0-9]+).*/\1/')"
    BACKUP_SHA256="$(printf '%s' "$bline" | sed -E 's/.*sha256=([0-9a-f]+).*/\1/')"
  fi

  end_ms="$(epoch_ms)"
  BACKUP_ELAPSED_MS=$((end_ms - start_ms))

  [[ -n "$MANIFEST_FILE" && -f "$MANIFEST_FILE" ]] \
    || yxs_die 2 "备份未产出 manifest：${MANIFEST_FILE:-未知}。"
  MANIFEST_REF="$MANIFEST_FILE"

  DRILL_ID="$(manifest_str "$MANIFEST_FILE" backupId)"
  BACKUP_CHECKS_RAW="$(manifest_inner "$MANIFEST_FILE" checks)"
  CLIENT_VERSIONS_RAW="$(manifest_inner "$MANIFEST_FILE" clientVersions)"
  SOURCE_RAW="$(manifest_inner "$MANIFEST_FILE" source)"

  ROWS_BEFORE="$(grep -oE '"rows": *[0-9]+' "$MANIFEST_FILE" \
    | awk -F: '{s+=$2} END {print s+0}')"
  return 0
}

# ---------------------------------------------------------------------------
# 阶段 2：基线（manifest 中的行数与抽样指纹作为核对基准，不重复计算）
# ---------------------------------------------------------------------------
stage_baseline() {
  [[ -n "$MANIFEST_FILE" && -f "$MANIFEST_FILE" ]] \
    || yxs_die 2 "基线缺失：找不到 manifest。"
  yxs_log "基线已载入：${MANIFEST_FILE}（行数基线 ${ROWS_BEFORE:-0}）"
  return 0
}

# ---------------------------------------------------------------------------
# 阶段 3：删除（前置闸 + 隔离目标闸；只动 .scratch/run/G 内副本 / 隔离演练库）
# ---------------------------------------------------------------------------
stage_delete() {
  # ---- 删除前置闸：quickCheck=ok 且产物 sha256 可复算 ----
  local quick_check manifest_sha recomputed_sha gate_ok=1
  quick_check="$(manifest_str "$MANIFEST_FILE" quickCheck)"
  manifest_sha="$(manifest_str "$MANIFEST_FILE" sha256)"
  if [[ "$quick_check" != "ok" ]]; then
    gate_ok=0
  else
    recomputed_sha="$(yxs_sha256 "$BACKUP_ARTIFACT")"
    [[ "$recomputed_sha" == "$manifest_sha" ]] || gate_ok=0
  fi

  if [[ "$gate_ok" -ne 1 ]]; then
    # 保护中止：不执行任何删除，按契约以 0 退出（02 §4 末条）。
    # 冻结枚举：verdict 仅 PASS/FAIL；method 仅 drop-file/truncate/drop-table，
    # 未执行删除时 method/deletedAt 记 null，原因写入 irreversibleNote。
    DELETE_TARGET="$SOURCE"
    DELETE_METHOD=""
    IRREVERSIBLE_NOTE="前置闸未通过（quickCheck 非 ok 或 artifact.sha256 不可复算），未执行任何删除；副本文件与行数未变，源库与受保护目录未被触碰；本中止动作本身不修改任何数据。"
    VERDICT="FAIL"
    FAILED_STAGE="stage_delete"
    printf '%s\n' '未执行删除：上一份备份校验未通过，演练已中止以保护数据。'
    stage_report
    REPORT_WRITTEN=1
    exit 0
  fi

  if [[ "$KIND" == "sqlite" ]]; then
    DELETE_TARGET="$SOURCE"
    if yxs_is_protected "$DELETE_TARGET"; then
      yxs_die 1 "源路径位于受保护的真实数据目录，请改用 .scratch/run/G/ 下的副本：${DELETE_TARGET}。"
    fi
    local norm_candidate="$DELETE_TARGET"
    [[ "$norm_candidate" != /* ]] && norm_candidate="$REPO_ROOT/$norm_candidate"
    local norm
    norm="$(realpath -m "$norm_candidate" 2>/dev/null || printf '%s' "$norm_candidate")"
    case "$norm" in
      "$REPO_ROOT/.scratch/run/G/"*) ;;
      *) yxs_die 1 "删除目标不在 .scratch/run/G/ 隔离目录内，拒绝执行：${DELETE_TARGET}。" ;;
    esac

    DELETE_METHOD="drop-file"
    DELETED_AT="$(yxs_utc_iso)"
    IRREVERSIBLE_NOTE="删除只作用于 .scratch/run/G/ 内演练副本（主文件及 -wal/-shm 边车）；源库与受保护目录未被触碰；该步骤不可逆，恢复依赖上一份校验通过的快照。"

    yxs_log "计划删除（不可逆）：${DELETE_TARGET} 方式=${DELETE_METHOD} 基线行数=${ROWS_BEFORE:-0}"
    rm -f -- "$DELETE_TARGET" "$DELETE_TARGET-wal" "$DELETE_TARGET-shm" \
      || yxs_die 2 "删除演练副本失败：${DELETE_TARGET}（含 -wal / -shm 边车）。"
    [[ ! -e "$DELETE_TARGET" ]] \
      || yxs_die 2 "删除后演练副本仍然存在，删除未生效：${DELETE_TARGET}。"
  else
    # PG：唯一允许 TRUNCATE 的库是隔离演练库 yxs_g_drill；源库 yxs 全程只读。
    DELETE_TARGET="yxs_g_drill"
    if [[ "$DELETE_TARGET" == "${PGDATABASE:-yxs}" || "$DELETE_TARGET" == "$SOURCE" ]]; then
      yxs_die 1 "禁止对源库执行删除：${DELETE_TARGET}。"
    fi
    case "$DELETE_TARGET" in
      yxs_g_*) ;;
      *) yxs_die 1 "删除目标库名只能以 yxs_g_ 开头：${DELETE_TARGET}。" ;;
    esac

    if ! command -v psql >/dev/null 2>&1; then
      yxs_warn "psql 不可用，PG 删除步骤无法在本环境执行；详见报告附录 skip 说明。"
      return 2
    fi
    command -v createdb >/dev/null 2>&1 \
      || yxs_die 2 "未找到 createdb，无法准备隔离演练库 ${DELETE_TARGET}。"

    IRREVERSIBLE_NOTE="删除只作用于隔离演练库 yxs_g_drill；源库 ${PGDATABASE:-yxs} 不执行任何写操作；该步骤不可逆，恢复依赖上一份校验通过的快照。"

    # ---- 准备隔离演练库：不存在就建，并灌入本次备份，使「删除」有真实对象可删 ----
    # 不建库直接 TRUNCATE 会让 psql 报错；旧实现把错误丢进进程替换，循环 0 次、
    # return 0、报告写 method=truncate 而 verdict=PASS——「删了个不存在的库」被判成功。
    local exists errf
    errf="$TMP_DIR/pg-drill-exists.err"
    exists="$(psql -X -q -A -t -d postgres \
      -c "SELECT 1 FROM pg_database WHERE datname = '${DELETE_TARGET}'" 2>"$errf")" \
      || yxs_die 2 "无法连接 PostgreSQL 查询演练库是否存在：$(head -1 "$errf" | tr -d '\r')。请检查 PGHOST、PGPORT、PGUSER、PGPASSWORD。"
    if [[ "$exists" != "1" ]]; then
      local cdb_err
      cdb_err="$TMP_DIR/pg-drill-createdb.err"
      createdb --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" "$DELETE_TARGET" 2>"$cdb_err" \
        || yxs_die 2 "隔离演练库创建失败：createdb ${DELETE_TARGET}：$(head -1 "$cdb_err" | tr -d '\r')。"
      yxs_log "已创建隔离演练库：${DELETE_TARGET}"
      # 空库没有可删对象，删了也证明不了什么；先把本次备份灌进去，删除阶段才有真实行数。
      local rst_err
      rst_err="$TMP_DIR/pg-drill-restore.err"
      pg_restore --dbname="$DELETE_TARGET" --no-owner --no-privileges "$BACKUP_ARTIFACT" 2>"$rst_err" \
        || yxs_die 2 "隔离演练库灌入备份失败：pg_restore --dbname=${DELETE_TARGET}：$(head -1 "$rst_err" | tr -d '\r')。"
      yxs_log "隔离演练库已灌入备份：${DELETE_TARGET}"
    fi

    # ---- 枚举表清单：错误必须进 $?，不能靠进程替换吞掉 ----
    local tables_sql tables_file enum_err ident rows_before_drill
    tables_sql="SELECT '\"' || schemaname || '\".\"' || tablename || '\"' FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema');"
    tables_file="$TMP_DIR/pg-drill-tables.txt"
    enum_err="$TMP_DIR/pg-drill-enum.err"
    psql -X -q -A -t -d "$DELETE_TARGET" -c "$tables_sql" >"$tables_file" 2>"$enum_err" \
      || yxs_die 2 "枚举隔离演练库表失败：$(head -1 "$enum_err" | tr -d '\r')。"
    if [[ ! -s "$tables_file" ]]; then
      # 没有业务表就没法执行删除；记 PASS 等于把「空转」当成功，直接判失败。
      yxs_die 2 "隔离演练库 ${DELETE_TARGET} 内没有可删除的业务表，拒绝以空转结果记 PASS。"
    fi

    rows_before_drill=0
    while IFS= read -r ident; do
      [[ -n "$ident" ]] || continue
      local cnt cnt_err cnt_n
      cnt_err="$TMP_DIR/pg-drill-count.err"
      cnt="$(psql -X -q -A -t -d "$DELETE_TARGET" -c "SELECT count(*) FROM $ident" 2>"$cnt_err")" \
        || yxs_die 2 "读取隔离演练库表 ${ident} 行数失败：$(head -1 "$cnt_err" | tr -d '\r')。"
      cnt_n="${cnt//[[:space:]]/}"
      [[ "$cnt_n" =~ ^[0-9]+$ ]] \
        || yxs_die 2 "读取隔离演练库表 ${ident} 行数失败：返回值不是整数（${cnt_n:-空}）。"
      rows_before_drill=$((rows_before_drill + cnt_n))
    done <"$tables_file"
    yxs_log "隔离演练库待删除行数：${rows_before_drill}"

    while IFS= read -r ident; do
      [[ -n "$ident" ]] || continue
      local tr_err
      tr_err="$TMP_DIR/pg-drill-truncate.err"
      psql -X -q -A -t -d "$DELETE_TARGET" -c "TRUNCATE TABLE $ident RESTART IDENTITY;" 2>"$tr_err" \
        || yxs_die 2 "删除隔离演练库表失败：${ident}：$(head -1 "$tr_err" | tr -d '\r')。"
    done <"$tables_file"

    # ---- 删除后复核：行数必须归零，否则「删过了」只是报告里的一句话 ----
    local residual ident_after
    residual=0
    while IFS= read -r ident_after; do
      [[ -n "$ident_after" ]] || continue
      local cnt2 cnt2_err cnt2_n
      cnt2_err="$TMP_DIR/pg-drill-count-after.err"
      cnt2="$(psql -X -q -A -t -d "$DELETE_TARGET" -c "SELECT count(*) FROM $ident_after" 2>"$cnt2_err")" \
        || yxs_die 2 "删除后复核表 ${ident_after} 行数失败：$(head -1 "$cnt2_err" | tr -d '\r')。"
      cnt2_n="${cnt2//[[:space:]]/}"
      [[ "$cnt2_n" =~ ^[0-9]+$ ]] \
        || yxs_die 2 "删除后复核表 ${ident_after} 行数失败：返回值不是整数（${cnt2_n:-空}）。"
      residual=$((residual + cnt2_n))
    done <"$tables_file"
    [[ "$residual" -eq 0 ]] \
      || yxs_die 3 "隔离演练库删除未生效：${DELETE_TARGET} 删除后仍有 ${residual} 行。"

    # 删除确实生效后才记 method / deletedAt：失败时报告如实留 null，不写「删过」。
    DELETE_METHOD="truncate"
    DELETED_AT="$(yxs_utc_iso)"
    ROWS_BEFORE="$rows_before_drill"
    yxs_log "隔离演练库删除完成：${DELETE_TARGET} 删除前 ${rows_before_drill} 行，删除后 0 行。"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# 阶段 4：恢复
# ---------------------------------------------------------------------------
stage_restore() {
  local start_ms end_ms log rc
  start_ms="$(epoch_ms)"
  log="$TMP_DIR/restore.log"

  if [[ "$KIND" == "sqlite" ]]; then
    RESTORE_TARGET_PATH="$RESTORE_TARGET"
    RESTORE_COMMAND="restore-sqlite.sh --backup <artifact> --target <target> --manifest <manifest> --sample ${SAMPLE}"
    "$SELF_DIR/restore-sqlite.sh" --backup "$BACKUP_ARTIFACT" \
      --target "$RESTORE_TARGET" --manifest "$MANIFEST_FILE" --sample "$SAMPLE" \
      >"$log" 2>&1
    rc=$?
    record_stage_log "restore-sqlite.sh" "$log"
    [[ $rc -ne 0 ]] && { cat "$log"; return $rc; }
    RESTORE_EXIT_CODE="0"
  else
    RESTORE_COMMAND="restore-pg.sh --backup <dump> --sample ${SAMPLE}（连接参数取自 PGHOST/PGPORT/PGUSER/PGDATABASE，密码不落命令行）"
    "$SELF_DIR/restore-pg.sh" --backup "$BACKUP_ARTIFACT" --sample "$SAMPLE" \
      >"$log" 2>&1
    rc=$?
    record_stage_log "restore-pg.sh" "$log"
    [[ $rc -ne 0 ]] && { cat "$log"; return $rc; }
    RESTORE_TARGET_DB="$(parse_kv "$log" target_db)"
    RESTORE_EXIT_CODE="0"
  fi

  end_ms="$(epoch_ms)"
  RESTORE_ELAPSED_MS=$((end_ms - start_ms))
  return 0
}

# ---------------------------------------------------------------------------
# 阶段 5：复校（表集合 → 行数 100% → 抽样字段 + 整表摘要）
# ---------------------------------------------------------------------------
stage_verify() {
  local log rc
  log="$TMP_DIR/verify.log"

  if [[ "$KIND" == "sqlite" ]]; then
    yxs_py compare --manifest "$MANIFEST_FILE" --candidate "$RESTORE_TARGET_PATH" \
      --sample "$SAMPLE" >"$log" 2>&1
    rc=$?
    record_stage_log "compare" "$log"
    [[ $rc -ne 0 ]] && { cat "$log"; return $rc; }
    local tables_base
    tables_base="$(compare_tables "$log")"
    FIRST_DIFF_RAW="$(compare_first_diff "$log")"
    [[ -n "$tables_base" ]] || tables_base="[]"
    VERIFY_TABLES_RAW="$(augment_tables "$tables_base" "$SAMPLE")"
    [[ -n "$VERIFY_TABLES_RAW" ]] || VERIFY_TABLES_RAW="[]"
    [[ -n "$FIRST_DIFF_RAW" ]] || FIRST_DIFF_RAW="null"
  else
    # PG 候选是恢复库而非文件；行数/抽样核对由 restore-pg.sh 内完成，这里只留痕。
    VERIFY_TABLES_RAW="[]"
    FIRST_DIFF_RAW="null"
    [[ -n "$PG_SKIP_REASON" ]] && yxs_warn "$PG_SKIP_REASON"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# 阶段 6：出报告（spec JSON → yxs_py report 渲染七段 markdown）
# ---------------------------------------------------------------------------
stage_report() {
  FINISHED_AT="$(yxs_utc_iso)"

  [[ -n "$LIMITATIONS" ]] || LIMITATIONS="本机无 sqlite3 CLI，SQLite 在线备份走 Python 标准库 Connection.backup() 分支；无 gzip，产物未压缩。"

  local spec="$TMP_DIR/spec.json"
  local env_pw env_json client_raw source_raw checks_raw tables_raw diff_raw

  env_pw="<unset>"
  [[ -n "${PGPASSWORD:-}" ]] && env_pw="***"
  env_json="$(printf '{"PGHOST":%s,"PGPORT":%s,"PGUSER":%s,"PGDATABASE":%s,"PGPASSWORD":%s,"YXS_G_BACKUP_DIR":%s,"YXS_G_SAMPLE":%s,"LEARNING_AGENT_HOME":%s}' \
    "$(json_str "${PGHOST:-127.0.0.1}")" "$(json_str "${PGPORT:-55433}")" \
    "$(json_str "${PGUSER:-yxs}")" "$(json_str "${PGDATABASE:-yxs}")" \
    "$(json_str "$env_pw")" "$(json_str "${YXS_G_BACKUP_DIR:-}")" \
    "$(json_str "$SAMPLE")" "$(json_str "${LEARNING_AGENT_HOME:-}")")"

  tables_raw="${VERIFY_TABLES_RAW:-[]}"
  diff_raw="${FIRST_DIFF_RAW:-null}"

  # 内层空则输出 {}；否则输出带单组开闭括号的对象块（闭括号由这里统一给出）。
  json_inner_block() {
    local inner="$1"
    if [[ -z "$inner" ]]; then printf '{}'; return 0; fi
    printf '{\n%s\n}' "$inner"
  }
  client_raw="$(json_inner_block "${CLIENT_VERSIONS_RAW:-}")"
  source_raw="$(json_inner_block "${SOURCE_RAW:-}")"
  checks_raw="$(json_inner_block "${BACKUP_CHECKS_RAW:-}")"

  local excerpt
  excerpt="$(tail -40 "$TRANSCRIPT")"

  local restore_block restore_cmd_json
  if [[ "$KIND" == "sqlite" ]]; then
    if [[ -n "${RESTORE_TARGET_PATH:-}" ]]; then
      restore_block="\"targetPath\": $(json_str "$RESTORE_TARGET_PATH")"
    else
      restore_block='"targetPath": null'
    fi
  else
    if [[ -n "${RESTORE_TARGET_DB:-}" ]]; then
      restore_block="\"targetDb\": $(json_str "$RESTORE_TARGET_DB")"
    else
      restore_block='"targetDb": null'
    fi
  fi

  local rows_before delete_at restore_cmd restore_exit restore_elapsed
  local method_json deleted_at_json
  rows_before="${ROWS_BEFORE:-0}"
  delete_at="${DELETED_AT:-}"
  restore_cmd="${RESTORE_COMMAND:-}"
  restore_exit="${RESTORE_EXIT_CODE:-}"
  restore_elapsed="${RESTORE_ELAPSED_MS:-}"
  if [[ -n "$restore_cmd" ]]; then restore_cmd_json="$(json_str "$restore_cmd")"; else restore_cmd_json="null"; fi
  local failed_stage_json
  if [[ -n "${DELETE_METHOD:-}" ]]; then method_json="$(json_str "$DELETE_METHOD")"; else method_json="null"; fi
  if [[ -n "$delete_at" ]]; then deleted_at_json="$(json_str "$delete_at")"; else deleted_at_json="null"; fi
  if [[ -n "${FAILED_STAGE:-}" ]]; then failed_stage_json="$(json_str "$FAILED_STAGE")"; else failed_stage_json="null"; fi

  cat >"$spec" <<JSONEOF
{
  "drillId": $(json_opt_str "${DRILL_ID:-}"),
  "kind": $(json_str "$KIND"),
  "startedAt": $(json_str "$STARTED_AT"),
  "finishedAt": $(json_str "$FINISHED_AT"),
  "host": $(json_str "$HOST_SLUG"),
  "toolVersion": $(json_str "$(yxs_version)"),
  "clientVersions": $client_raw,
  "source": $source_raw,
  "backup": {
    "artifact": $(json_opt_str "${BACKUP_ARTIFACT:-}"),
    "bytes": ${BACKUP_BYTES:-null},
    "sha256": $(json_opt_str "${BACKUP_SHA256:-}"),
    "elapsedMs": ${BACKUP_ELAPSED_MS:-null},
    "checks": $checks_raw,
    "manifestRef": $(json_opt_str "${MANIFEST_REF:-}")
  },
  "delete": {
    "target": $(json_opt_str "${DELETE_TARGET:-}"),
    "method": $method_json,
    "deletedAt": $deleted_at_json,
    "rowsBefore": ${rows_before},
    "irreversibleNote": $(json_opt_str "${IRREVERSIBLE_NOTE:-}")
  },
  "restore": {
    $restore_block,
    "elapsedMs": ${restore_elapsed:-null},
    "restoreCommand": $restore_cmd_json,
    "exitCode": ${restore_exit:-null}
  },
  "verify": {
    "tables": $tables_raw,
    "firstDiff": $diff_raw
  },
  "verdict": {
    "value": $(json_str "$VERDICT"),
    "failedStage": $failed_stage_json,
    "reproduceCommand": $(json_str "bash tools/backup/drill.sh --kind $KIND --source $SOURCE --sample $SAMPLE")
  },
  "appendix": {
    "env": $env_json,
    "stdout": $(json_str "$excerpt"),
    "limitations": $(json_str "$LIMITATIONS")
  }
}
JSONEOF

  if [[ -z "$REPORT_FILE" && -n "$MANIFEST_FILE" ]]; then
    REPORT_FILE="$(dirname "$MANIFEST_FILE")/drill-report.md"
  fi
  [[ -n "$REPORT_FILE" ]] || REPORT_FILE="$TMP_DIR/drill-report.md"

  yxs_py report --spec "$spec" --out "$REPORT_FILE" \
    || { yxs_warn "spec 落点：${spec}（YXS_KEEP_TMP=1 时保留）"; yxs_die 2 "写出演练报告失败：${REPORT_FILE}。"; }
  yxs_log "演练报告：${REPORT_FILE}"
  REPORT_WRITTEN=1
  return 0
}

# ---------------------------------------------------------------------------
# 阶段编排与中断规则
# ---------------------------------------------------------------------------
run_stage() {
  local name="$1"
  CURRENT_STAGE="$name"
  yxs_log "阶段开始：${name}"
  "$name"
  local rc=$?
  CURRENT_STAGE=""
  if [[ $rc -ne 0 ]]; then
    FAILED_STAGE="$name"
    VERDICT="FAIL"
    return $rc
  fi
  return 0
}

cleanup() {
  local rc=$?
  if [[ $rc -ne 0 && -z "$REPORT_WRITTEN" ]]; then
    local fb="${FAILED_STAGE:-$CURRENT_STAGE}"
    [[ -n "$fb" ]] || fb="unknown"
    FAILED_STAGE="$fb"
    VERDICT="FAIL"
    stage_report || true
  fi
  if [[ -z "${YXS_KEEP_TMP:-}" ]]; then
    rm -rf "$TMP_DIR"
  else
    yxs_warn "保留临时目录：${TMP_DIR}"
  fi
}
trap cleanup EXIT

MAIN_RC=0
run_stage stage_backup  || MAIN_RC=$?
[[ $MAIN_RC -eq 0 ]] && { run_stage stage_baseline || MAIN_RC=$?; }
[[ $MAIN_RC -eq 0 ]] && { run_stage stage_delete  || MAIN_RC=$?; }
[[ $MAIN_RC -eq 0 ]] && { run_stage stage_restore || MAIN_RC=$?; }
[[ $MAIN_RC -eq 0 ]] && { run_stage stage_verify  || MAIN_RC=$?; }
[[ $MAIN_RC -eq 0 ]] && { run_stage stage_report || MAIN_RC=$?; }

exit "$MAIN_RC"
