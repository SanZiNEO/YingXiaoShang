#!/usr/bin/env python3
"""检查 docs/ 里「文件:行号」引用是否还对得上仓库现状。

需求文档写「代码在 xxx.ts:123」，代码一动这行引用就失效。人眼查不过来，
但机器能查。本脚本只查活跃文档（跳过 90-archive，归档本就该指向旧代码）。

判据三条：
  1. 文件存在——文档写的路径必须能在仓库里找到
  2. 行号在范围内——不能引用一个 36 行文件里的第 40 行
  3. 路径完整——`tools/index.ts` 这种半截路径要能唯一解析到一个文件；
     同名文件多了算歧义，也报出来

跑法：
    python tools/verify-doc-refs.py            # 只检查，有错退出码 1
    python tools/verify-doc-refs.py --fix-hint # 额外打印每处的上下文

依赖：只用标准库；但需要仓库是 git 工作区（用 git ls-files 取文件清单，
这样自动跳过 node_modules 和构建产物）。
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

# Windows 控制台默认 GBK，中文会花屏；统一按 UTF-8 输出。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# 文档里出现、但不是仓库文件的字符串。加一条要写清原因。
SKIP_PATTERNS = (
    # 运行时数据文件（用户在 %APPDATA% 下自己建），不是仓库文件
    re.compile(r"^/settings\.json$"),
    re.compile(r"^settings\.json$"),
    # R20 特意记录的一条构建工具残留，正文说明它被 .gitignore 覆盖
    re.compile(r"electron\.vite\.config\.\d+\.mjs$"),
)

# 只认「带斜杠、带代码后缀」的引用，避免把普通的「App.ts」这种口语说法算进来
REF = re.compile(
    r"([A-Za-z0-9_@./\-]*/[A-Za-z0-9_@./\-]+\.(?:tsx|ts|mjs|json|yml|py))"
    r"(?::(\d+)(?:-(\d+))?)?"
)


def repo_files(root: Path) -> list[str]:
    out = subprocess.run(
        ["git", "-C", str(root), "ls-files"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    return out.stdout.split()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fix-hint", action="store_true", help="打印每处引用的上下文行")
    ap.add_argument("--root", default=".", help="仓库根目录（默认当前目录）")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    files = repo_files(root)
    fileset = set(files)
    by_name: dict[str, list[str]] = {}
    for f in files:
        by_name.setdefault(Path(f).name, []).append(f)

    docs = [
        f
        for f in files
        if f.startswith("docs/") and f.endswith(".md") and "90-archive" not in f
    ]

    line_cache: dict[str, list[str]] = {}

    def source_lines(f: str) -> list[str]:
        if f not in line_cache:
            line_cache[f] = (root / f).read_text(encoding="utf-8", errors="replace").splitlines()
        return line_cache[f]

    checked = skipped = 0
    missing: list[tuple[str, int, str]] = []
    ambiguous: list[tuple[str, int, str, list[str]]] = []
    overflow: list[tuple[str, int, str, int, int]] = []

    for doc in docs:
        text = (root / doc).read_text(encoding="utf-8", errors="replace")
        for lineno, line in enumerate(text.splitlines(), 1):
            for m in REF.finditer(line):
                ref, start, end = m.group(1), m.group(2), m.group(3)
                if any(p.search(ref) for p in SKIP_PATTERNS):
                    skipped += 1
                    continue
                # 文档里的路径可能相对仓库根，也可能相对 docs/
                target = None
                for prefix in ("", "docs/"):
                    candidate = (prefix + ref).replace("//", "/")
                    if candidate in fileset:
                        target = candidate
                        break
                if target is None:
                    hits = by_name.get(Path(ref).name, [])
                    if len(hits) == 1:
                        target = hits[0]
                    elif len(hits) > 1:
                        ambiguous.append((doc, lineno, ref, hits))
                        continue
                if target is None:
                    missing.append((doc, lineno, ref))
                    continue
                if not start:
                    checked += 1
                    continue
                n = len(source_lines(target))
                hi = int(end or start)
                if hi > n or int(start) < 1:
                    overflow.append((doc, lineno, f"{target}:{start}-{end or start}", hi, n))
                    continue
                checked += 1

    def where(doc: str, lineno: int) -> str:
        if not args.fix_hint:
            return ""
        line = (root / doc).read_text(encoding="utf-8", errors="replace").splitlines()[lineno - 1]
        return f"\n        上下文：{line.strip()[:120]}"

    print(f"活跃文档 {len(docs)} 份，核对引用 {checked} 条（跳过 {skipped} 条）")

    if overflow:
        print(f"\n行号越界 {len(overflow)} 处：")
        for doc, lineno, ref, hi, n in overflow:
            print(f"  {doc}:{lineno} → {ref}，但该文件只有 {n} 行{where(doc, lineno)}")

    if missing:
        print(f"\n指向不存在的文件 {len(missing)} 处：")
        for doc, lineno, ref in missing:
            print(f"  {doc}:{lineno} → {ref}{where(doc, lineno)}")

    if ambiguous:
        print(f"\n路径不完整、匹配到多个文件 {len(ambiguous)} 处：")
        for doc, lineno, ref, hits in ambiguous:
            print(f"  {doc}:{lineno} → {ref}（候选：{'、'.join(hits[:3])}）{where(doc, lineno)}")

    bad = len(overflow) + len(missing) + len(ambiguous)
    if bad:
        print(f"\n共 {bad} 处需要修。")
        return 1
    print("\n全部对得上。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
