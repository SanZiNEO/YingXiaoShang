from __future__ import annotations

from ..models import (
    SourceCapabilities,
    SourceDescriptor,
    SourcePolicy,
)

# 未接入（2026-11-18）：站点是 Vue SPA，www.tianxiawangshang.com 所有路由都返回同一
# 壳页面（约 4.1 KB，无 SSR 列表/正文），唯一数据源是 media.tianxiawangshang.com 的
# /iwshang/api/product/content/list 与 content/detail 接口；但该接口响应头
# `Content‑Security‑Policy` 的头部名称/取值里夹带了 U+2011（non-breaking hyphen），
# 内置 httpx/h11 严格校验响应头时直接抛 RemoteProtocolError，抓取层无法读取 JSON。
# stdlib http.client 可正常取到数据，待抓取层放宽响应头校验或允许适配器回退 stdlib
# 读取后再接入；接口字段：contentId/title/intro/author/releaseTime/createTime，
# 详情页路由 /articledetail/<contentId>，详情接口 content/detail?contentId=。
DESCRIPTOR = SourceDescriptor(
    id="iwangshang",
    name="天下网商",
    group="ecommerce",
    homepage="https://www.tianxiawangshang.com/",
    adapter="json-list",
    entry="https://media.tianxiawangshang.com/iwshang/api/product/content/list",
    pagination="none",
    capabilities=SourceCapabilities(
        requires_browser=True,
        content_mode="full",
        supports_pagination=False,
    ),
    policy=SourcePolicy(
        interval_s=15 * 60,
        detail_concurrency=1,
        min_interval_ms=1_000,
        timeout_s=30.0,
        retries=1,
        max_items=50,
        max_pages=1,
    ),
    enabled=False,
    note=(
        "2026-11-18 未接入：Vue SPA 无 SSR；API 响应头含 U+2011 非法字符，httpx/h11 "
        "抛 RemoteProtocolError，抓取层取不到 JSON，待抓取层放宽响应头校验后再接。"
    ),
)
