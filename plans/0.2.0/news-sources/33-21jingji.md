# 33 21世纪经济报道（21经济网）

> 入口：https://www.21jingji.com/
> 摸底时间：2026-11-18
> 摸底方式：veddata（真实浏览器 + 网络捕获）
> 状态：**可用，且是顶级源：列表接口直接带全文**

## 一、这是什么站

- **定位**：财经新闻（宏观、公司、金融、证券、全球），南方财经旗下
- **主体**：21 世纪经济报道 / 南方财经全媒体集团
- **商科相关**：**极高**（宏观数据、公司动态、消费、金融）
- **内容形态**：快讯（机器稿）+ 深度 + 视频 + 数据
- **更新频率**：**分钟级**（快报流 10:31、10:38 连续更新）

## 二、页面与技术形态

- **框架**：SSR + `api.21jingji.com` 接口 + 行情 JSON
- **渲染**：7628 字符、191 链接
- **风控**：无验证码
- **登录**：无强制

## 三、数据源清单

| # | 类型 | 请求 / 位置 | 触发 | 返回 | 备注 |
|---|---|---|---|---|---|
| 1 | **快报列表接口（核心）** | `GET https://api.21jingji.com/timestream/getListweb?page=1&callback=<jsonp>&_=<ts>` | page_load | **1532 字段** | `list[]`：`id / catid / title / inputtime / author / username / **content（全文）** / url / source / audio / type`，**page 翻页** |
| 2 | **行情数据** | `GET https://m.21jingji.com/datablock/data/market.json` | page_load | 74 字段 | 指数/板块行情，可做"市场温度" |
| 3 | 页面列表 | 首页 HTML | page_load | 7628 字符 / 191 链接 | 栏目：宏观/公司/金融/证券/全球/观点/汽车 |
| 4 | 埋点 | `rmapi.nfzmy.com/.../sendRecord` | page_load | 3 字段 | 统计 |
| 5 | JS 变量 | `__articleid` / `__catid` / `__titleContent` 等 | html_parse | 2 字段 | 页面元信息 |

## 四、探索记录

1. 打开首页：正常，快报流密集。
2. 抓到 `getListweb`，响应里**每条快讯直接带 `content` 全文**（"21财经11月18日电，天孚通信与启迪设计…"）。
3. 响应字段非常全：`inputtime`、`author`、`source`、`cacwhitelist_source`（来源白名单）、`audio`（AI 配音 mp3）。
4. JSONP 格式（`callback` 参数），但直接 GET 也返回 JSON（去掉 callback 即可）。

## 五、结论：怎么抓最省事

- **推荐路径**：`getListweb?page=N` 翻页，**不用逐篇打开详情页**（列表已带全文）；
- **优势**：分钟级快讯 + 全文 + 来源字段，是"服务端定时爬"的最优源之一；
- **注意**：快讯是机器稿（`21财经雷达`），质量参差，建议按 `type`/`source` 过滤深度稿。

## 六、待确认 / 风险

| 项 | 说明 |
|---|---|
| 去掉 callback 是否仍返回 JSON | 需验证一次（本次是 JSONP） |
| 快报之外的深度稿接口 | 未捕获（可能在 `getListweb` 的 catid 参数里） |
| 全文版权 | 全文入库需授权，建议摘要+链接 |
| 高频抓取 | 分钟级站点，建议 5-10 分钟一轮 |

## 七、文章级验证（2026-11-18）

- **文章**：《APEC领导人非正式会议今日举行；英伟达第三季度营收1158亿美元｜21早新闻》
- **URL**：`https://www.21jingji.com/article/20261118/herald/f5b04ebee4e6d936ee196a4817643bb6.html`
- **整页正文**：3,107 字符 / 80 链接，正文约 2,000 字
- **时间/来源**：2026-11-18 07:20，南方财经综合
- **付费墙/登录**：无
- **反面样本**：同站 `m.21jingji.com/.../herald/d04fbad...html`（黄金快讯）仅 **318 字符** —— 首页大量 herald 短讯，必须按长度过滤
- **结论**：长文页可抓；首页链接混杂短讯，建议优先走 `/timestream/getListweb` 的 `content` 全文
