"""36氪适配器（暂未接入）。

2026-11-18 实测：首页、频道页、历史快讯接口与 robots/sitemap 全部返回
`_waf_verification_proof` 指纹挑战壳（MD5 + canvas/WebGL/Worker 探针），
裸 HTTP 无法通过 WAF 取得文章列表；仅被边缘缓存的文章详情页可 SSR。
当前环境未安装 Playwright 浏览器，故先停用，待浏览器兜底可用后再接。
"""
from __future__ import annotations

from ..models import (
    RawArticle,
    RawListItem,
    RawPage,
    SourceCapabilities,
    SourceDescriptor,
    SourcePolicy,
)
from .base import NewsSource


class Kr36Source(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        raise RuntimeError("kr36 被 WAF 指纹挑战拦截，裸 HTTP 无列表可用（2026-11-18 实测）")

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        raise RuntimeError("kr36 被 WAF 指纹挑战拦截，裸 HTTP 无列表可用（2026-11-18 实测）")


DESCRIPTOR = SourceDescriptor(
    id="kr36",
    name="36氪",
    group="industry",
    homepage="https://36kr.com/",
    adapter="html-list",
    entry="https://36kr.com/",
    pagination="none",
    capabilities=SourceCapabilities(
        requires_browser=True,
        anti_crawler=True,
        content_mode="full",
        supports_pagination=False,
    ),
    policy=SourcePolicy(
        interval_s=10 * 60,
        detail_concurrency=1,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=0,
        max_items=60,
        max_pages=1,
    ),
    enabled=False,
    note="2026-11-18 实测：首页/频道页/历史快讯接口均返回阿里云 WAF 指纹挑战壳（_waf_verification_proof，canvas/WebGL/Worker 探针），裸 HTTP 拿不到文章列表；需真实浏览器环境，当前环境未装 Playwright，暂不接入。",
)
ADAPTER = Kr36Source
