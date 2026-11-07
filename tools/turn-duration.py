#!/usr/bin/env python3
"""统计每个对话轮次的耗时，用来判断「到底慢在哪一轮」。

数据来自本机 learning.db（不动它，只读打开）：
    python tools/turn-duration.py
    python tools/turn-duration.py --db <路径> --limit 30

输出每轮：耗时秒数、问题长度、问题开头。用来区分两种慢：
    · 2 秒级  = 模型直接回答，没查资料
    · 百秒级  = 走了工具循环，每次模型往返 10–20 秒
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def default_db() -> Path:
    return Path.home() / ".learning-agent" / "data" / "learning.db"


def seconds(a: str, b: str) -> float | None:
    try:
        fmt = "%Y-%m-%dT%H:%M:%S.%f"
        return (datetime.strptime(b[:26].replace("Z", ""), fmt)
                - datetime.strptime(a[:26].replace("Z", ""), fmt)).total_seconds()
    except Exception:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(default_db()))
    ap.add_argument("--limit", type=int, default=25)
    args = ap.parse_args()

    db = Path(args.db)
    if not db.exists():
        print(f"找不到数据库：{db}")
        return 1

    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    cur = con.cursor()
    rows = cur.execute(
        "SELECT turn_id, started_at, finished_at, seq_start, session_id FROM turns ORDER BY rowid DESC LIMIT ?",
        (args.limit,),
    ).fetchall()

    print(f"{'轮次':<18}{'耗时(s)':>9}{'问题字数':>9}  问题开头")
    spans: list[float] = []
    for tid, started, finished, seq, session in rows:
        cost = seconds(started, finished)
        q = cur.execute(
            "SELECT content FROM chat_messages WHERE session_id=? AND seq=?",
            (session, seq - 1),
        ).fetchone()
        text = q[0] if q else ""
        head = text[:34].replace("\n", " ")
        print(f"{tid[:16]:<18}{(cost if cost is not None else -1):>9.1f}{len(text):>9}  {head}")
        if cost and cost > 0:
            spans.append(cost)

    if spans:
        spans.sort()
        print(f"\n轮次 n={len(spans)}  中位数={spans[len(spans)//2]:.1f}s  "
              f"最快={spans[0]:.1f}s  最慢={spans[-1]:.1f}s")
        slow = [s for s in spans if s >= 60]
        print(f"超过 60 秒的轮次：{len(slow)} 个"
              + (f"（{', '.join(f'{s:.0f}s' for s in sorted(slow, reverse=True))}）" if slow else ""))
        print("\n判读：2 秒级=直接回答；百秒级=走了工具循环（每次模型往返 10–20 秒叠加）")
    con.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
