#!/usr/bin/env python3
"""校验 plans/server-client-split 下 A–I 九轮细化文档。

只查机器能查的硬指标，不评判文笔：

  1. 齐不齐：每轮必须有 README.md + 01-scope + 02-contract + 03-implementation + 04-acceptance
  2. 节数：每份 >= 6 个二级节，且必须含该类文档规定的节名
  3. 引用分布：每个二级节至少 1 个 [Rn] 标记
  4. 参考清单：文末「参考」节至少有 5 条带 https:// 的条目
  5. 真实依据：正文里的 `路径:行号` 必须指向仓库里真实存在的文件与真实行号
  6. 不糊弄：不许 TODO / 待补 / 后面再说 / TBD / FIXME

跑法（在仓库根目录）：
    python plans/server-client-split/00-master/check-docs.py
    python plans/server-client-split/00-master/check-docs.py --round A
退出码 0 全过；1 有问题并逐条打印。
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROUNDS = ["A", "B", "C", "D", "E", "F", "G", "H", "I"]

DOCS = {
    "01-scope.md": {
        "min_lines": 120,
        "sections": ["目标", "非目标", "真实依据", "产物", "并行边界", "风险"],
    },
    "02-contract.md": {
        "min_lines": 150,
        "sections": ["契约", "数据结构", "错误", "事件", "兼容", "测试"],
    },
    "03-implementation.md": {
        "min_lines": 150,
        "sections": ["目录", "依赖", "实现", "数据读写", "配置", "失败", "性能", "实施"],
    },
    "04-acceptance.md": {
        "min_lines": 120,
        "sections": ["验收", "前置", "用例", "证据", "反向", "排查", "自检"],
    },
}

PLACEHOLDERS = re.compile(r"TODO|待补|后面再说|待定|TBD|FIXME", re.IGNORECASE)
SECTION = re.compile(r"^##\s+(.*)$")
R_MARK = re.compile(r"\[R\d+\]")
URL = re.compile(r"https://[^\s)>\]]+")
# 只认带斜杠、带代码/文档后缀的本地引用，避免把口语里的文件名算进来
LOCAL_REF = re.compile(
    r"([A-Za-z0-9_@./\-]*/[A-Za-z0-9_@./\-]+\.(?:ts|tsx|mjs|js|json|yml|yaml|py|sh|ps1|md|sql))"
    r"(?::(\d+)(?:-(\d+))?)?"
)


def load_lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8", errors="replace").splitlines()


def strip_urls(line: str) -> str:
    return URL.sub("", line)


def split_sections(lines: list[str]) -> list[tuple[str, int, str]]:
    """返回 [(标题, 起始行号, 正文)]。"""
    marks: list[tuple[int, str]] = []
    for i, line in enumerate(lines):
        m = SECTION.match(line)
        if m:
            marks.append((i, m.group(1).strip()))
    out: list[tuple[str, int, str]] = []
    for idx, (i, title) in enumerate(marks):
        end = marks[idx + 1][0] if idx + 1 < len(marks) else len(lines)
        out.append((title, i + 1, "\n".join(lines[i + 1 : end])))
    return out


def check_local_refs(doc: Path, lines: list[str], repo: Path) -> list[str]:
    """只校验带行号的引用（`path:12` / `path:12-30`）。

    不带行号的路径可能是在描述「将来要新建的文件」，不是现状证据，
    强行校验会把产物清单全部判成错误。
    """
    problems: list[str] = []
    for lineno, line in enumerate(lines, 1):
        if "http://" in line or "https://" in line:
            line = strip_urls(line)
        for m in LOCAL_REF.finditer(line):
            ref, start, end = m.group(1), m.group(2), m.group(3)
            if not start:
                continue
            if ref.startswith("..") or ref.startswith("/"):
                continue
            target = repo / ref
            if not target.is_file():
                problems.append(f"{doc.name}:{lineno} 引用的文件不存在：{ref}:{start}")
                continue
            total = sum(1 for _ in target.open("r", encoding="utf-8", errors="replace"))
            hi = int(end or start)
            lo = int(start)
            if lo < 1 or hi > total:
                problems.append(
                    f"{doc.name}:{lineno} 行号越界：{ref}:{start}-{end or start}，该文件只有 {total} 行"
                )
    return problems


def check_doc(doc: Path, spec: dict, repo: Path) -> list[str]:
    problems: list[str] = []
    lines = load_lines(doc)
    if not lines:
        return [f"{doc.name} 是空文件"]
    if not lines[0].startswith("# "):
        problems.append(f"{doc.name}:1 缺少一级标题（# 开头）")
    if len(lines) < spec["min_lines"]:
        problems.append(f"{doc.name} 只有 {len(lines)} 行，少于 {spec['min_lines']} 行")

    secs = split_sections(lines)
    if len(secs) < 6:
        problems.append(f"{doc.name} 只有 {len(secs)} 个二级节，至少 6 个")

    titles = " | ".join(t for t, _, _ in secs)
    for need in spec["sections"]:
        if need not in titles:
            problems.append(f"{doc.name} 缺规定的节：包含「{need}」的二级标题")

    for title, at, body in secs:
        if "参考" == title.strip() or title.strip().startswith("参考"):
            continue
        if not R_MARK.search(body):
            problems.append(f"{doc.name}:{at} 节「{title}」没有任何 [Rn] 引用标记")

    ref_sec = [s for s in secs if s[0].strip().startswith("参考")]
    if not ref_sec:
        problems.append(f"{doc.name} 缺「## 参考」节")
    else:
        urls = {u for u in URL.findall(ref_sec[-1][2])}
        if len(urls) < 5:
            problems.append(f"{doc.name} 参考节只有 {len(urls)} 条 URL，至少 5 条")

    for lineno, line in enumerate(lines, 1):
        m = PLACEHOLDERS.search(line)
        if m:
            problems.append(f"{doc.name}:{lineno} 残留占位词「{m.group(0)}」")

    problems.extend(check_local_refs(doc, lines, repo))
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--round", default=None, help="只查某一轮，如 A")
    ap.add_argument("--root", default=str(Path(__file__).resolve().parents[3]),
                    help="仓库根目录（默认从脚本位置推三层）")
    args = ap.parse_args()

    repo = Path(args.root).resolve()
    plan = Path(__file__).resolve().parents[1]
    rounds = [args.round] if args.round else ROUNDS

    all_problems: list[str] = []
    stats: list[str] = []
    for r in rounds:
        dirs = sorted(plan.glob(f"{r}-*"))
        dirs = [d for d in dirs if d.is_dir()]
        if not dirs:
            all_problems.append(f"[{r}] 找不到轮次目录 {r}-*")
            continue
        rdir = dirs[0]
        if not (rdir / "README.md").is_file():
            all_problems.append(f"[{r}] 缺原始 README.md（验收基线，不能删）")
        for name, spec in DOCS.items():
            doc = rdir / name
            if not doc.is_file():
                all_problems.append(f"[{r}] 缺文档 {name}")
                continue
            problems = check_doc(doc, spec, repo)
            all_problems.extend(f"[{r}] {p}" for p in problems)
        total = sum(len(load_lines(rdir / n)) for n in DOCS if (rdir / n).is_file())
        stats.append(f"  {r}-*: {total} 行 / {len(DOCS)} 份")

    print(f"仓库根：{repo}")
    print(f"检查轮次：{', '.join(rounds)}")
    print("行数统计：")
    for s in stats:
        print(s)

    if all_problems:
        print(f"\n发现 {len(all_problems)} 个问题：")
        for p in all_problems:
            print(f"  - {p}")
        print("\n按上面的行号逐条修；不要改脚本绕过。")
        return 1

    print("\n全部通过：轮次齐全、节数达标、每节有引用、参考清单与本地行号引用都对得上。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
