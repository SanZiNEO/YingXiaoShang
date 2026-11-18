from __future__ import annotations

import unittest

from news_crawler.registry import SOURCES


class RegistryTests(unittest.TestCase):
    def test_all_sources_registered(self) -> None:
        self.assertEqual(
            set(SOURCES),
            {"socialbeta", "yicai", "jiemian", "nbd", "brandstar", "latepost", "eeo", "stcn"},
        )

    def test_nbd_is_sequential(self) -> None:
        self.assertEqual(SOURCES["nbd"].policy.detail_concurrency, 1)
        self.assertTrue(SOURCES["nbd"].capabilities.anti_crawler)

    def test_every_source_has_entry_and_group(self) -> None:
        for source in SOURCES.values():
            self.assertTrue(source.entry.startswith("https://"))
            self.assertTrue(source.group)
            self.assertIsNotNone(source.policy)


if __name__ == "__main__":
    unittest.main()
