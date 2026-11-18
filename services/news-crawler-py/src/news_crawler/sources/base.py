"""Adapter base class."""

from __future__ import annotations

from abc import ABC, abstractmethod

from bs4 import BeautifulSoup

from ..http import HttpClient
from ..models import RawArticle, RawListItem, RawPage, SourceDescriptor


class NewsSource(ABC):
    def __init__(self, http: HttpClient, descriptor: SourceDescriptor) -> None:
        self.http = http
        self.descriptor = descriptor

    @property
    def id(self) -> str:
        return self.descriptor.id

    @abstractmethod
    async def list_page(self, cursor: str | None) -> RawPage:
        raise NotImplementedError

    async def list_items(self) -> list[RawListItem]:
        page = await self.list_page(None)
        return page.items

    @abstractmethod
    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        raise NotImplementedError


def soup_of(html: str) -> BeautifulSoup:
    return BeautifulSoup(html, "lxml")
