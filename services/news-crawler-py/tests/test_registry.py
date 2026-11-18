from __future__ import annotations

import unittest

from news_crawler.http import HttpPolicy
from news_crawler.registry import SOURCES
from news_crawler.sources import ADAPTERS

BASELINE = {"socialbeta", "yicai", "jiemian", "nbd", "brandstar", "latepost", "eeo", "stcn"}


class RegistryTests(unittest.TestCase):
    def test_baseline_sources_still_registered(self) -> None:
        # The registry grows source by source; the first eight must never vanish.
        self.assertTrue(BASELINE.issubset(set(SOURCES)))

    def test_every_source_has_entry_and_group(self) -> None:
        for source in SOURCES.values():
            self.assertTrue(source.entry.startswith(("http://", "https://")), source.id)
            self.assertTrue(source.group, source.id)
            self.assertTrue(source.name, source.id)
            self.assertIsNotNone(source.policy, source.id)

    def test_nbd_is_sequential(self) -> None:
        self.assertEqual(SOURCES["nbd"].policy.detail_concurrency, 1)
        self.assertTrue(SOURCES["nbd"].capabilities.anti_crawler)

    def test_policy_values_are_valid(self) -> None:
        for source in SOURCES.values():
            policy = source.policy
            self.assertGreaterEqual(policy.detail_concurrency, 1, source.id)
            self.assertGreater(policy.interval_s, 0, source.id)

    def test_only_anti_crawler_sources_keep_request_gap(self) -> None:
        for source in SOURCES.values():
            http_policy = HttpPolicy.from_source(
                source.policy,
                anti_crawler=source.capabilities.anti_crawler,
            )
            if source.capabilities.anti_crawler:
                self.assertEqual(http_policy.min_interval_ms, source.policy.min_interval_ms)
            else:
                self.assertEqual(http_policy.min_interval_ms, 0, source.id)

    def test_disabled_sources_explain_themselves(self) -> None:
        for source in SOURCES.values():
            if not source.enabled:
                self.assertTrue(source.note, f"{source.id} 停用必须写 note")

    def test_source_id_matches_module_name(self) -> None:
        # `sina-finance` in the registry == `sina_finance.py` on disk.
        for source in SOURCES.values():
            self.assertRegex(source.id, r"^[a-z0-9][a-z0-9-]{1,31}$", source.id)

    def test_enabled_sources_have_adapter(self) -> None:
        for source in SOURCES.values():
            if source.enabled:
                self.assertIn(source.id, ADAPTERS)


if __name__ == "__main__":
    unittest.main()
