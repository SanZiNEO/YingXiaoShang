from __future__ import annotations

from ..http import HttpClient
from ..models import SourceDescriptor
from .base import NewsSource
from .brandstar import BrandstarSource
from .eeo import EeoSource
from .jiemian import JiemianSource
from .latepost import LatepostSource
from .nbd import NbdSource
from .socialbeta import SocialBetaSource
from .stcn import StcnSource
from .yicai import YicaiSource

ADAPTERS: dict[str, type[NewsSource]] = {
    "socialbeta": SocialBetaSource,
    "yicai": YicaiSource,
    "jiemian": JiemianSource,
    "nbd": NbdSource,
    "brandstar": BrandstarSource,
    "latepost": LatepostSource,
    "eeo": EeoSource,
    "stcn": StcnSource,
}


def build_sources(
    http: HttpClient,
    descriptors: dict[str, SourceDescriptor],
) -> dict[str, NewsSource]:
    sources: dict[str, NewsSource] = {}
    for source_id, descriptor in descriptors.items():
        adapter = ADAPTERS.get(source_id)
        if adapter is None:
            raise KeyError(f"未实现适配器: {source_id}")
        sources[source_id] = adapter(http, descriptor)
    return sources
