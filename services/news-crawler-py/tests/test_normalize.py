from __future__ import annotations

import unittest

from news_crawler.models import RawArticle
from news_crawler.normalize import normalize
from news_crawler.registry import SOURCES


class NormalizeTests(unittest.TestCase):
    def test_full_article(self) -> None:
        raw = RawArticle(
            source_id="123",
            url="https://example.com/a?utm=x",
            title="标题",
            content="正" * 400,
            summary="摘要",
        )
        article, reason = normalize(SOURCES["socialbeta"], raw)
        self.assertEqual(reason, "")
        self.assertIsNotNone(article)
        assert article is not None
        self.assertEqual(article.ingest.content_mode, "full")
        self.assertEqual(article.ingest.url, "https://example.com/a")
        self.assertEqual(article.id, "socialbeta-123")

    def test_short_body_uses_summary(self) -> None:
        raw = RawArticle(
            source_id="1",
            url="https://example.com/a",
            title="标题",
            content="短",
            summary=(
                "这是一条足够长的短稿摘要，用来证明短稿也能作为消息入库；"
                "它不追求长文，但仍然包含可读的事实与结论，足够进入后续打标流程。"
            ),
        )
        article, _ = normalize(SOURCES["socialbeta"], raw)
        self.assertIsNotNone(article)
        assert article is not None
        self.assertEqual(article.ingest.content_mode, "summary")
        self.assertGreaterEqual(len(article.content), 40)

    def test_empty_article_rejected(self) -> None:
        raw = RawArticle(source_id="1", url="https://example.com/a", title="标题", content="")
        article, reason = normalize(SOURCES["socialbeta"], raw)
        self.assertIsNone(article)
        self.assertIn("too short", reason)


if __name__ == "__main__":
    unittest.main()
