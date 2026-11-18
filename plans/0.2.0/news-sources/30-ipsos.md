# 30 益普索 Ipsos

> 入口：https://www.ipsos.com/zh-cn
> 摸底时间：2026-11-18
> 摸底方式：veddata（真实浏览器 + 网络捕获）
> 状态：**可用，纯 HTML 企业站（Drupal），无内容接口**

## 一、这是什么站

- **定位**：全球市场研究集团，消费者洞察、品牌健康、趋势报告
- **主体**：Ipsos（益普索）
- **商科相关**：**高**（消费者趋势、品牌研究，权威第三方）
- **内容形态**：洞察文章 + 新闻 + 报告
- **更新频率**：周/月（首页有 2026-02 人事新闻、2025-07 趋势洞察）

## 二、页面与技术形态

- **框架**：**Drupal**（`form-autocomplete`、`edit-search-api-fulltext`），Slick 轮播
- **渲染**：1476 字符、68 链接，标题与日期直接可读
- **风控**：无验证码；有 Cloudflare beacon（`__cfBeacon`）与 TCF/GPP 同意管理
- **登录**：无强制

## 三、数据源清单

| # | 类型 | 请求 / 位置 | 触发 | 返回 | 备注 |
|---|---|---|---|---|---|
| 1 | 页面列表 | `/zh-cn` HTML | page_load | 1476 字符 / 68 链接 | 栏目：洞察中心 / 新闻 / 解决方案 / AI / MMA |
| 2 | 站内搜索 | `#edit-search-api-fulltext`（Drupal Search API） | 提交 | HTML | 可用关键词检索 |
| 3 | 洞察文章 | `/zh-cn/insights/...` | — | HTML | 正文 SSR |
| 4 | 同意管理 | `__tcfapi` / `__gpp` / `__sdcmpapi` | page_load | 2 字段 | 合规用，无内容 |
| 5 | 监控 | `window.__cfBeacon` | page_load | 2 字段 | Cloudflare |

## 四、探索记录

1. 打开 `/zh-cn`：正常，首屏轮播是"益普索任命刘立丰为亚太及中国区董事长"等。
2. 新增 6 条记录，全部是同意管理/Cloudflare，**没有内容列表接口**。
3. Drupal 站点特征明显，正文走 HTML，结构稳定。

## 五、结论：怎么抓最省事

- **推荐路径**：抓 `/zh-cn/insights` 列表 HTML + 详情页，最省事；
- **搜索**：可用 Drupal 搜索 URL 直接拼关键词；
- **频率**：周更，6 小时轮询足够。

## 六、待确认 / 风险

| 项 | 说明 |
|---|---|
| 洞察列表页 URL | 需确认（`/zh-cn/insights` 或 `/zh-cn/insights-center`） |
| 报告 PDF | 部分需留资 |
| 中英文内容比例 | 中文站内容量少于全球站 |
