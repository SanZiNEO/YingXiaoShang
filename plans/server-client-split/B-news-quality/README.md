# B · 新闻正文质量抽检

## 要实现

- `quality_report.py`：只读新闻库，按来源统计正文质量。
- 统计每个来源：正文长度 P10/P50/P90、正文≈摘要比例、导航词命中率、`content_hash` 重复率、空标题/空日期比例。
- 每个来源给 3 条最差样本，正文截断 200 字。
- 每个来源给结论：保留 / 降级为只取标题摘要 / 下线。
- 输出 Markdown 报告 + JSON。
- 报告列出最差 5 个来源及证据。
- 同一数据库重复运行，统计结果一致。

## 产出

```text
services/news-crawler-py/scripts/quality_report.py
services/news-crawler-py/docs/news-source-quality.md
services/news-crawler-py/docs/quality-report.sample.json
```
