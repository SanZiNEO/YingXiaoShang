"""Async HTTP client with per-source gates and optional Playwright fallback."""

from __future__ import annotations

import asyncio
import random
import time
from dataclasses import dataclass
from typing import Any

import httpx

from .models import SourcePolicy

DEFAULT_HEADERS = {
    "user-agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "accept-language": "zh-CN,zh;q=0.9",
}

CHALLENGE_MARKERS = (
    "cf-chl",
    "challenge-platform",
    "just a moment...",
    "attention required!",
    "verify-container",
    "访问验证",
    "安全验证",
    "人机验证",
    "请完成验证",
    # Aliyun WAF (adquan, 36kr, ...): a JS-solved challenge shell that carries
    # `renderData` with `arg1=...`. Without this marker the page came back as an
    # article with zero characters, which looks like "no update" instead of
    # "blocked".
    "aliyun_waf",
    "aliyun-captcha",
)


class FetchError(RuntimeError):
    """A source request failed after direct retries (and optional browser fallback)."""


@dataclass(slots=True)
class HttpPolicy:
    min_interval_ms: int
    timeout_s: float
    retries: int

    @classmethod
    def from_source(cls, policy: SourcePolicy) -> HttpPolicy:
        return cls(
            min_interval_ms=policy.min_interval_ms,
            timeout_s=policy.timeout_s,
            retries=policy.retries,
        )


class _RateLimiter:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._last_start = 0.0

    async def wait(self, interval_ms: int) -> None:
        async with self._lock:
            delay = self._last_start + interval_ms / 1000 - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)
            self._last_start = time.monotonic()


def looks_challenged(text: str) -> bool:
    sample = text[:6_000].lower()
    return any(marker in sample for marker in CHALLENGE_MARKERS)


class BrowserFetcher:
    """Lazy Playwright fallback. Imported only when `--browser` is enabled."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._playwright: Any = None
        self._browser: Any = None

    async def _ensure_browser(self) -> Any:
        async with self._lock:
            if self._browser is not None:
                return self._browser
            try:
                from playwright.async_api import async_playwright
            except ImportError as error:
                raise FetchError(
                    "Playwright Python 未安装；执行 `uv sync --extra browser` 后重试"
                ) from error
            self._playwright = await async_playwright().start()
            self._browser = await self._playwright.chromium.launch(headless=True)
            return self._browser

    async def fetch_text(self, url: str, timeout_s: float) -> str:
        browser = await self._ensure_browser()
        page = await browser.new_page()
        try:
            response = await page.goto(
                url, wait_until="domcontentloaded", timeout=int(timeout_s * 1000)
            )
            if response is None:
                raise FetchError("Playwright 没有收到响应")
            if not response.ok:
                raise FetchError(f"Playwright HTTP {response.status}")
            text = await page.content()
            if looks_challenged(text):
                raise FetchError("Playwright 仍然命中验证页")
            return text
        finally:
            await page.close()

    async def close(self) -> None:
        if self._browser is not None:
            await self._browser.close()
        if self._playwright is not None:
            await self._playwright.stop()


class HttpClient:
    def __init__(
        self,
        policies: dict[str, HttpPolicy],
        *,
        browser_fallback: bool = False,
    ) -> None:
        self._policies = policies
        self._limiters = {source: _RateLimiter() for source in policies}
        self._browser = BrowserFetcher() if browser_fallback else None
        self._client = httpx.AsyncClient(
            headers=DEFAULT_HEADERS,
            follow_redirects=True,
            timeout=httpx.Timeout(60.0, connect=15.0),
            limits=httpx.Limits(max_connections=32, max_keepalive_connections=16),
        )

    def policy(self, source: str) -> HttpPolicy:
        return self._policies.get(
            source,
            HttpPolicy(min_interval_ms=1_000, timeout_s=30.0, retries=0),
        )

    async def close(self) -> None:
        await self._client.aclose()
        if self._browser is not None:
            await self._browser.close()

    async def _fetch_once(
        self,
        source: str,
        url: str,
        *,
        method: str,
        headers: dict[str, str] | None,
        content: bytes | None,
        json: Any | None,
    ) -> str:
        policy = self.policy(source)
        await self._limiters[source].wait(policy.min_interval_ms)
        response = await self._client.request(
            method,
            url,
            headers=headers,
            content=content,
            json=json,
            timeout=policy.timeout_s,
        )
        response.raise_for_status()
        text = response.text
        if looks_challenged(text):
            raise FetchError("challenge page detected")
        return text

    async def get_text(
        self,
        source: str,
        url: str,
        *,
        headers: dict[str, str] | None = None,
    ) -> str:
        policy = self.policy(source)
        last_error: Exception | None = None
        for attempt in range(policy.retries + 1):
            try:
                return await self._fetch_once(
                    source,
                    url,
                    method="GET",
                    headers=headers,
                    content=None,
                    json=None,
                )
            except (httpx.HTTPError, FetchError) as error:
                last_error = error
                if attempt < policy.retries:
                    await asyncio.sleep(0.25 + random.random() * 0.25)
        if self._browser is not None:
            try:
                return await self._browser.fetch_text(url, policy.timeout_s)
            except Exception as error:  # noqa: BLE001 - keep source failure local
                last_error = error
        raise FetchError(f"{url} 直连和浏览器兜底都失败: {last_error}") from last_error

    async def post_json(
        self,
        source: str,
        url: str,
        payload: Any,
        *,
        headers: dict[str, str] | None = None,
    ) -> str:
        policy = self.policy(source)
        last_error: Exception | None = None
        for attempt in range(policy.retries + 1):
            try:
                return await self._fetch_once(
                    source,
                    url,
                    method="POST",
                    headers=headers,
                    content=None,
                    json=payload,
                )
            except (httpx.HTTPError, FetchError) as error:
                last_error = error
                if attempt < policy.retries:
                    await asyncio.sleep(0.25 + random.random() * 0.25)
        raise FetchError(f"{url} POST 失败: {last_error}") from last_error

    async def get_json(
        self,
        source: str,
        url: str,
        *,
        headers: dict[str, str] | None = None,
    ) -> Any:
        text = await self.get_text(source, url, headers=headers)
        try:
            import json

            return json.loads(text)
        except ValueError as error:
            raise FetchError(f"{url} 返回不是 JSON: {text[:80]}") from error
