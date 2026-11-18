"""Probe the list-page layer without fetching article details."""
from __future__ import annotations

import asyncio
import sys

from news_crawler.http import HttpClient, HttpPolicy
from news_crawler.registry import SOURCES
from news_crawler.sources import build_sources


async def main() -> None:
    descriptors = {source_id: descriptor for source_id, descriptor in SOURCES.items()}
    policies = {
        source_id: HttpPolicy.from_source(descriptor.policy)
        for source_id, descriptor in descriptors.items()
    }
    http = HttpClient(policies)
    sources = build_sources(http, descriptors)
    try:
        for source_id in sys.argv[1:] or list(descriptors):
            source = sources[source_id]
            first = await source.list_page(None)
            print(f"\n{source_id}: first={len(first.items)} next={first.next_cursor}")
            if first.items:
                print("  ", first.items[0].title[:50], first.items[0].url)
            if first.next_cursor:
                second = await source.list_page(first.next_cursor)
                print(f"  page2={len(second.items)} next={second.next_cursor}")
                if second.items:
                    print("  ", second.items[0].title[:50], second.items[0].url)
    finally:
        await http.close()


if __name__ == "__main__":
    asyncio.run(main())
