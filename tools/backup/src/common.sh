#!/usr/bin/env bash
# G 轮备份/恢复公共库：bash 函数 + 内嵌 Python 引擎（子代理 B/C 共用）。
# 接口口径冻结自 .scratch/run/G/spec/api.md 与 plans/.../02-contract.md。
set -u
set -o pipefail

# ---------------------------------------------------------------------------
# 环境变量默认值（显式环境变量优先）
#
# 必须 export：pg_dump / pg_restore / psql / createdb 都是独立子进程，靠 libpq
# 读取环境变量。只赋值不导出时子进程拿不到，会静默回落到 5432 与本地同名用户，
# 于是「默认连 55433」这条契约在没显式设置环境变量的机器上失效。
# ---------------------------------------------------------------------------
: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=55433}"
: "${PGDATABASE:=yxs}"
: "${PGUSER:=yxs}"
export PGHOST PGPORT PGDATABASE PGUSER
: "${YXS_G_SAMPLE:=20}"

# 38 张业务表（与 packages/db/src/index.ts:92-448 登记集合一致，空格分隔）。
YXS_EXPECTED_TABLES="artifacts block_canonical_map bp_projects bp_sections case_matches chapters chat_messages chat_sessions competencies content_blocks content_tags evidence growth_records growth_snapshots ideology_points ideology_tags ingest_runs knowledge_points kp_canonical_map learning_plan learning_states memory_episodes memory_facts news_articles news_tags plugin_state question_attempts question_bank question_ideology question_kps questions research_artifacts research_projects sections skills student_profiles summary_ledger turns"

# ---------------------------------------------------------------------------
# 路径与基础信息
# ---------------------------------------------------------------------------

yxs_version() {
  printf '%s\n' "0.1.0"
}

yxs_repo_root() {
  local dir
  dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  dir="$(cd "$dir/../../.." && pwd)"
  printf '%s\n' "$dir"
}

yxs_backup_root() {
  if [[ -n "${YXS_G_BACKUP_DIR:-}" ]]; then
    printf '%s\n' "$YXS_G_BACKUP_DIR"
  else
    printf '%s\n' "$(yxs_repo_root)/.scratch/run/G/g_backups"
  fi
}

yxs_tool_init() {
  YXS_TOOL="${1:-unknown}"
}

yxs_log() {
  printf '[%s] %s\n' "${YXS_TOOL:-unknown}" "$*"
}

yxs_warn() {
  printf '[%s] %s\n' "${YXS_TOOL:-unknown}" "$*" >&2
}

yxs_die() {
  local code="$1"
  shift
  printf '[%s] %s\n' "${YXS_TOOL:-unknown}" "$*" >&2
  exit "$code"
}

# ---------------------------------------------------------------------------
# 参数校验
# ---------------------------------------------------------------------------

# yxs_need_value <flag> <remain> <中文说明>
yxs_need_value() {
  local flag="$1" remain="$2" cn="$3"
  if [[ "$remain" -le 1 ]]; then
    yxs_die 1 "缺少必填参数 ${flag}：${cn}。"
  fi
}

# yxs_need_arg <name> <value> <中文说明>
yxs_need_arg() {
  local name="$1" value="$2" cn="$3"
  if [[ -z "$value" ]]; then
    yxs_die 1 "缺少必填参数 ${name}：${cn}。"
  fi
}

yxs_is_int() {
  [[ "$1" =~ ^-?[0-9]+$ ]]
}

# yxs_sample <raw>：空则取默认；校验 1..1000；合法值经全局 YXS_SAMPLE_OUT 回传。
# 注意：不能用 $(yxs_sample ...) 捕获，否则 yxs_die 的 exit 只杀子shell。
yxs_sample() {
  local raw="${1:-}"
  if [[ -z "$raw" ]]; then
    YXS_SAMPLE_OUT="${YXS_G_SAMPLE:-20}"
    return 0
  fi
  if ! yxs_is_int "$raw" || [[ "$raw" -lt 1 || "$raw" -gt 1000 ]]; then
    yxs_die 1 "--sample 必须是 1 到 1000 的整数。"
  fi
  YXS_SAMPLE_OUT="$raw"
}

