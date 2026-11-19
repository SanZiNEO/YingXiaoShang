# 58 新浪财经

> 入口：https://finance.sina.com.cn/
> 摸底时间：2026-11-18
> 摸底方式：veddata（真实浏览器 + 网络捕获）
> 状态：**可接入**（转载需标注原始来源）

## 一、这是什么站

- **定位**：综合财经门户，行情、财经新闻、基金、ESG、专栏
- **主体**：新浪
- **商科相关**：**中**（财经新闻多，但原创少）
- **内容形态**：转载新闻 + 行情 + 专栏 + 直播
- **更新频率**：极高频

## 二、页面与技术形态

- **框架**：传统门户 SSR
- **渲染**：**16,449 字符、1,534 链接**（这批源里页面最大）
- **风控**：无验证码
- **登录**：无强制

## 三、数据源清单

| # | 类型 | 请求 / 位置 | 触发 | 返回 | 备注 |
|---|---|---|---|---|---|
| 1 | 页面列表 | 首页 HTML | page_load | 16,449 字符 / 1,534 链接 | 财经/股票/基金/期货/外汇/ESG |
| 2 | 基金推广 | `GET /tgdata/fund_tg_api.json` | page_load | 37 字段 | 推广位，非新闻 |
| 3 | 选股匹配 | `POST https://gk.sina.cn/v1/gkmatch` | page_load，7 次 | 18 字段 | 广告/推荐 |
| 4 | 股票 MACD | `GET https://statistic.cj.sina.com.cn/api/macd/stocks_by_rule` | page_load | 168 字段 | 技术指标数据 |
| 5 | 行情弹窗 | `GET /api/hq_popup_api.json` | page_load | 14 字段 | 行情 |
| 6 | 行情推送 | `wss://hq.sinajs.cn/wskt` | 连接 | 0 字段 | WebSocket 实时行情 |
| 7 | 内容列表接口 | **无** | — | — | 新闻全在 HTML |

## 四、探索记录

1. 打开首页：1534 链接，导航极全（股票/港股/美股/基金/期货/外汇/黄金/债券/银行/保险/ESG）。
2. 抓到的接口全是行情/推广/统计，**没有内容列表接口**。
3. 首页字符量 16,449，说明转载稿全文直出。

## 五、结论：怎么抓最省事

- **建议**：**可接**。理由：2026-11-18 用户决策 B 档并入；转载为主，入库必须写 media_name 原始来源，靠 tag 匹配过滤。
- **替代**：直接用原始媒体（第一财经/21 世纪/每经）。
- **若只做热度信号**：`statistic.cj.sina.com.cn` 的 MACD 数据可用于行情，而非内容。

## 六、待确认 / 风险

| 项 | 说明 |
|---|---|
| 原创比例 | 低 |
| 转载来源 | 复杂，版权不可控 |
| 页面体积 | 16K 字符，抓取代价高 |

## 八、列表接口 + 文章级验证（2026-11-18）

- 首页 16,018 字符 / 1,535 链接，静态门户；`a[href*="doc-"]` 匹配不到
- 找到滚动列表接口：
  `GET https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&num=20&page=1`
- 返回 `result.data[]`：`total=100145`，字段含 `url` / `wapurl` / `title` / `intro` / `author` / `media_name` / `ctime`
- 样本文章：
  `https://finance.sina.com.cn/stock/hkstock/marketalerts/2026-11-18/doc-inizcmfm7091090.shtml`
- 整页正文 3,338 字符 / 339 链接；2026-11-18 11:33，来源新浪港股
- 付费墙/登录：无
- **结论：列表优先走 roll API（一次 20 条、总量 10 万+），详情页可抓**

## 九、veddata 复测（2026-11-18 12:18）

- **列表接口**：`GET https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&num=20&page=1`
- **返回**：`total=100153`，一次 20 条；字段 `url` / `title` / `intro` / `author` / `media_name` / `ctime`
- **样本**：`https://finance.sina.com.cn/stock/hkstock/marketalerts/2026-11-18/doc-inizcmfm7091090.shtml`
- **正文**：整页 3,601 字符 / 340 链接；标题、时间、来源“新浪港股”齐全
- **结论**：可接入，列表走 roll API，详情抓正文容器；转载必须带 `media_name`