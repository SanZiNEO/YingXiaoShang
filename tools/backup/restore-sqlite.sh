#!/usr/bin/env bash
# SQLite 恢复：哈希对账 → 清理残留边车 → 落快照 → quick_check(+integrity_check) → 行数/抽样核对。
set -u
set -o pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=src/common.sh
source "$SELF_DIR/src/common.sh"
yxs_tool_init "restore-sqlite.sh"

BACKUP=""
TARGET=""
MANIFEST=""
INTEGRITY="full"
SAMPLE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup)
      yxs_need_value --backup $# "备份产物路径"; BACKUP="$2"; shift 2 ;;
    --target)
      yxs_need_value --target $# "恢复目标路径"; TARGET="$2"; shift 2 ;;
    --manifest)
      yxs_need_value --manifest $# "manifest 路径"; MANIFEST="$2"; shift 2 ;;
    --integrity)
      yxs_need_value --integrity $# "校验档位"; INTEGRITY="$2"; shift 2 ;;
    --sample)
      yxs_need_value --sample $# "抽样行数"; SAMPLE="$2"; shift 2 ;;
    *)
      yxs_die 1 "未知参数：$1。" ;;
  esac
done

yxs_need_arg --backup "$BACKUP" "备份产物路径"
yxs_need_arg --target "$TARGET" "恢复目标路径"

case "$INTEGRITY" in
  quick|full) ;;
  *) yxs_die 1 "integrity 档位必须是 quick 或 full。" ;;
esac

yxs_sample "$SAMPLE"
SAMPLE="$YXS_SAMPLE_OUT"

# ---- 目标保护闸（必须先于任何 rm / mkdir / cp）----
# 恢复动作会覆盖目标文件，并先删除目标旁的 -wal / -shm 边车。若目标落在真实数据
# 目录，WAL 里尚未 checkpoint 的写入会随边车一起被删掉，属于不可逆的数据丢失。
# 因此保护判定放在所有写操作之前；宁可误拒，也不误放。
if yxs_is_protected "$TARGET"; then
  yxs_die 1 "恢复目标位于受保护的真实数据目录，拒绝覆盖：${TARGET}。"
fi
# 目标等于备份产物时，cp 会以 "are the same file" 失败，但随后清边车已经发生；
# 提前拦下，避免「报错但已删了边车」的半途状态。
if yxs_same_path "$TARGET" "$BACKUP"; then
  yxs_die 1 "恢复目标不能等于备份产物，拒绝执行：${TARGET}。"
fi
# 目标是既有目录时 cp 会把快照塞进目录内部，落点与调用方预期不符；直接拒绝。
if [[ -d "$TARGET" ]]; then
  yxs_die 1 "恢复目标必须是文件路径，不能是既有目录：${TARGET}。"
fi

# 快照存在且可读
[[ -f "$BACKUP" ]] \
  || yxs_die 2 "备份产物无法打开：${BACKUP}：文件不存在。"
yxs_py hash --path "$BACKUP" >/dev/null 2>&1 \
  || yxs_die 2 "备份产物无法打开：${BACKUP}：无法读取。"

# manifest 默认与快照同目录
if [[ -z "$MANIFEST" ]]; then
  MANIFEST="$(dirname "$BACKUP")/manifest.json"
fi

MANIFEST_STATE="present"
BASELINE_SHA=""
if [[ -f "$MANIFEST" ]]; then
  RECORD_SHA="$(sed -n 's/.*"sha256": *"\([0-9a-f]\{64\}\)".*/\1/p' "$MANIFEST" | head -n1)"
  CURRENT_SHA="$(yxs_sha256 "$BACKUP")"
  if [[ "$RECORD_SHA" != "$CURRENT_SHA" ]]; then
    yxs_die 3 "备份产物哈希不一致：文件 ${BACKUP} 记录 sha256=${RECORD_SHA}，复算=${CURRENT_SHA}。"
  fi
  BASELINE_SHA="$CURRENT_SHA"
else
  yxs_warn "manifest 缺失，跳过哈希/行数/抽样核对：${MANIFEST}。"
  MANIFEST_STATE="missing"
fi

# 清理目标路径旁残留边车
rm -f "${TARGET}-wal" "${TARGET}-shm" \
  || yxs_die 2 "清理目标路径残留边车失败：${TARGET}-wal / ${TARGET}-shm。"
mkdir -p "$(dirname "$TARGET")" \
  || yxs_die 2 "恢复目标父目录创建失败：$(dirname "$TARGET")。"

# 落快照（源为已关闭的单文件一致性快照，此处为静态文件放置，非在线库复制）
cp "$BACKUP" "$TARGET" \
  || yxs_die 2 "写入恢复目标失败：${BACKUP} → ${TARGET}。"

# 恢复后 quick_check
QC="$(yxs_py check-sqlite --path "$TARGET" --level quick)"
QC_RC=$?
if [[ $QC_RC -ne 0 ]]; then
  FIRST="$(printf '%s' "$QC" | sed -n 's/.*"first": *"\(.*\)".*/\1/p')"
  # 引擎自身出错（退出 2，例如 Python 不可用）属环境类，不能伪装成「完整性检查未通过」。
  [[ $QC_RC -eq 2 ]] && yxs_die 2 "校验命令执行失败：check-sqlite --path ${TARGET} --level quick：${FIRST}。"
  yxs_die 3 "恢复库完整性检查未通过：${FIRST}。"