# ---------------------------------------------------------------------------
# slug / 时间戳
# ---------------------------------------------------------------------------

yxs_slug_host() {
  local raw="$1"
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  raw="${raw//[^a-z0-9-]/-}"
  raw="$(printf '%s' "$raw" | sed 's/-\+/-/g; s/^-//; s/-$//')"
  printf '%s' "$raw"
}

yxs_path_slug() {
  local p="$1"
  p="${p//\\//}"
  p="$(printf '%s' "$p" | tr '[:upper:]' '[:lower:]')"
  p="$(printf '%s' "$p" | sed 's|^/[a-z]:/||; s|^/[a-z]/||; s|^/||')"
  p="${p//[^a-z0-9_-]/-}"
  p="$(printf '%s' "$p" | sed 's/-\+/-/g; s/^-//; s/-$//')"
  printf '%s' "$p"
}

yxs_utc_stamp() {
  date -u +%Y%m%dT%H%M%SZ
}

yxs_utc_iso() {
  date -u +%Y-%m-%dT%H:%M:%S.000Z
}

# ---------------------------------------------------------------------------
# 哈希 / 字节（走 Python 引擎，不依赖 sha256sum）
# ---------------------------------------------------------------------------

_yxs_hash_json() {
  yxs_py hash --path "$1"
}

yxs_sha256() {
  local f="$1" json
  json="$(_yxs_hash_json "$f")"
  printf '%s' "$json" | sed -n 's/.*"sha256": *"\([0-9a-f]\{64\}\)".*/\1/p'
}

yxs_bytes() {
  local f="$1" json
  json="$(_yxs_hash_json "$f")"
  printf '%s' "$json" | sed -n 's/.*"bytes": *\([0-9][0-9]*\).*/\1/p'
}

# ---------------------------------------------------------------------------
# 受保护路径判定
# ---------------------------------------------------------------------------

_yxs_norm_path() {
  local p="$1"
  p="${p//\\//}"
  p="$(realpath -m "$p" 2>/dev/null || printf '%s' "$p")"
  p="$(printf '%s' "$p" | tr '[:upper:]' '[:lower:]')"
  # Git Bash / MSYS 把 C:\ 写成 /c/，而 $APPDATA、$HOME 这类原生值归一后是 c:/。
  # 两边不统一就会漏判：/c/Users/<u>/AppData/Roaming 与 c:/users/<u>/appdata/roaming
  # 必须落到同一个字符串上比较。这里统一成 c:/ 形态，而不是把盘符抹掉。
  p="$(printf '%s' "$p" | sed -E 's#^/([a-z]):/#\1:/#; s#^/([a-z])/#\1:/#; s#^/([a-z])$#\1:#')"
  # 去掉尾斜杠，避免同一目录带不带斜杠判成两条路径；盘符根 c:/ 与 / 保留。
  if [[ "$p" != "/" && "$p" != ??:/ ]]; then
    while [[ "$p" == ?*/ ]]; do p="${p%/}"; done
  fi
  # 归一结果为空会让「空 == 空」的比较误判为命中，兜一个绝对根。
  [[ -n "$p" ]] || p="/"
  printf '%s' "$p"
}

