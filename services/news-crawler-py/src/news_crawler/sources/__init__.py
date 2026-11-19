"""Adapter auto-discovery.

Every module in this package is a self-contained source: it declares

    DESCRIPTOR = SourceDescriptor(...)   # registry metadata + per-source policy
    ADAPTER = SomeSource                 # NewsSource subclass

and nothing else. Discovery keeps one source in one file, so adding a source
never touches a shared registry file. Helper modules must start with `_` to be
skipped.
"""

from __future__ import annotations

import importlib
import pkgutil
import re
from pathlib import Path

from ..http import HttpClient
from ..models import SourceDescriptor
from .base import NewsSource

PACKAGE_DIR = Path(__file__).parent
SKIP_MODULES = frozenset({"base"})


def _module_names() -> list[str]:
    names = []
    for info in pkgutil.iter_modules([str(PACKAGE_DIR)]):
        if info.name in SKIP_MODULES or info.name.startswith("_"):
            continue
        names.append(info.name)
    return sorted(names)


def discover_adapters() -> dict[str, tuple[SourceDescriptor, type[NewsSource] | None]]:
    found: dict[str, tuple[SourceDescriptor, type[NewsSource] | None]] = {}
    for name in _module_names():
        module = importlib.import_module(f"{__name__}.{name}")
        descriptor = getattr(module, "DESCRIPTOR", None)
        adapter = getattr(module, "ADAPTER", None)
        if descriptor is None:
            raise ImportError(f"sources/{name}.py 必须定义 DESCRIPTOR（非源模块请以 `_` 前缀命名）")
        if adapter is None and descriptor.enabled:
            raise ImportError(f"sources/{name}.py 缺少 ADAPTER，但 source 处于启用状态")
        source_id = descriptor.id
        # news-ingest/v1 only allows [a-z0-9-]; Python module names cannot hold
        # a hyphen, so the convention is `sina-finance` in the registry and
        # `sina_finance.py` on disk. Keep the two in lockstep.
        if source_id.replace("-", "_") != name:
            raise ValueError(
                f"sourceId 与文件名不一致: sources/{name}.py 的 id 应为 "
                f"{name.replace('_', '-')}，实际是 {source_id}"
            )
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,31}", source_id):
            raise ValueError(f"sourceId 不合规（news-ingest/v1 只允许 a-z0-9-，2–32 位）: {source_id}")
        if source_id in found:
            raise ValueError(f"重复注册的 sourceId: {source_id}（见 sources/{name}.py）")
        found[source_id] = (descriptor, adapter)
    return found


_LOADED = discover_adapters()
DESCRIPTORS: dict[str, SourceDescriptor] = {key: value[0] for key, value in _LOADED.items()}
ADAPTERS: dict[str, type[NewsSource]] = {
    key: value[1] for key, value in _LOADED.items() if value[1] is not None
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
