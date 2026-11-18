# 新闻采集 2 分钟动态槽位压测（去掉固定请求间隔后）

## 口径

- 日期：2026-11-18
- 命令：
  `uv run news-crawler bench --seconds 120 --workers 8 --unlimited --db .data/bench_nogate_2min_v2.db --output .data/bench_nogate_2min_v2.jsonl`
- 8 个源级 worker；46 个启用源排一轮队列；源完成后释放槽位，下一个源补位。
- 独立空库，避免热库去重压低 `inserted`；默认每源 policy，**未使用 `--fast`**。
- 单源候选不限制；普通源无固定每请求间隔，详情默认至少 4 并发；anti-crawler 源保留自身低并发/opt-in 间隔。
- 本轮已包含两处源级修复：`cifnews` 改移动端 UA 规避阿里云 WAF 405；`meihua` 详情并发从 4 降到 2。

## 总账

- 注册表启用源：46
- 拿到槽位并运行：46 / 46
- 状态：40 个 `success`，6 个 `partial_failure`（短稿/失效链接，不是源失败）
- 候选 fetch：5928
- 实际入库 inserted：3549
- updated：0
- skipped：1（同 URL 重复）
- 错误：13（短稿 9、404 失效链接 3、其他 1）
- 吞吐：**29.58 条/秒，1774 条/分钟**；候选 fetch 49.4 条/秒
- 对比改前基线（2 分钟 1022 条、8.52 条/秒、511 条/分钟）：入库量 **3.47 倍**，吞吐 **3.47 倍**

## 每源明细

| source | status | fetched | inserted | errors | duration_s | insert/s |
|---|---:|---:|---:|---:|---:|---:|
| accenture | success | 9 | 9 | 0 | 3.5 | 2.57 |
| admen | success | 100 | 100 | 0 | 14.1 | 7.09 |
| bain | success | 10 | 10 | 0 | 3.5 | 2.86 |
| brandcn | success | 25 | 25 | 0 | 17.3 | 1.45 |
| brandstar | success | 100 | 100 | 0 | 6.5 | 15.38 |
| cbndata | success | 100 | 100 | 0 | 25.2 | 3.97 |
| cca | success | 142 | 142 | 0 | 16.5 | 8.61 |
| ceibs | success | 10 | 10 | 0 | 2.5 | 4.00 |
| cenr | success | 69 | 69 | 0 | 21.9 | 3.15 |
| chinadaily-business | partial_failure | 36 | 35 | 1 | 8.8 | 3.98 |
| chinanews | success | 75 | 75 | 0 | 11.6 | 6.47 |
| chinatopbrands | success | 151 | 100 | 0 | 113.5 | 0.88 |
| cifnews | success | 24 | 24 | 0 | 9.2 | 2.61 |
| cls | partial_failure | 37 | 36 | 1 | 5.2 | 6.92 |
| digitaling | success | 10 | 10 | 0 | 2.1 | 4.76 |
| eastmoney | success | 60 | 60 | 0 | 13.5 | 4.44 |
| ebrun | success | 672 | 52 | 0 | 102.8 | 0.51 |
| eeo | success | 200 | 200 | 0 | 20.4 | 9.80 |
| foodinc | success | 50 | 50 | 0 | 28.2 | 1.77 |
| ifeng-finance | partial_failure | 96 | 92 | 4 | 13.6 | 6.76 |
| ipsos | success | 20 | 20 | 0 | 6.8 | 2.94 |
| iresearch | success | 9 | 9 | 0 | 1.0 | 9.00 |
| jiemian | success | 39 | 39 | 0 | 6.8 | 5.74 |
| jj21 | success | 99 | 99 | 0 | 4.4 | 22.50 |
| jwview | partial_failure | 314 | 308 | 6 | 35.8 | 8.60 |
| kantar | success | 6 | 6 | 0 | 8.9 | 0.67 |
| latepost | success | 2230 | 777 | 0 | 85.5 | 9.09 |
| mckinsey | success | 22 | 22 | 0 | 2.4 | 9.17 |
| meihua | success | 48 | 48 | 0 | 23.1 | 2.08 |
| mofcom | success | 15 | 15 | 0 | 1.3 | 11.54 |
| money163 | success | 234 | 234 | 0 | 39.8 | 5.88 |
| nbd | success | 279 | 38 | 0 | 78.1 | 0.49 |
| newrank | success | 5 | 5 | 0 | 3.0 | 1.67 |
| nielseniq | success | 26 | 26 | 0 | 9.9 | 2.63 |
| qq-finance | success | 15 | 15 | 0 | 9.7 | 1.55 |
| questmobile | success | 6 | 6 | 0 | 5.4 | 1.11 |
| sina-finance | success | 60 | 60 | 0 | 12.7 | 4.72 |
| socialbeta | success | 31 | 31 | 0 | 7.2 | 4.31 |
| stats | success | 18 | 18 | 0 | 12.3 | 1.46 |
| stcn | success | 50 | 50 | 0 | 31.3 | 1.60 |
| thepaper | success | 14 | 13 | 0 | 15.6 | 0.83 |
| tidesight | success | 29 | 29 | 0 | 8.7 | 3.33 |
| tmtpost | success | 56 | 56 | 0 | 5.8 | 9.66 |
| wscn | success | 8 | 8 | 0 | 1.2 | 6.67 |
| xinhua | partial_failure | 72 | 71 | 1 | 7.6 | 9.34 |
| yicai | success | 247 | 247 | 0 | 13.0 | 19.00 |

## 结论

- 去掉普通源的固定请求间隔后，8 个槽位能覆盖全部 46 个启用源，且 2 分钟吞吐从 8.52 条/秒提升到 **29.58 条/秒**。
- 绝大多数普通源从「每条约 1 秒」提升到「每源 4 路详情并发」：`admen` 105s → 14.1s，`cbndata` 105s → 25.2s，`cca` 120s 截断 → 16.5s。
- 长尾只剩真正有源级限制的站：`chinatopbrands`（WAF，串行 + 1s）113.5s、`ebrun`（anti，串行 + 1s）102.8s、`latepost`（RSS 列表 2230 条）85.5s、`nbd`（抗重置，串行 + 0.5s）78.1s。它们仍在 120s 内完成，不再把后续源饿死。
- 6 个 `partial_failure` 都是内容层问题：短稿被质量门槛拒绝、凤凰 3 条 404、少数空正文；没有源级抓取崩溃。
- `cifnews` 的 405 已确认不是并发，而是阿里云 WAF 对桌面 UA 的拦截；移动端 UA 下 24/24 成功。
- 3 秒查询门面复测：30 次调用 **0 次超过 3 秒**，p95 2767ms、max 2828ms；热库查询 40 条 p50/p95 均为 16ms。

原始数据：`services/news-crawler-py/.data/bench_nogate_2min_v2.db`、`services/news-crawler-py/.data/bench_nogate_2min_v2.jsonl`。
