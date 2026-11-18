"""Manual probe: NBD detail sequential direct fetch."""

from __future__ import annotations

import asyncio
import re
import time

import httpx

BASE = "https://www.nbd.com.cn/"
LIST = f"{BASE}columns/3/"
HEADERS = {
    "user-agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "referer": LIST,
    "accept-language": "zh-CN,zh;q=0.9",
}


async def main() -> None:
    async with httpx.AsyncClient(headers=HEADERS, follow_redirects=True, timeout=30.0) as client:
        response = await client.get(LIST)
        links = sorted(set(re.findall(r"/articles/\d{4}-\d{2}-\d{2}/\d+\.html", response.text)))[
            -20:
        ]
        ok = 0
        errors = 0
        started = time.perf_counter()
        for link in links:
            try:
                detail = await client.get(f"{BASE}{link.lstrip('/')}")
                ok += int(detail.status_code == 200)
            except Exception:  # noqa: BLE001
                errors += 1
        print({"ok": ok, "errors": errors, "total": round(time.perf_counter() - started, 2)})


if __name__ == "__main__":
    asyncio.run(main())
