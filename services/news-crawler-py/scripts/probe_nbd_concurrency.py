"""Manual probe: NBD detail direct fetch under concurrency."""
from __future__ import annotations

import asyncio
import re
import time
from collections import Counter

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
        links = sorted(set(re.findall(r"/articles/\d{4}-\d{2}-\d{2}/\d+\.html", response.text)))
        urls = [f"{BASE}{link.lstrip('/')}" for link in links[-20:]]
        print(f"testing {len(urls)} details")

        for concurrency in (2, 8):
            semaphore = asyncio.Semaphore(concurrency)
            statuses: Counter[str] = Counter()
            durations: list[float] = []

            async def fetch(url: str) -> None:
                async with semaphore:
                    started = time.perf_counter()
                    try:
                        item = await client.get(url)
                        statuses[str(item.status_code)] += 1
                    except Exception as error:  # noqa: BLE001
                        statuses[type(error).__name__] += 1
                    durations.append(time.perf_counter() - started)

            started = time.perf_counter()
            await asyncio.gather(*(fetch(url) for url in urls))
            total = time.perf_counter() - started
            print(
                f"concurrency={concurrency} total={total:.2f}s "
                f"avg={sum(durations) / len(durations):.2f}s statuses={dict(statuses)}"
            )


if __name__ == "__main__":
    asyncio.run(main())
