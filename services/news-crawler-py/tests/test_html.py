from __future__ import annotations

import unittest

from news_crawler.html import canonical_url, clean_text, html_to_text, normalize_date


class HtmlTests(unittest.TestCase):
    def test_clean_text_collapses_spaces(self) -> None:
        self.assertEqual(clean_text("  a \n\n\n b  "), "a\n\nb")

    def test_html_to_text_drops_script_and_keeps_paragraphs(self) -> None:
        html = "<p>第一段</p><script>bad()</script><p>第二段</p>"
        self.assertEqual(html_to_text(html), "第一段\n\n第二段")

    def test_canonical_url_keeps_business_query(self) -> None:
        self.assertEqual(
            canonical_url("https://www.latepost.com/news/dj_detail?id=3815&utm=x#top"),
            "https://www.latepost.com/news/dj_detail?id=3815",
        )

    def test_normalize_date(self) -> None:
        self.assertEqual(normalize_date("2026-11-18"), "2026-11-18T00:00:00+08:00")
        self.assertEqual(normalize_date("Wed, 18 Nov 2026 03:00:00 GMT"), "2026-11-18T11:00:00+08:00")


if __name__ == "__main__":
    unittest.main()
