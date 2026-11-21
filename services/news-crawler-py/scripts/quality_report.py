"""新闻正文质量抽检脚本（B 轮，只读，有界内存）。

以只读方式打开 SQLite 新闻库，两遍流式游标扫描：第一遍统计每源行数、
哈希 eligible 与重复分组；第二遍逐行计算长度、退化、导航命中、空标题、
空日期与样本候选，只给入选候选保留截断预览。按来源汇总指标、给出最差
样本与分级结论，产出结构化 JSON 与人读 Markdown 报告。

用法（在仓库根目录）：

    .\\.venv\\Scripts\\python.exe scripts\\quality_report.py \\
        --db .scratch/run/B/home/news.db \\
        --json-out report.json --md-out report.md

脚本仅使用 Python 标准库；不连接采集运行时，不对数据库做任何写入动作。
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "1.0"

#: 冻结导航词表（顺序固定；纯子串匹配，区分大小写，不做分词）。
NAV_TERMS: tuple[str, ...] = (
    "广告",
    "点击查看",
    "相关阅读",
    "相关推荐",
    "扫码下载",
    "下载APP",
    "下载 App",
    "免责声明",
    "版权所有",
    "举报",
    "微信公众号",
    "上一篇",
    "下一篇",
    "返回首页",
    "登录后查看",
    "扫码关注",
    "转载请注明出处",
)

#: 行级缺陷码与权重（与契约 §2.3 表一致）。
DEFECT_WEIGHTS: dict[str, int] = {
    "empty_title": 3,
    "degenerate": 2,
    "short_body": 2,
    "dup_hash": 1,
    "nav_hit": 1,
    "empty_date": 1,
}

MIN_CONTENT_CHARS = 20
CONTENT_PREVIEW_LIMIT = 200
SUMMARY_PREVIEW_LIMIT = 120

VERDICT_LABELS: dict[str, str] = {
    "keep": "保留",
    "downgrade": "降级为只取标题摘要",
    "offline": "下线",
}

SEVERITY: dict[str, int] = {"offline": 3, "downgrade": 2, "keep": 1}

TOPIC_COLUMNS = (
    "id",
    "source",
    "title",
    "url",
    "published_at",
    "summary",
    "content",
    "content_status",
)


# ---------------------------------------------------------------------------
# 参数解析
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="quality_report.py",
        description="新闻正文质量抽检（只读，按来源统计指标并给出分级结论）",
    )
    parser.add_argument("--db", default=None, help="SQLite 库路径；缺省取 NEWS_CRAWLER_DB 或服务根 .data/news.db")
    parser.add_argument("--source", action="append", default=None, help="限定来源 ID，可重复；缺省统计全部源")
    parser.add_argument("--md-out", default=None, help="Markdown 报告落盘路径；缺省打到 stdout（--quiet 时不打）")
    parser.add_argument("--json-out", default=None, help="JSON 报告落盘路径；缺省不写 JSON 文件")
    parser.add_argument("--top", default="5", help="列入最差名单的来源数量，1..50，默认 5")
    parser.add_argument(
        "--samples-per-source",
        default="3",
        help="每源展示的最差样本条数，0..10，默认 3",
    )
    parser.add_argument("--quiet", action="store_true", help="抑制 stdout Markdown，不影响 --json-out 落盘")
    return parser


def _parse_bounded_int(text: str | None, lo: int, hi: int) -> int | None:
    if text is None:
        return None
    try:
        value = int(str(text).strip())
    except (TypeError, ValueError):
        return None
    if value < lo or value > hi:
        return None
    return value


def resolve_db_path(cli_value: str | None) -> Path | None:
    """解析库路径：--db > NEWS_CRAWLER_DB > 服务根 .data/news.db。"""
    env_value = os.environ.get("NEWS_CRAWLER_DB")
    cli_blank = cli_value is None or str(cli_value).strip() == ""
    env_blank = env_value is None or env_value.strip() == ""
    if not cli_blank:
        raw = str(cli_value).strip()
    elif not env_blank:
        raw = env_value.strip()
    elif cli_value is None and env_value is None:
        raw = str(Path(__file__).resolve().parents[1] / ".data" / "news.db")
    else:
        raw = ""
    if not raw:
        return None
    return Path(raw).resolve()


# ---------------------------------------------------------------------------
# 只读连接与表结构探测
# ---------------------------------------------------------------------------


def open_readonly(path: Path) -> sqlite3.Connection:
    """以只读 URI 打开连接，并打开查询只保险。"""
    uri = f"file:{path.as_posix()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True, check_same_thread=False)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    # 显式开启读事务：两遍扫描固定在同一 WAL 快照上，避免并发写入让
    # 第一遍与第二遍看到不同行集（也避免第二遍拿不到第一遍的源键）。
    connection.execute("BEGIN")
    return connection


def table_exists(connection: sqlite3.Connection) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='news_articles'"
    ).fetchone()
    return row is not None


def existing_columns(connection: sqlite3.Connection) -> set[str]:
    return {row[1] for row in connection.execute("PRAGMA table_info(news_articles)")}


# ---------------------------------------------------------------------------
# 指标计算（纯函数，不持有全文）
# ---------------------------------------------------------------------------


def percentile(values: list[int], q: float) -> float | None:
    """线性插值求分位数；空列表返回 None，单元素三值同取该值。"""
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return round(float(ordered[0]), 2)
    h = (len(ordered) - 1) * q
    i = math.floor(h)
    f = h - i
    return round(ordered[i] + f * (ordered[i + 1] - ordered[i]), 2)


def is_degenerate(content: str, summary: str) -> bool:
    """正文≈摘要：去空白后均非空、长度比 ≥0.80、互为去空白子串。"""
    body = "".join(content.split())
    brief = "".join(summary.split())
    if not body or not brief:
        return False
    if len(summary) < 0.80 * len(content):
        return False
    return brief in body or body in brief


def hit_nav_terms(content: str) -> bool:
    return any(term in content for term in NAV_TERMS)


def safe_ratio(part: int, whole: int) -> float | None:
    if whole == 0:
        return None
    return round(part / whole, 4)


# ---------------------------------------------------------------------------
# 两遍流式扫描
# ---------------------------------------------------------------------------


def collect_pass1(
    connection: sqlite3.Connection, has_hash: bool
) -> tuple[dict[str, dict[str, Any]], int, int, int]:
    """第一遍：游标逐行统计每源行数、哈希 eligible 与重复分组。

    返回：每源累加器、全库行数、全库 eligible 行数、全库重复行数。
    判空用 Python 侧 ``strip()``（去除 NBSP 等 Unicode 空白），不用 SQLite TRIM。
    """
    p1: dict[str, dict[str, Any]] = {}
    global_hash_counts: dict[str, int] = {}
    total_n = 0
    global_eligible = 0

    if has_hash:
        cursor = connection.execute(
            "SELECT source, content_hash FROM news_articles ORDER BY id"
        )
    else:
        cursor = connection.execute("SELECT source FROM news_articles ORDER BY id")

    for row in cursor:
        source = row["source"]
        acc = p1.setdefault(
            source,
            {"n": 0, "eligible": 0, "hash_counts": {}, "dup_rows": 0, "dup_hashes": set()},
        )
        acc["n"] += 1
        total_n += 1
        if has_hash:
            digest = str(row["content_hash"] or "").strip()
            if digest:
                acc["eligible"] += 1
                global_eligible += 1
                acc["hash_counts"][digest] = acc["hash_counts"].get(digest, 0) + 1
                global_hash_counts[digest] = global_hash_counts.get(digest, 0) + 1

    for acc in p1.values():
        dup_hashes = {digest for digest, count in acc["hash_counts"].items() if count >= 2}
        dup_rows = sum(acc["hash_counts"][digest] for digest in dup_hashes)
        acc["dup_hashes"] = dup_hashes
        acc["dup_rows"] = dup_rows
        acc["hash_counts"] = {}  # 释放分组计数，仅保留重复哈希集合

    # 全库口径：整表所有 eligible 行放一起按哈希分组（跨源同哈希计重复）。
    global_dup_rows = sum(count for count in global_hash_counts.values() if count >= 2)

    return p1, total_n, global_eligible, global_dup_rows


def push_candidate(
    candidates: list[tuple[int, int, str, dict[str, Any]]],
    score: int,
    length: int,
    article_id: str,
    lite: dict[str, Any],
    limit: int,
) -> None:
    """维护每源 top-N 样本候选；排序键 (-score, L 升序, id 升序)。"""
    candidates.append((score, length, article_id, lite))
    candidates.sort(key=lambda item: (-item[0], item[1], item[2]))
    del candidates[limit:]


def collect_pass2(
    connection: sqlite3.Connection,
    has_hash: bool,
    samples_limit: int,
    p1: dict[str, dict[str, Any]],
) -> tuple[dict[str, dict[str, Any]], dict[str, int]]:
    """第二遍：游标逐行算长度/退化/导航/空标题/空日期/dup 成员，累加计数并维护候选。

    返回：每源累加器（长度列表、计数、top-N 候选），全库计数累加器。
    """
    columns = list(TOPIC_COLUMNS)
    if has_hash:
        columns.append("content_hash")
    select = ", ".join(columns)

    p2: dict[str, dict[str, Any]] = {}
    global_counts = {"deg": 0, "nav": 0, "et": 0, "ed": 0}

    cursor = connection.execute(f"SELECT {select} FROM news_articles ORDER BY id")
    for row in cursor:
        source = row["source"]
        content = row["content"] or ""
        summary = row["summary"] or ""
        title = row["title"] or ""
        published_at = row["published_at"] or ""
        status = row["content_status"] or ""

        acc = p2.setdefault(
            source,
            {"lengths": [], "deg": 0, "nav": 0, "et": 0, "ed": 0, "candidates": []},
        )
        length = len(content)
        acc["lengths"].append(length)

        degenerate = is_degenerate(content, summary)
        nav_hit = hit_nav_terms(content)
        empty_title = title.strip() == ""
        empty_date = published_at.strip() == ""

        if degenerate:
            acc["deg"] += 1
            global_counts["deg"] += 1
        if nav_hit:
            acc["nav"] += 1
            global_counts["nav"] += 1
        if empty_title:
            acc["et"] += 1
            global_counts["et"] += 1
        if empty_date:
            acc["ed"] += 1
            global_counts["ed"] += 1

        if has_hash:
            digest = str(row["content_hash"] or "").strip()
            is_dup = digest in p1[source]["dup_hashes"]
        else:
            digest = ""
            is_dup = False

        defects: list[str] = []
        if empty_title:
            defects.append("empty_title")
        if degenerate:
            defects.append("degenerate")
        if length < MIN_CONTENT_CHARS:
            defects.append("short_body")
        if is_dup:
            defects.append("dup_hash")
        if nav_hit:
            defects.append("nav_hit")
        if empty_date:
            defects.append("empty_date")

        score = sum(DEFECT_WEIGHTS[code] for code in defects)
        lite: dict[str, Any] = {
            "id": row["id"],
            "source": source,
            "title": title,
            "url": row["url"] or "",
            "publishedAt": published_at,
            "contentStatus": status,
            "contentPreview": content[:CONTENT_PREVIEW_LIMIT],
            "truncated": length > CONTENT_PREVIEW_LIMIT,
            "summaryPreview": summary[:SUMMARY_PREVIEW_LIMIT],
            "summaryTruncated": len(summary) > SUMMARY_PREVIEW_LIMIT,
            "defects": defects,
        }
        push_candidate(acc["candidates"], score, length, row["id"], lite, samples_limit)

    return p2, global_counts


# ---------------------------------------------------------------------------
# 分级结论
# ---------------------------------------------------------------------------


def classify(agg: dict[str, Any]) -> tuple[str, list[str]]:
    """按阈值表给出结论与理由；n<3 护栏强制保留，越线判据仍记入理由。"""
    n = agg["n"]
    reasons: list[str] = []
    offline_hit = False
    downgrade_hit = False

    et = agg["emptyTitleRatio"]
    dup = agg["duplicateHashRatio"]
    deg = agg["degenerateRatio"]
    nav = agg["navHitRatio"]
    ed = agg["emptyDateRatio"]
    p10 = agg["length"]["p10"]
    p50 = agg["length"]["p50"]

    # 下线判据（四条，优先于降级）。比例类括号内保留 4 位小数；长度类保持 round 2。
    if et is not None and et >= 0.20:
        reasons.append(f"emptyTitleRatio>=0.20 ({et:.4f})")
        offline_hit = True
    if dup is not None and dup >= 0.30:
        reasons.append(f"duplicateHashRatio>=0.30 ({dup:.4f})")
        offline_hit = True
    if deg is not None and deg >= 0.50:
        reasons.append(f"degenerateRatio>=0.50 ({deg:.4f})")
        offline_hit = True
    if p50 is not None and p50 < 50:
        reasons.append(f"length.p50<50 ({p50})")
        offline_hit = True

    # 降级判据（六条）。
    if p10 is not None and p10 < 100:
        reasons.append(f"length.p10<100 ({p10})")
        downgrade_hit = True
    if deg is not None and deg >= 0.20:
        reasons.append(f"degenerateRatio>=0.20 ({deg:.4f})")
        downgrade_hit = True
    if nav is not None and nav >= 0.20:
        reasons.append(f"navHitRatio>=0.20 ({nav:.4f})")
        downgrade_hit = True
    if ed is not None and ed >= 0.30:
        reasons.append(f"emptyDateRatio>=0.30 ({ed:.4f})")
        downgrade_hit = True
    if dup is not None and dup >= 0.10:
        reasons.append(f"duplicateHashRatio>=0.10 ({dup:.4f})")
        downgrade_hit = True
    if p50 is not None and p50 < 200:
        reasons.append(f"length.p50<200 ({p50})")
        downgrade_hit = True

    if n < 3:
        return "keep", reasons
    if offline_hit:
        return "offline", reasons
    if downgrade_hit:
        return "downgrade", reasons
    return "keep", reasons


def defect_ratio_from_report(report: dict[str, Any]) -> float:
    parts = [
        report["degenerateRatio"] or 0,
        report["navHitRatio"] or 0,
        report["duplicateHashRatio"] or 0,
        report["emptyTitleRatio"] or 0,
        report["emptyDateRatio"] or 0,
    ]
    return round(float(min(1.0, sum(parts))), 4)


# ---------------------------------------------------------------------------
# 报告组装
# ---------------------------------------------------------------------------


def build_source_report(
    source: str,
    p1: dict[str, Any],
    p2: dict[str, Any],
    has_hash: bool,
    top_warnings: list[str],
) -> dict[str, Any]:
    n = p1["n"]
    lengths = p2["lengths"]
    warnings: list[str] = []

    if not has_hash:
        note = "news_articles 表缺少 content_hash 列，哈希重复率无法统计。"
        warnings.append(note)
        if note not in top_warnings:
            top_warnings.append(note)

    duplicate_ratio: float | None
    if not has_hash:
        duplicate_ratio = None
    else:
        duplicate_ratio = safe_ratio(p1["dup_rows"], p1["eligible"])

    metrics: dict[str, Any] = {
        "n": n,
        "length": {
            "p10": percentile(lengths, 0.10),
            "p50": percentile(lengths, 0.50),
            "p90": percentile(lengths, 0.90),
        },
        "degenerateRatio": safe_ratio(p2["deg"], n),
        "navHitRatio": safe_ratio(p2["nav"], n),
        "duplicateHashRatio": duplicate_ratio,
        "emptyTitleRatio": safe_ratio(p2["et"], n),
        "emptyDateRatio": safe_ratio(p2["ed"], n),
    }

    verdict, reasons = classify(metrics)

    if n < 3:
        guard = f"来源 {source} 样本不足 3 条（n={n}），结论仅供参考。"
        warnings.append(guard)
        top_warnings.append(guard)
        reasons.append(f"样本量 n={n}<3，样本护栏强制保留。")

    samples = [lite for _score, _length, _article_id, lite in p2["candidates"]]

    report: dict[str, Any] = {
        "source": source,
        "sampleSize": n,
        "length": metrics["length"],
        "degenerateRatio": metrics["degenerateRatio"],
        "navHitRatio": metrics["navHitRatio"],
        "duplicateHashRatio": metrics["duplicateHashRatio"],
        "emptyTitleRatio": metrics["emptyTitleRatio"],
        "emptyDateRatio": metrics["emptyDateRatio"],
        "verdict": verdict,
        "verdictReasons": reasons,
        "warnings": sorted(warnings),
        "samples": samples,
    }
    return report


def build_worst_sources(
    source_reports: list[dict[str, Any]], top: int
) -> list[dict[str, Any]]:
    enriched = [
        (item, defect_ratio_from_report(item)) for item in source_reports
    ]
    enriched.sort(
        key=lambda pair: (
            -SEVERITY[pair[0]["verdict"]],
            -pair[1],
            pair[0]["source"],
        )
    )
    worst: list[dict[str, Any]] = []
    for rank, (item, defect_ratio) in enumerate(enriched[:top], start=1):
        worst.append(
            {
                "rank": rank,
                "source": item["source"],
                "verdict": item["verdict"],
                "sampleSize": item["sampleSize"],
                "defectRatio": defect_ratio,
                "reasons": list(item["verdictReasons"]),
            }
        )
    return worst


# ---------------------------------------------------------------------------
# 渲染
# ---------------------------------------------------------------------------


def fmt_ratio(value: float | None) -> str:
    return "—" if value is None else str(value)


def fmt_number(value: float | None) -> str:
    return "—" if value is None else str(value)


def render_markdown(report: dict[str, Any], top: int) -> str:
    lines: list[str] = []
    totals = report["totals"]
    lines.append("# 新闻正文质量抽检报告")
    lines.append("")
    lines.append(f"- 生成时间：{report['generatedAt']}")
    lines.append(f"- 数据库：{report['dbPath']}")
    lines.append(f"- 文章总数：{totals['articles']}；来源数：{totals['sources']}")
    lines.append("")

    lines.append(f"### 最差 {top} 个来源")
    lines.append("")
    lines.append(
        "| 排名 | 来源 | 结论 | 样本数 | P50 正文 | 重合率 | 导航命中 | 哈希重复 | 空标题 | 空日期 | 主要问题 |"
    )
    lines.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")

    by_source = {item["source"]: item for item in report["sources"]}
    for worst in report["worstSources"]:
        detail = by_source.get(worst["source"], {})
        lines.append(
            "| {rank} | {source} | {label} | {size} | {p50} | {deg} | {nav} | {dup} | {et} | {ed} | {reasons} |".format(
                rank=worst["rank"],
                source=worst["source"],
                label=VERDICT_LABELS[worst["verdict"]],
                size=worst["sampleSize"],
                p50=fmt_number((detail.get("length") or {}).get("p50")),
                deg=fmt_ratio(detail.get("degenerateRatio")),
                nav=fmt_ratio(detail.get("navHitRatio")),
                dup=fmt_ratio(detail.get("duplicateHashRatio")),
                et=fmt_ratio(detail.get("emptyTitleRatio")),
                ed=fmt_ratio(detail.get("emptyDateRatio")),
                reasons="；".join(worst["reasons"]) or "—",
            )
        )
    lines.append("")

    lines.append("### 各源明细")
    lines.append("")
    for item in report["sources"]:
        lines.append(f"#### {item['source']}（结论：{VERDICT_LABELS[item['verdict']]}）")
        lines.append("")
        length = item["length"]
        lines.append(
            f"- 样本数：{item['sampleSize']}；P10/P50/P90："
            f"{fmt_number(length['p10'])} / {fmt_number(length['p50'])} / {fmt_number(length['p90'])}"
        )
        lines.append(
            f"- 重合率 {fmt_ratio(item['degenerateRatio'])}；"
            f"导航命中 {fmt_ratio(item['navHitRatio'])}；"
            f"哈希重复 {fmt_ratio(item['duplicateHashRatio'])}；"
            f"空标题 {fmt_ratio(item['emptyTitleRatio'])}；"
            f"空日期 {fmt_ratio(item['emptyDateRatio'])}"
        )
        lines.append("- 主要问题：" + ("；".join(item["verdictReasons"]) or "无"))
        lines.append("")
        for index, sample in enumerate(item["samples"], start=1):
            lines.append(f"样本 {index}：{sample['title']}")
            lines.append(
                f"- URL：{sample['url']}；日期：{sample['publishedAt']}；状态：{sample['contentStatus']}"
            )
            lines.append(f"- 正文（截断 200 字）：{sample['contentPreview']}…")
            lines.append("")

    lines.append("### 口径与阈值")
    lines.append("")
    lines.append("指标口径、阈值表与样本选取规则见 docs/news-source-quality.md；本文件仅放摘要。")
    lines.append("")
    return "\n".join(lines)


def write_text_file(path: str, content: str) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8", newline="\n")


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    started = time.monotonic()
    parser = build_parser()
    namespace, extras = parser.parse_known_args(argv)

    if extras:
        print(f"未识别的参数：{extras[0]}。", file=sys.stderr)
        return 2

    top = _parse_bounded_int(namespace.top, 1, 50)
    if top is None:
        print("--top 必须是 1 到 50 的整数。", file=sys.stderr)
        return 2

    samples_limit = _parse_bounded_int(namespace.samples_per_source, 0, 10)
    if samples_limit is None:
        print("--samples-per-source 必须是 0 到 10 的整数。", file=sys.stderr)
        return 2

    db_path = resolve_db_path(namespace.db)
    if db_path is None:
        print("数据库路径不能为空。", file=sys.stderr)
        return 2

    top_warnings: list[str] = []
    connection: sqlite3.Connection | None = None
    try:
        try:
            connection = open_readonly(db_path)
            if not table_exists(connection):
                print("数据库里没有 news_articles 表，无法统计。", file=sys.stderr)
                return 1
            has_hash = "content_hash" in existing_columns(connection)

            p1, total_n, global_eligible, global_dup_rows = collect_pass1(connection, has_hash)
            p2, global_counts = collect_pass2(connection, has_hash, samples_limit, p1)
        except (sqlite3.OperationalError, sqlite3.DatabaseError, OSError) as exc:
            print(
                f"数据库打不开：{db_path}，请检查文件是否存在且为 SQLite 库。",
                file=sys.stderr,
            )
            return 1

        try:
            requested = namespace.source or []
            all_sources = sorted(p1.keys())
            present = set(all_sources)
            for source_id in requested:
                if source_id not in present:
                    top_warnings.append(f"未在库内找到来源：{source_id}。")

            wanted = set(requested) if requested else set(all_sources)
            report_sources = [source for source in all_sources if source in wanted]

            source_reports = [
                build_source_report(source, p1[source], p2[source], has_hash, top_warnings)
                for source in report_sources
            ]

            totals = {
                "articles": total_n,
                "sources": len(all_sources),
                "sourcesWithData": len(all_sources),
            }

            if total_n == 0:
                top_warnings.append("库内新闻文章为 0 条，报告指标全部为空。")

            if not has_hash or global_eligible == 0:
                global_dup_ratio: float | None = None
            else:
                global_dup_ratio = round(global_dup_rows / global_eligible, 4)

            global_report = {
                "degenerateRatio": safe_ratio(global_counts["deg"], total_n),
                "navHitRatio": safe_ratio(global_counts["nav"], total_n),
                "duplicateHashRatio": global_dup_ratio,
                "emptyTitleRatio": safe_ratio(global_counts["et"], total_n),
                "emptyDateRatio": safe_ratio(global_counts["ed"], total_n),
            }

            worst_sources = build_worst_sources(source_reports, top)

            now = datetime.now(UTC)
            generated_at = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
            elapsed_ms = int(round((time.monotonic() - started) * 1000))

            report: dict[str, Any] = {
                "schemaVersion": SCHEMA_VERSION,
                "generatedAt": generated_at,
                "elapsedMs": elapsed_ms,
                "dbPath": str(db_path),
                "dbReadable": True,
                "totals": totals,
                "global": global_report,
                "sources": source_reports,
                "worstSources": worst_sources,
                "warnings": sorted(set(top_warnings)),
            }

            markdown = render_markdown(report, top)

            if namespace.json_out:
                write_text_file(
                    namespace.json_out,
                    json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True),
                )
            if namespace.md_out:
                write_text_file(namespace.md_out, markdown)
            if not namespace.quiet and not namespace.md_out:
                print(markdown)
            return 0
        except (sqlite3.OperationalError, sqlite3.DatabaseError) as exc:
            print(f"数据库读取失败：{type(exc).__name__}。", file=sys.stderr)
            return 1
    finally:
        if connection is not None:
            connection.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
