from __future__ import annotations

import asyncio
import sqlite3

from news_crawler.adhoc import _extract, ingest_url
from news_crawler.http import HttpClient

HTML = """
<html><head>
<title>测试文章标题</title>
<meta name="description" content="这是一段测试摘要，用于验证单篇 URL 导入。">
<meta property="article:published_time" content="2026-11-18T10:00:00+08:00">
</head><body>
<nav>导航内容</nav>
<article><h1>测试文章标题</h1>
<p>这是正文第一段，长度已经超过二十个字符，用来验证通用正文抽取。</p>
<p>这是正文第二段，继续补充足够的内容，确保 normalize 不会因为过短而拒绝。</p>
</article>
</body></html>
"""


def test_extract_generic_article() -> None:
    raw = _extract(HTML, "https://example.com/article")
    assert raw.title == "测试文章标题"
    assert "正文第一段" in raw.content
    assert "导航内容" not in raw.content
    assert raw.summary == "这是一段测试摘要，用于验证单篇 URL 导入。"
    assert raw.published_at.startswith("2026-11-18")


def test_ingest_url_writes_shared_db(tmp_path, monkeypatch) -> None:
    async def fake_get_text(self, source, url, *, headers=None):
        return HTML

    monkeypatch.setattr(HttpClient, "get_text", fake_get_text)
    db_path = tmp_path / "learning.db"
    article = asyncio.run(ingest_url("https://example.com/article", db_path))

    assert article.source == "manual"
    assert article.url == "https://example.com/article"
    with sqlite3.connect(db_path) as conn:
        row = conn.execute(
            "SELECT id, title, content FROM news_articles WHERE url=?", (article.url,)
        ).fetchone()
    assert row is not None
    assert row[1] == "测试文章标题"
    assert "正文第一段" in row[2]
