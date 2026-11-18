"""Declarative source registry for the Python crawler."""
from __future__ import annotations

from .models import SourceCapabilities, SourceDescriptor, SourcePolicy

SOURCES: dict[str, SourceDescriptor] = {
    "socialbeta": SourceDescriptor(
        id="socialbeta",
        name="SocialBeta",
        group="case",
        homepage="https://socialbeta.com/",
        adapter="html-list",
        entry="https://socialbeta.com/campaign",
        pagination="none",
        capabilities=SourceCapabilities(content_mode="full", supports_pagination=False),
        policy=SourcePolicy(
            interval_s=30 * 60,
            detail_concurrency=2,
            min_interval_ms=1_000,
            timeout_s=30.0,
            retries=1,
            max_items=60,
            max_pages=1,
        ),
    ),
    "yicai": SourceDescriptor(
        id="yicai",
        name="第一财经",
        group="finance",
        homepage="https://www.yicai.com/",
        adapter="html-list",
        entry="https://www.yicai.com/news/",
        pagination="page",
        capabilities=SourceCapabilities(content_mode="full", supports_pagination=True),
        policy=SourcePolicy(
            interval_s=10 * 60,
            detail_concurrency=2,
            min_interval_ms=1_000,
            timeout_s=30.0,
            retries=1,
            max_items=200,
            max_pages=10,
        ),
    ),
    "jiemian": SourceDescriptor(
        id="jiemian",
        name="界面新闻",
        group="company",
        homepage="https://www.jiemian.com/",
        adapter="html-list",
        entry="https://www.jiemian.com/lists/2.html",
        pagination="none",
        capabilities=SourceCapabilities(content_mode="full", supports_pagination=False),
        policy=SourcePolicy(
            interval_s=30 * 60,
            detail_concurrency=2,
            min_interval_ms=1_000,
            timeout_s=30.0,
            retries=1,
            max_items=60,
            max_pages=1,
        ),
    ),
    "nbd": SourceDescriptor(
        id="nbd",
        name="每日经济新闻",
        group="finance",
        homepage="https://www.nbd.com.cn/",
        adapter="html-list",
        entry="https://www.nbd.com.cn/columns/3/",
        pagination="page",
        capabilities=SourceCapabilities(
            requires_browser=False,
            anti_crawler=True,
            content_mode="full",
            supports_pagination=True,
        ),
        policy=SourcePolicy(
            interval_s=10 * 60,
            detail_concurrency=1,
            min_interval_ms=500,
            timeout_s=30.0,
            retries=0,
            max_items=100,
            max_pages=5,
        ),
    ),
    "brandstar": SourceDescriptor(
        id="brandstar",
        name="品牌星球",
        group="case",
        homepage="https://www.brandstar.com.cn/",
        adapter="rss",
        entry="https://www.brandstar.com.cn/feed/",
        pagination="page",
        capabilities=SourceCapabilities(content_mode="full", supports_pagination=True),
        policy=SourcePolicy(
            interval_s=30 * 60,
            detail_concurrency=1,
            min_interval_ms=1_000,
            timeout_s=30.0,
            retries=1,
            max_items=500,
            max_pages=10,
        ),
    ),
    "latepost": SourceDescriptor(
        id="latepost",
        name="晚点 LatePost",
        group="industry",
        homepage="https://www.latepost.com/",
        adapter="json-list",
        entry="https://www.latepost.com/site/index",
        pagination="none",
        capabilities=SourceCapabilities(content_mode="full", supports_pagination=False),
        policy=SourcePolicy(
            interval_s=30 * 60,
            detail_concurrency=2,
            min_interval_ms=1_000,
            timeout_s=30.0,
            retries=1,
            max_items=200,
            max_pages=1,
        ),
    ),
    "eeo": SourceDescriptor(
        id="eeo",
        name="经济观察报",
        group="finance",
        homepage="https://www.eeo.com.cn/",
        adapter="json-list",
        entry=(
            "https://app.eeo.com.cn/?app=article&controller=index"
            "&action=getMoreArticle&catid=3690&pageSize=20"
        ),
        pagination="page",
        capabilities=SourceCapabilities(content_mode="full", supports_pagination=True),
        policy=SourcePolicy(
            interval_s=15 * 60,
            detail_concurrency=2,
            min_interval_ms=1_000,
            timeout_s=30.0,
            retries=1,
            max_items=300,
            max_pages=10,
        ),
    ),
    "stcn": SourceDescriptor(
        id="stcn",
        name="证券时报",
        group="finance",
        homepage="https://www.stcn.com/",
        adapter="json-list",
        entry="https://www.stcn.com/article/list.html?type=xw&page_time=1",
        pagination="cursor",
        capabilities=SourceCapabilities(
            anti_crawler=True,
            content_mode="full",
            supports_pagination=True,
        ),
        policy=SourcePolicy(
            interval_s=10 * 60,
            detail_concurrency=2,
            min_interval_ms=500,
            timeout_s=30.0,
            retries=2,
            max_items=100,
            max_pages=5,
        ),
    ),
}

SOURCE_ORDER = tuple(SOURCES)


def get_source(source_id: str) -> SourceDescriptor:
    try:
        return SOURCES[source_id]
    except KeyError as error:
        raise KeyError(f"未注册的新闻源: {source_id}") from error
