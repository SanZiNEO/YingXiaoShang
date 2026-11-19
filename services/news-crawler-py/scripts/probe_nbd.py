"""Manual probe: can Python httpx fetch NBD list/detail without a browser?"""

from __future__ import annotations

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


def main() -> None:
    with httpx.Client(headers=HEADERS, follow_redirects=True, timeout=30.0) as client:
        started = time.perf_counter()
        response = client.get(LIST)
        elapsed = time.perf_counter() - started
        print(
            f"list status={response.status_code} elapsed={elapsed:.2f}s bytes={len(response.content)}"
        )
        links = sorted(set(re.findall(r"/articles/\d{4}-\d{2}-\d{2}/\d+\.html", response.text)))
        print(f"list article links={len(links)} first={links[:3]}")

        if not links:
            return

        url = f"{BASE}{links[0].lstrip('/')}"
        started = time.perf_counter()
        detail = client.get(url)
        elapsed = time.perf_counter() - started
        print(
            f"detail status={detail.status_code} elapsed={elapsed:.2f}s bytes={len(detail.content)} url={url}"
        )
        html = detail.text
        print("detail marker .g-articl-text=", "g-articl-text" in html)


if __name__ == "__main__":
    main()