yxs_is_protected() {
  local cand root
  cand="$(_yxs_norm_path "$1")"
  local roots=()
  [[ -n "${APPDATA:-}" ]] && roots+=("$APPDATA")
  [[ -n "${HOME:-}" ]] && roots+=("$HOME/.learning-agent")
  roots+=("$(yxs_repo_root)/.learning-agent")
  [[ -n "${LEARNING_AGENT_HOME:-}" ]] && roots+=("$LEARNING_AGENT_HOME")
  for root in "${roots[@]}"; do
    root="$(_yxs_norm_path "$root")"
    if [[ "$cand" == "$root" || "$cand" == "$root"/* ]]; then
      return 0
    fi
  done
  return 1
}

# yxs_same_path <a> <b>：两条路径指向同一文件即返回 0。
# 归一后比较兜住 ./x 与 x、/c/... 与 C:\... 这类写法差异；-ef 兜住符号链接与硬链接。
# 用于「恢复目标不得等于备份产物」这类必须挡住覆盖的判定。
yxs_same_path() {
  local a="$1" b="$2"
  if [[ "$(_yxs_norm_path "$a")" == "$(_yxs_norm_path "$b")" ]]; then
    return 0
  fi
  [[ -e "$a" && -e "$b" && "$a" -ef "$b" ]]
}

# ---------------------------------------------------------------------------
# 命令探测 / Python 调用
# ---------------------------------------------------------------------------

yxs_require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    yxs_die 2 "未找到 ${cmd}（sqlite3 / pg_dump / pg_restore），请先安装并确认在 PATH 中。"
  fi
}

yxs_pg_conn_str() {
  printf 'host=%s port=%s user=%s dbname=%s' "$PGHOST" "$PGPORT" "$PGUSER" "$PGDATABASE"
}

yxs_tmpdir() {
  local d
  d="$(mktemp -d)" || yxs_die 2 "创建临时目录失败（mktemp -d）。"
  [[ -d "$d" ]] || yxs_die 2 "创建临时目录失败（mktemp -d 未产出目录）：${d}。"
  printf '%s\n' "$d"
}

# ---------------------------------------------------------------------------
# 内嵌 Python 引擎（不落额外 .py 文件）
# ---------------------------------------------------------------------------

YXS_PY_ENGINE=$(cat <<'PYEOF'
import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
import subprocess


# ---------------------------------------------------------------------------
# 通用小工具
# ---------------------------------------------------------------------------

def ro_connect(path):
    return sqlite3.connect("file:%s?mode=ro" % path, uri=True)


def list_tables(con):
    rows = con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()
    return [r[0] for r in rows]


def table_pk(con, table):
    info = con.execute('PRAGMA table_info("%s")' % table).fetchall()
    return [r[1] for r in info if r[5] > 0]


def row_digest(obj):
    return json.dumps(obj, sort_keys=True, ensure_ascii=False,
                      separators=(',', ':'), default=str)


def hash_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return {"sha256": h.hexdigest(), "bytes": os.path.getsize(path)}


def fingerprint_table(con, table, pk, sample_n):
    cols = [r[1] for r in con.execute(
        'PRAGMA table_info("%s")' % table).fetchall()]
    if pk:
        order = ", ".join('"%s" ASC' % c for c in pk)
        sort_key = ",".join(pk)
    else:
        order = "rowid ASC"
        sort_key = "rowid"
    n = con.execute('SELECT count(*) FROM "%s"' % table).fetchone()[0]
    cur = con.execute(
        'SELECT * FROM "%s" ORDER BY %s' % (table, order))
    digest_lines = []
    sample_rows = []
    while True:
        batch = cur.fetchmany(500)
        if not batch:
            break
        for r in batch:
            obj = dict(zip(cols, r))
            digest_lines.append(row_digest(obj))
            if len(sample_rows) < sample_n:
                pkvals = [obj[c] for c in pk] if pk else [None]
                sample_rows.append({"pk": pkvals, "values": obj})
    digest = "\n".join(digest_lines).encode("utf-8")
    entry = {
        "name": table,
        "rows": n,
        "sizeBytes": None,
        "sha256": hashlib.sha256(digest).hexdigest(),
    }
    sample = {
        "table": table,
        "primaryKey": pk,
        "sampleSize": min(n, sample_n),
        "sortKey": sort_key,
        "rows": sample_rows,
    }
    return entry, sample


# ---------------------------------------------------------------------------
# 子命令：hash
# ---------------------------------------------------------------------------

def cmd_hash(a):
    print(json.dumps(hash_file(a.path)))


# ---------------------------------------------------------------------------
# 子命令：inspect-sqlite
# ---------------------------------------------------------------------------

def cmd_inspect(a):
    con = ro_connect(a.path)
    try:
        uv = con.execute("PRAGMA user_version").fetchone()[0]
        aid = con.execute("PRAGMA application_id").fetchone()[0]
        jm = con.execute("PRAGMA journal_mode").fetchone()[0]

        def side(ext):
            p = a.path + ext
            return os.path.getsize(p) if os.path.exists(p) else None

        tables = [{"name": t, "pk": table_pk(con, t)}
                  for t in list_tables(con)]
        doc = {
            "userVersion": uv,
            "applicationId": aid,
            "journalMode": jm,
            "sidecars": {"wal": side("-wal"), "shm": side("-shm")},
            "tables": tables,
        }
        print(json.dumps(doc, ensure_ascii=False))
    finally:
        con.close()


# ---------------------------------------------------------------------------
# 子命令：fingerprint-sqlite
# ---------------------------------------------------------------------------

def cmd_fingerprint(a):
    samples_dir = os.path.join(a.out, "samples")
    os.makedirs(samples_dir, exist_ok=True)
    con = ro_connect(a.path)
    tables_out = []
    try:
        for t in list_tables(con):
            pk = table_pk(con, t)
            entry, sample = fingerprint_table(con, t, pk, a.sample)
            tables_out.append(entry)
            with open(os.path.join(samples_dir, t + ".json"),
                      "w", encoding="utf-8") as f:
                json.dump(sample, f, ensure_ascii=False, indent=2)
    finally:
        con.close()
    if a.tables_file:
        with open(a.tables_file, "w", encoding="utf-8") as f:
            json.dump(tables_out, f, ensure_ascii=False, indent=2)
    print(json.dumps({"tables": tables_out, "samplesDir": samples_dir},
                      ensure_ascii=False))


# ---------------------------------------------------------------------------
# 子命令：fingerprint-rows（PG 侧 JSONL 复用）
#   可选 --rows N：调用方用 psql count(*) 现查的全表行数；传入时条目 rows=N，
#   samples/<table>.json 仍只存抽样行、sampleSize=实际抽样条数；不传则 rows=JSONL 行数。
#   --rows 非整数 → exit 2。
# ---------------------------------------------------------------------------

def cmd_fingerprint_rows(a):
    pk = [x for x in a.pk.split(",") if x]
    samples_dir = os.path.join(a.out, "samples")
    os.makedirs(samples_dir, exist_ok=True)
    digest_lines = []
    sample_rows = []
    n = 0
    with open(a.input, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            n += 1
            digest_lines.append(row_digest(obj))
            if len(sample_rows) < a.sample:
                sample_rows.append({
                    "pk": [obj.get(c) for c in pk],
                    "values": obj,
                })
    digest = "\n".join(digest_lines).encode("utf-8")
    # --rows 由调用方用 count(*) 现查全表行数；不传则取 JSONL 行数
    rows_out = a.rows if a.rows is not None else n
    entry = {
        "name": a.table,
        "rows": rows_out,
        "sizeBytes": None,
        "sha256": hashlib.sha256(digest).hexdigest(),
    }
    sample = {
        "table": a.table,
        "primaryKey": pk,
        "sampleSize": len(sample_rows),
        "sortKey": ",".join(pk) if pk else "rowid",
        "rows": sample_rows,
    }
    with open(os.path.join(samples_dir, a.table + ".json"),
              "w", encoding="utf-8") as f:
        json.dump(sample, f, ensure_ascii=False, indent=2)
    print(json.dumps(entry, ensure_ascii=False))


# ---------------------------------------------------------------------------
# 子命令：backup-sqlite
# ---------------------------------------------------------------------------

def _cli_backup(src, dst, cli):
    r = subprocess.run([cli, src, ".backup '%s'" % dst],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout or "cli failed").strip())


def _py_backup(src, dst):
    s = sqlite3.connect("file:%s?mode=ro" % src, uri=True)
    d = sqlite3.connect(dst)
    try:
        with d:
            s.backup(d)
    finally:
        s.close()
        d.close()


def _vacuum_into(src, dst):
    s = sqlite3.connect(src)
    try:
        s.execute("VACUUM INTO '%s'" % dst)
    finally:
        s.close()


def cmd_backup(a):
    dst = a.dst
    if os.path.exists(dst):
        os.remove(dst)
    parent = os.path.dirname(dst)
    if parent:
        os.makedirs(parent, exist_ok=True)
    cli = shutil.which("sqlite3")
    method = None
    detail = ""
    if a.method == "vacuum":
        _vacuum_into(a.src, dst)
        method = "vacuum"
    elif a.method == "backup":
        if cli:
            try:
                _cli_backup(a.src, dst, cli)
                method = "backup"
            except Exception as e:
                detail = str(e)
                raise
        else:
            _py_backup(a.src, dst)
            method = "backup"
    else:  # auto
        if cli:
            try:
                _cli_backup(a.src, dst, cli)
                method = "backup"
            except Exception as e:
                detail = str(e)
                method = None
        if method is None:
            try:
                _py_backup(a.src, dst)
                method = "backup"
            except Exception as e:
                detail = str(e)
                _vacuum_into(a.src, dst)
                method = "vacuum"
    print(json.dumps({"method": method,
                      "sqliteVersion": sqlite3.sqlite_version}))


# ---------------------------------------------------------------------------
# 子命令：check-sqlite
# ---------------------------------------------------------------------------

def cmd_check(a):
    try:
        con = sqlite3.connect(a.path)
        try:
            prag = "quick_check" if a.level == "quick" else "integrity_check"
            rows = con.execute("PRAGMA %s" % prag).fetchall()
            first = rows[0][0] if rows else ""
            ok = str(first) == "ok"
        finally:
            con.close()
    except sqlite3.Error as e:
        print(json.dumps({"ok": False, "first": str(e)},
                          ensure_ascii=False))
        sys.exit(3)
    if ok:
        print(json.dumps({"ok": True, "level": a.level, "first": "ok"}))
    else:
        print(json.dumps({"ok": False, "first": str(first)},
                          ensure_ascii=False))
        sys.exit(3)


# ---------------------------------------------------------------------------
# 子命令：compare
#   --candidate 按扩展名判别：.db/.sqlite → 只读打开现算指纹；.json → 读指纹汇总
#   {"tables":[{name,rows,sizeBytes,sha256}],"samplesDir":"DIR/samples"} 作为候选侧。
#   可选 --samples DIR 覆盖候选抽样目录；不传则取 JSON 内 samplesDir（库形态取同级 samples/）。
#   输出结构与退出码不变：一致 exit 0 ok:true；不一致 exit 3，firstDiff={kind,table,pk,column,baseline,candidate}。
# ---------------------------------------------------------------------------

def _values_equal(b, c):
    if b is None or c is None:
        return b is None and c is None
    if isinstance(b, float) or isinstance(c, float):
        try:
            if abs(float(b) - float(c)) <= 1e-9 * max(1.0, abs(float(b)),
                                                       abs(float(c))):
                return True
        except (TypeError, ValueError):
            pass
        return b == c
    if isinstance(b, str) and isinstance(c, str):
        try:
            return json.loads(b) == json.loads(c)
        except Exception:
            return b == c
    return b == c


def _sample_map(rows):
    out = {}
    for r in rows:
        out[tuple(r["pk"])] = r["values"]
    return out


def _load_sample(path):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return None


def cmd_compare(a):
    with open(a.manifest, encoding="utf-8") as f:
        manifest = json.load(f)
    base_tables = {t["name"]: t for t in manifest.get("tables", [])}
    base_samples_dir = os.path.join(os.path.dirname(a.manifest), "samples")

    # --candidate 两种形态：.db/.sqlite 库路径（现算指纹）；.json 指纹汇总文件（直接读）
    is_json = a.candidate.lower().endswith(".json")
    con = None
    cand_entries = {}
    cand_samples_dir = os.path.join(os.path.dirname(a.candidate), "samples")
    if is_json:
        with open(a.candidate, encoding="utf-8") as f:
            summary = json.load(f)
        cand_entries = {t["name"]: t for t in summary.get("tables", [])}
        if a.samples:
            cand_samples_dir = a.samples
        elif summary.get("samplesDir"):
            cand_samples_dir = summary["samplesDir"]
    else:
        con = ro_connect(a.candidate)
        for t in list_tables(con):
            cand_entries[t] = {"name": t, "rows": None, "sha256": None}

    rep = []
    first = None
    try:
        cand_set = set(cand_entries)
        for name, base in base_tables.items():
            if name not in cand_set:
                rep.append({"name": name, "rowsBaseline": base["rows"],
                            "rowsAfter": None, "sampleResult": "missing",
                            "hashResult": "missing"})
                if first is None:
                    first = {"kind": "missing", "table": name, "pk": None,
                             "column": None, "baseline": base["rows"],
                             "candidate": None}
                continue

            if is_json:
                entry = cand_entries[name]
                sample = _load_sample(os.path.join(cand_samples_dir,
                                                   name + ".json"))
                sample_rows = sample["rows"] if sample else []
            else:
                pk = table_pk(con, name)
                entry, sample = fingerprint_table(con, name, pk, a.sample)
                sample_rows = sample["rows"]

            rows_ok = entry.get("rows") == base["rows"]
            hash_ok = entry.get("sha256") == base["sha256"]
            sample_ok = True
            base_sample = _load_sample(os.path.join(base_samples_dir,
                                                    name + ".json"))
            if base_sample is not None:
                bmap = _sample_map(base_sample["rows"])
                cmap = _sample_map(sample_rows)
                if set(bmap.keys()) != set(cmap.keys()):
                    sample_ok = False
                    if first is None:
                        only_b = sorted(set(bmap) - set(cmap))
                        only_c = sorted(set(cmap) - set(bmap))
                        first = {"kind": "sample", "table": name,
                                 "pk": list(only_b[0] if only_b else
                                            only_c[0]),
                                 "column": None,
                                 "baseline": None if only_b else
                                 base_sample["rows"][:1],
                                 "candidate": None if only_c else
                                 sample_rows[:1]}
                else:
                    for pkval, bvals in bmap.items():
                        cvals = cmap[pkval]
                        for col in sorted(set(bvals) | set(cvals)):
                            if not _values_equal(bvals.get(col),
                                                 cvals.get(col)):
                                sample_ok = False
                                if first is None:
                                    first = {"kind": "sample", "table": name,
                                             "pk": list(pkval),
                                             "column": col,
                                             "baseline": bvals.get(col),
                                             "candidate": cvals.get(col)}
                                break
                        if first is not None and first.get("kind") == "sample":
                            break

            if not rows_ok and first is None:
                first = {"kind": "rows", "table": name, "pk": None,
                         "column": None, "baseline": base["rows"],
                         "candidate": entry.get("rows")}
            elif not hash_ok and first is None:
                first = {"kind": "sample", "table": name, "pk": None,
                         "column": None,
                         "baseline": base["sha256"],
                         "candidate": entry.get("sha256")}

            rep.append({
                "name": name,
                "rowsBaseline": base["rows"],
                "rowsAfter": entry.get("rows"),
                "sampleResult": "match" if sample_ok else "mismatch",
                "hashResult": "match" if hash_ok else "mismatch",
            })

        for name in cand_set:
            if name not in base_tables and first is None:
                first = {"kind": "extra", "table": name, "pk": None,
                         "column": None, "baseline": None,
                         "candidate": name}
    finally:
        if con is not None:
            con.close()

    ok = first is None
    print(json.dumps({"ok": ok, "tables": rep, "firstDiff": first},
                      ensure_ascii=False))
    if not ok:
        sys.exit(3)


# ---------------------------------------------------------------------------
# 子命令：manifest
# ---------------------------------------------------------------------------

def _path_slug(path):
    p = path.replace("\\", "/").lower()
    p = re.sub(r"^/[a-z]:/", "/", p)
    p = re.sub(r"^/[a-z]/", "/", p)
    p = re.sub(r"^/", "", p)
    p = re.sub(r"[^a-z0-9_-]", "-", p)
    p = re.sub(r"-+", "-", p).strip("-")
    return p


def cmd_manifest(a):
    with open(a.tables, encoding="utf-8") as f:
        tables = json.load(f)
    art = hash_file(a.artifact)

    iso = a.created_at
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})", iso)
    if m:
        stamp = "%s%s%sT%s%s%sZ" % m.groups()
    else:
        stamp = iso
    backup_id = "%s-%s-%s" % (a.host, _path_slug(a.source), stamp)

    client = {}
    if a.client_versions:
        for kv in a.client_versions.split(","):
            if "=" in kv:
                k, v = kv.split("=", 1)
                client[k] = v

    schema = None if a.schema_version == "null" else int(a.schema_version)
    label = None if a.label == "" else a.label
    drill = None if a.drill_ref in ("null", "") else a.drill_ref
    integrity = None if a.integrity == "null" else a.integrity

    doc = {
        "manifestVersion": "1",
        "backupId": backup_id,
        "kind": a.kind,
        "source": {
            "host": a.host,
            "path": a.source,
            "dbName": a.db_name,
            "schemaVersion": schema,
            "label": label,
        },
        "createdAt": iso,
        "tool": {
            "name": a.tool,
            "version": a.version,
            "clientVersions": client,
        },
        "artifact": {
            "fileName": os.path.basename(a.artifact),
            "format": a.format,
            "bytes": art["bytes"],
            "sha256": art["sha256"],
        },
        "tables": tables,
        "checks": {"quickCheck": a.quick, "integrityCheck": integrity},
        "drillRef": drill,
    }
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
    print(a.out)


# ---------------------------------------------------------------------------
# 子命令：report（七段 markdown）
# ---------------------------------------------------------------------------

def _md_value(v):
    if v is None:
        return "null"
    if isinstance(v, (dict, list)):
        return "`%s`" % json.dumps(v, ensure_ascii=False)
    return str(v)


def cmd_report(a):
    with open(a.spec, encoding="utf-8") as f:
        spec = json.load(f)

    def g(key):
        return spec.get(key)

    lines = []
    lines.append("# 演练报告")
    lines.append("")

    lines.append("## 1. 元信息")
    for k in ["drillId", "kind", "startedAt", "finishedAt", "host",
              "toolVersion", "clientVersions", "source"]:
        lines.append("- %s: %s" % (k, _md_value(g(k))))
    lines.append("")

    lines.append("## 2. 备份段")
    b = g("backup") or {}
    for k in ["artifact", "bytes", "sha256", "elapsedMs", "checks",
              "manifestRef"]:
        lines.append("- %s: %s" % (k, _md_value(b.get(k))))
    lines.append("")

    lines.append("## 3. 删除段")
    d = g("delete") or {}
    for k in ["target", "method", "deletedAt", "rowsBefore",
              "irreversibleNote"]:
        lines.append("- %s: %s" % (k, _md_value(d.get(k))))
    lines.append("")

    lines.append("## 4. 恢复段")
    r = g("restore") or {}
    for k in ["targetDb", "targetPath", "elapsedMs", "restoreCommand",
              "exitCode"]:
        if k in r:
            lines.append("- %s: %s" % (k, _md_value(r.get(k))))
    lines.append("")

    lines.append("## 5. 核对段")
    v = g("verify") or {}
    for t in v.get("tables", []):
        lines.append("- %s: rowsBaseline=%s rowsAfter=%s sampleSize=%s "
                     "sampleResult=%s hashResult=%s" % (
                         t.get("name"), t.get("rowsBaseline"),
                         t.get("rowsAfter"), t.get("sampleSize"),
                         t.get("sampleResult"), t.get("hashResult")))
    lines.append("- firstDiff: %s" % _md_value(v.get("firstDiff")))
    lines.append("")

    lines.append("## 6. 结论")
    vd = g("verdict") or {}
    # 渲染标签按 02 §3.7 冻结字段名：verdict / failedStage / reproduceCommand；
    # spec JSON 侧键名仍为 verdict.value（api.md §4），只改渲染标签。
    lines.append("- verdict: %s" % _md_value(vd.get("value")))
    lines.append("- failedStage: %s" % _md_value(vd.get("failedStage")))
    lines.append("- reproduceCommand: %s" % _md_value(vd.get("reproduceCommand")))
    lines.append("")

    lines.append("## 7. 附录")
    ap = g("appendix") or {}
    for k in ["env", "stdout", "limitations"]:
        lines.append("- %s: %s" % (k, _md_value(ap.get(k))))
    lines.append("")

    with open(a.out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(a.out)


# ---------------------------------------------------------------------------
# 参数装配
# ---------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("hash")
    sp.add_argument("--path", required=True)

    sp = sub.add_parser("inspect-sqlite")
    sp.add_argument("--path", required=True)

    sp = sub.add_parser("fingerprint-sqlite")
    sp.add_argument("--path", required=True)
    sp.add_argument("--out", required=True)
    sp.add_argument("--sample", type=int, required=True)
    sp.add_argument("--tables-file", default="")

    sp = sub.add_parser("fingerprint-rows")
    sp.add_argument("--table", required=True)
    sp.add_argument("--pk", required=True)
    sp.add_argument("--input", required=True)
    sp.add_argument("--out", required=True)
    sp.add_argument("--sample", type=int, required=True)
    sp.add_argument("--rows", type=int, default=None)

    sp = sub.add_parser("backup-sqlite")
    sp.add_argument("--src", required=True)
    sp.add_argument("--dst", required=True)
    sp.add_argument("--method", choices=["auto", "backup", "vacuum"],
                    default="auto")

    sp = sub.add_parser("check-sqlite")
    sp.add_argument("--path", required=True)
    sp.add_argument("--level", choices=["quick", "full"], required=True)

    sp = sub.add_parser("compare")
    sp.add_argument("--manifest", required=True)
    sp.add_argument("--candidate", required=True)
    sp.add_argument("--sample", type=int, required=True)
    sp.add_argument("--samples", default="")

    sp = sub.add_parser("manifest")
    sp.add_argument("--out", required=True)
    sp.add_argument("--kind", required=True)
    sp.add_argument("--host", required=True)
    sp.add_argument("--source", required=True)
    sp.add_argument("--db-name", required=True)
    sp.add_argument("--schema-version", required=True)
    sp.add_argument("--label", default="")
    sp.add_argument("--tool", required=True)
    sp.add_argument("--version", required=True)
    sp.add_argument("--client-versions", default="")
    sp.add_argument("--artifact", required=True)
    sp.add_argument("--format", required=True)
    sp.add_argument("--tables", required=True)
    sp.add_argument("--quick", required=True)
    sp.add_argument("--integrity", required=True)
    sp.add_argument("--drill-ref", default="null")
    sp.add_argument("--created-at", required=True)

    sp = sub.add_parser("report")
    sp.add_argument("--spec", required=True)
    sp.add_argument("--out", required=True)

    a = p.parse_args()
    try:
        if a.cmd == "hash":
            cmd_hash(a)
        elif a.cmd == "inspect-sqlite":
            cmd_inspect(a)
        elif a.cmd == "fingerprint-sqlite":
            cmd_fingerprint(a)
        elif a.cmd == "fingerprint-rows":
            cmd_fingerprint_rows(a)
        elif a.cmd == "backup-sqlite":
            cmd_backup(a)
        elif a.cmd == "check-sqlite":
            cmd_check(a)
        elif a.cmd == "compare":
            cmd_compare(a)
        elif a.cmd == "manifest":
            cmd_manifest(a)
        elif a.cmd == "report":
            cmd_report(a)
    except SystemExit:
        raise
    except Exception as e:
        print("engine error: %s" % e, file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
PYEOF
)

yxs_py() {
  local py=""
  if command -v python3 >/dev/null 2>&1 && python3 -c "import sys" >/dev/null 2>&1; then
    py=python3
  elif command -v python >/dev/null 2>&1; then
    py=python
  else
    yxs_die 2 "未找到 python3（sqlite3 / pg_dump / pg_restore），请先安装并确认在 PATH 中。"
  fi
  "$py" -c "$YXS_PY_ENGINE" "$@"
}
