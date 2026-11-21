# F · 压测 + 可观测性

## 要实现

- `tools/loadtest`：模拟 40–60 个学生，登录 → 提问 → 出题 → 交卷。
- 模型可切 mock / 真实；默认 mock。
- 输出 P50/P95/P99、首 token 延迟、错误率、`SQLITE_BUSY` 次数。
- 按学生统计 token 消耗和聊天轮次。
- 报告能回答“某学生今天用了多少 token、问了几轮”。
- Prometheus 告警规则：5xx 错误率、P95、token 80%、`SQLITE_BUSY` 增速。
- 压测报告 Markdown + JSON。

## 产出

```text
tools/loadtest/
  src/cli.ts
  src/scenarios/login.ts
  src/scenarios/ask.ts
  src/scenarios/questions.ts
  src/scenarios/submit.ts
  src/metrics/scrape.ts
  src/metrics/summarize.ts
  src/report.ts
  config/loadtest.example.json
  alerts.yml
  README.md
```
