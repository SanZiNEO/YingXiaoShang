"""Source registry.

The registry is *derived*, never hand-maintained: each adapter module under
`news_crawler.sources` owns its own `SourceDescriptor` (sourceId, entry, pagination,
capabilities, per-source policy). This module only exposes the merged view.
"""

from __future__ import annotations

from .models import SourceDescriptor
from .sources import DESCRIPTORS

SOURCES: dict[str, SourceDescriptor] = dict(DESCRIPTORS)
SOURCE_ORDER = tuple(sorted(SOURCES))


def enabled_sources() -> list[str]:
    return [source_id for source_id, source in SOURCES.items() if source.enabled]


def get_source(source_id: str) -> SourceDescriptor:
    try:
        return SOURCES[source_id]
    except KeyError as error:
        raise KeyError(f"未注册的新闻源: {source_id}") from error