fi

# full 模式再跑 integrity_check；quick 档位记 skipped
INTEGRITY_RESULT="skipped"
if [[ "$INTEGRITY" == "full" ]]; then
  IC="$(yxs_py check-sqlite --path "$TARGET" --level full)"
  IC_RC=$?
  if [[ $IC_RC -ne 0 ]]; then
    FIRST="$(printf '%s' "$IC" | sed -n 's/.*"first": *"\(.*\)".*/\1/p')"
    [[ $IC_RC -eq 2 ]] && yxs_die 2 "校验命令执行失败：check-sqlite --path ${TARGET} --level full：${FIRST}。"
    yxs_die 3 "恢复库完整性检查未通过：${FIRST}。"
  fi
  INTEGRITY_RESULT="ok"
fi

# 行数 / 抽样核对（manifest 存在时对基线；缺失时只取恢复库指纹计数）
ROWS_AFTER=0
SAMPLES_N=0
COMPARE_STATE="skipped"
if [[ "$MANIFEST_STATE" == "present" ]]; then
  CMP="$(yxs_py compare --manifest "$MANIFEST" --candidate "$TARGET" --sample "$SAMPLE")"
  CMP_RC=$?
  if [[ $CMP_RC -ne 0 ]]; then
    KIND="$(printf '%s' "$CMP" | sed -n 's/.*"kind": *"\([^"]*\)".*/\1/p')"
    TBL="$(printf '%s' "$CMP" | sed -n 's/.*"table": *"\([^"]*\)".*/\1/p')"
    COL="$(printf '%s' "$CMP" | sed -n 's/.*"column": *"\([^"]*\)".*/\1/p')"
    PK="$(printf '%s' "$CMP" | sed -n 's/.*"pk": *\[\([^]]*\)\].*/\1/p')"
    BASE="$(printf '%s' "$CMP" | sed -n 's/.*"baseline": *\("[^"]*"\|[^,}]*\).*/\1/p')"
    CAND="$(printf '%s' "$CMP" | sed -n 's/.*"candidate": *\("[^"]*"\|[^,}]*\).*/\1/p')"
    case "$KIND" in
      rows)
        yxs_die 3 "行数不一致：表 ${TBL} 备份前 ${BASE} 行，恢复后 ${CAND} 行。" ;;
      sample)
        yxs_die 3 "抽样不一致：表 ${TBL} 主键 ${PK} 列 ${COL} 备份前=${BASE} 恢复后=${CAND}。" ;;
      missing)
        yxs_die 3 "表集合不一致：备份前有 ${TBL}，恢复后缺失。" ;;
      extra)
        yxs_die 3 "表集合不一致：恢复后多出表 ${TBL}。" ;;
      *)
        yxs_die 3 "恢复后核对不一致：${CMP}。" ;;
    esac
  fi
  COMPARE_STATE="match"
  ROWS_AFTER="$(printf '%s' "$CMP" | grep -o '"rowsAfter": *[0-9]*' | awk -F: '{s+=$2} END{print s+0}')"
  SAMPLES_N="$(printf '%s' "$CMP" | grep -o '"name"' | wc -l | tr -d ' ')"
else
  TMP_FP="$(yxs_tmpdir)"
  FP="$(yxs_py fingerprint-sqlite --path "$TARGET" --out "$TMP_FP" --sample "$SAMPLE")" \
    || yxs_die 2 "读取恢复库指纹失败：${TARGET}。"
  ROWS_AFTER="$(printf '%s' "$FP" | grep -o '"rows": *[0-9]*' | awk -F: '{s+=$2} END{print s+0}')"
  SAMPLES_N="$(printf '%s' "$FP" | grep -o '"name"' | wc -l | tr -d ' ')"
  rm -rf "$TMP_FP" || yxs_warn "临时指纹目录清理失败：${TMP_FP}。"
fi

# 核对连接关闭后，清理并检查目标目录残留边车（最后一步，避免再次打开重建）
rm -f "${TARGET}-wal" "${TARGET}-shm" \
  || yxs_die 2 "清理恢复目标残留边车失败：${TARGET}-wal / ${TARGET}-shm。"
for sc in "${TARGET}-wal" "${TARGET}-shm"; do
  [[ -e "$sc" ]] && yxs_warn "目标目录残留边车文件：${sc}"
done

RECORD_SHA="${BASELINE_SHA:-$(yxs_sha256 "$BACKUP")}"
RECORD="{\"backup\":\"${BACKUP}\",\"target\":\"${TARGET}\",\"sha256\":\"${RECORD_SHA}\",\"quick\":\"ok\",\"integrity\":\"${INTEGRITY_RESULT}\",\"rows\":${ROWS_AFTER},\"samples\":${SAMPLES_N},\"exitCode\":0}"

yxs_log "backup=$BACKUP"
yxs_log "target=$TARGET"
yxs_log "sha256=$RECORD_SHA"
if [[ "$MANIFEST_STATE" == "missing" ]]; then
  yxs_log "manifest=missing compare=skipped"
fi
yxs_log "quick_check=ok"
yxs_log "integrity_check=$INTEGRITY_RESULT"
yxs_log "rows=$ROWS_AFTER"
yxs_log "samples=$SAMPLES_N"
yxs_log "record=$RECORD"
