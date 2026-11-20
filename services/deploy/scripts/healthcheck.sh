#!/usr/bin/env python3
"""Container health probe for the news-crawler control plane.

Invoked by compose HEALTHCHECK as `python /app/scripts/healthcheck.sh`.
Python 3 standard library only: no curl/wget, no log files, no file writes.
Exit 0 = HTTP 200 and JSON top-level ``ok == true``; exit 1 on every other
condition (connection refused / timeout / non-200 / non-JSON / ok != true).
"""

import json
import os
import sys
import urllib.request

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8787
TIMEOUT_S = 5
UNSPECIFIED_HOSTS = {"0.0.0.0", "::", "::0", "0:0:0:0:0:0:0:0"}


def _probe_target() -> str:
    host = (os.environ.get("NEWS_CRAWLER_HOST") or "").strip()
    if not host or host in UNSPECIFIED_HOSTS:
        # 0.0.0.0 / :: are listen-all addresses and cannot be requested
        # directly, so probe the loopback interface instead.
        host = DEFAULT_HOST
    port_raw = (os.environ.get("NEWS_CRAWLER_PORT") or "").strip()
    try:
        port = int(port_raw) if port_raw else DEFAULT_PORT
    except ValueError:
        port = DEFAULT_PORT
    return "http://{}:{}/health".format(host, port)


def main() -> int:
    url = _probe_target()
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT_S) as resp:
            if getattr(resp, "status", None) != 200:
                print("unhealthy")
                print("healthcheck: non-200 status from {}".format(url), file=sys.stderr)
                return 1
            body = resp.read().decode("utf-8")
        payload = json.loads(body)
    except Exception as error:  # any probe failure counts as unhealthy
        print("unhealthy")
        print("healthcheck: probe failed: {}".format(error), file=sys.stderr)
        return 1

    if payload.get("ok") is not True:
        print("unhealthy")
        print("healthcheck: response ok is not true", file=sys.stderr)
        return 1

    source_count = payload.get("source_count")
    if not isinstance(source_count, int):
        source_count = 0
    print("healthy source_count={}".format(source_count))
    return 0


if __name__ == "__main__":
    sys.exit(main())