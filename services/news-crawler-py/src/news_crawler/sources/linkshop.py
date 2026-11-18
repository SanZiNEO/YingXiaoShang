from __future__ import annotations

from ..models import SourceCapabilities, SourceDescriptor, SourcePolicy

DESCRIPTOR = SourceDescriptor(
    id="linkshop",
    name="联商网",
    group="ecommerce",
    homepage="https://www.linkshop.com/",
    adapter="html-list",
    entry="https://www.linkshop.com/",
    pagination="none",
    capabilities=SourceCapabilities(auth="none", content_mode="full"),
    # Disabled 2026-11-18: certificate chain does not validate from a server,
    # and the plan removed it from the pool. Kept here so the removal reason is
    # recorded in the registry instead of disappearing silently.
    enabled=False,
    note="证书不安全（TLS 校验失败），2026-11-18 从新闻源名单剔除",
    policy=SourcePolicy(
        interval_s=24 * 60 * 60,
        detail_concurrency=1,
        min_interval_ms=2_000,
        timeout_s=20.0,
        retries=0,
        max_items=0,
        max_pages=0,
    ),
)
