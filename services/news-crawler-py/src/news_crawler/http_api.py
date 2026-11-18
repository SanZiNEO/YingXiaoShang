"""Stdlib-only HTTP control plane for :class:`~news_crawler.service.CrawlService`.

No third-party framework here: the server runs on :mod:`http.server` in a daemon
thread, and every request bridges into the service's asyncio loop through
``run_coroutine_threadsafe``. All responses are JSON and carry an ``elapsed``
millisecond counter.

Routes:

* ``GET  /health``  -- process status + per-source last run / running flag /
  next trigger time / cumulative inserted.
* ``GET  /stats?source=&limit=`` -- recent ``source_runs`` rows.
* ``POST /run``     -- body ``{"sources": [...], "wait": true}``; manually fire
  one round.
* ``GET  /query?q=&limit=`` -- lazy proxy to ``news_crawler.query.query_news``;
  the query module is optional, so a missing implementation returns 503 with an
  explicit reason instead of crashing the service.
"""

from __future__ import annotations

import asyncio
import importlib
import json
import threading
import time
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from . import db
from .service import CrawlService

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8787
COROUTINE_TIMEOUT_S = 60.0


class HttpControlPlane:
    """Owns the HTTP server thread and exposes it to the CLI / service."""

    def __init__(
        self,
        service: CrawlService,
        *,
        host: str = DEFAULT_HOST,
        port: int = DEFAULT_PORT,
    ) -> None:
        self.service = service
        self.host = host
        self.port = port
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        def handler_factory(*args: Any, **kwargs: Any) -> _Handler:
            return _Handler(self, *args, **kwargs)

        self._server = ThreadingHTTPServer((self.host, self.port), handler_factory)
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            name="crawler-http-control",
            daemon=True,
        )
        self._thread.start()

    def close(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        self._thread = None

    # ------------------------------------------------------------------ bridge

    def _run(self, coro: Any) -> Any:
        loop = self.service.loop
        if loop is None:
            raise RuntimeError("服务事件循环尚未启动")
        future = asyncio.run_coroutine_threadsafe(coro, loop)
        return future.result(timeout=COROUTINE_TIMEOUT_S)


class _Handler(BaseHTTPRequestHandler):
    server_version = "news-crawler-control/1.0"

    def __init__(self, plane: HttpControlPlane, *args: Any, **kwargs: Any) -> None:
        self.plane = plane
        super().__init__(*args, **kwargs)

    # Quiet the default noisy access log; stderr is still available via print.
    def log_message(self, format: str, *args: Any) -> None:
        return

    # ------------------------------------------------------------------ helpers

    def _send_json(self, payload: dict[str, Any], status: int, started: float) -> None:
        body = json.dumps(
            payload, ensure_ascii=False, default=str
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _elapsed(self, started: float) -> int:
        return int((time.perf_counter() - started) * 1000)

    def _query(self, key: str, default: str | None = None) -> str | None:
        parsed = urllib.parse.urlparse(self.path)
        values = urllib.parse.parse_qs(parsed.query).get(key)
        if not values:
            return default
        return values[0]

    # ------------------------------------------------------------------ routing

    def do_GET(self) -> None:
        started = time.perf_counter()
        parsed = urllib.parse.urlparse(self.path)
        try:
            if parsed.path == "/health":
                self._health(started)
            elif parsed.path == "/stats":
                self._stats(started)
            elif parsed.path == "/query":
                self._query_articles(started)
            else:
                self._send_json(
                    {"error": "not_found", "path": parsed.path}, 404, started
                )
        except Exception as error:  # noqa: BLE001 - control plane must not die
            self._send_json(
                {
                    "error": "internal",
                    "message": str(error),
                    "trace": traceback.format_exc(limit=3),
                    "elapsed_ms": self._elapsed(started),
                },
                500,
                started,
            )

    def do_POST(self) -> None:
        started = time.perf_counter()
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/run":
            self._send_json({"error": "not_found", "path": parsed.path}, 404, started)
            return
        try:
            self._run_round(started)
        except Exception as error:  # noqa: BLE001
            self._send_json(
                {
                    "error": "internal",
                    "message": str(error),
                    "trace": traceback.format_exc(limit=3),
                    "elapsed_ms": self._elapsed(started),
                },
                500,
                started,
            )

    # ------------------------------------------------------------------ handlers

    def _health(self, started: float) -> None:
        state = self.plane.service.state()
        payload: dict[str, Any] = {
            "ok": True,
            "host": self.plane.host,
            "port": self.plane.port,
            **state,
            "elapsed_ms": self._elapsed(started),
        }
        self._send_json(payload, 200, started)

    def _stats(self, started: float) -> None:
        source = self._query("source")
        limit_raw = self._query("limit", "50")
        try:
            limit = max(1, min(500, int(limit_raw)))
        except ValueError:
            self._send_json(
                {"error": "bad_request", "message": "limit 必须是整数"}, 400, started
            )
            return
        conn = self.plane.service.db
        if conn is None:
            self._send_json(
                {"ok": False, "error": "no_database", "message": "服务未配置数据库"},
                503,
                started,
            )
            return
        rows = db.recent_runs(conn, source=source, limit=limit)
        for row in rows:
            row["failures"] = json.loads(row["failures"] or "[]")
        self._send_json(
            {"ok": True, "source": source, "limit": limit, "runs": rows,
             "elapsed_ms": self._elapsed(started)},
            200,
            started,
        )

    def _run_round(self, started: float) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        body: dict[str, Any] = {}
        if length:
            raw = self.rfile.read(length)
            try:
                body = json.loads(raw.decode("utf-8")) if raw.strip() else {}
            except ValueError:
                self._send_json(
                    {"error": "bad_request", "message": "请求体不是合法 JSON"},
                    400,
                    started,
                )
                return
        sources = body.get("sources")
        wait = bool(body.get("wait", True))
        try:
            results = self.plane._run(
                self.plane.service.run_round(sources, trigger="manual", wait=wait)
            )
        except KeyError as error:
            self._send_json(
                {"error": "unknown_source", "message": str(error)}, 400, started
            )
            return
        if wait:
            summary = [self.plane.service._result_summary(result) for result in results]
        else:
            summary = []
        self._send_json(
            {"ok": True, "wait": wait, "rounds": summary,
             "accepted": sources or list(self.plane.service.source_ids),
             "elapsed_ms": self._elapsed(started)},
            200,
            started,
        )

    def _query_articles(self, started: float) -> None:
        query = self._query("q", "") or ""
        limit_raw = self._query("limit", "40")
        fresh_raw = (self._query("fresh", "true") or "true").strip().lower()
        fresh = fresh_raw not in ("0", "false", "no", "off")
        try:
            limit = max(1, min(100, int(limit_raw)))
        except ValueError:
            self._send_json(
                {"error": "bad_request", "message": "limit 必须是整数"}, 400, started
            )
            return
        try:
            module = importlib.import_module("news_crawler.query")
            query_news_sync = module.query_news_sync
        except (ImportError, AttributeError) as error:
            self._send_json(
                {
                    "ok": False,
                    "error": "query_unavailable",
                    "message": "查询模块 news_crawler.query 未安装",
                    "reason": str(error),
                },
                503,
                started,
            )
            return
        # The control plane runs in a worker thread; use the facade's sync
        # wrapper (its own short-lived loop) instead of bridging into the
        # service event loop.
        result = query_news_sync(
            query=query,
            limit=limit,
            fresh=fresh,
            db_path=self.plane.service.db_path,
        )
        payload = result.to_dict() if hasattr(result, "to_dict") else {"items": [], "meta": {}}
        self._send_json(
            {"ok": True, "q": query, "limit": limit, "fresh": fresh, **payload,
             "elapsed_ms": self._elapsed(started)},
            200,
            started,
        )
