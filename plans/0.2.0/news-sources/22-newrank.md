# 22 新榜

> 入口：https://www.newrank.cn/
> 摸底时间：2026-11-18
> 摸底方式：veddata（真实浏览器 + 网络捕获）
> 状态：可打开，但**核心数据需登录/会员**

## 一、这是什么站

- **定位**：新媒体内容数据平台（公众号/抖音/小红书榜单、账号估值、投放）
- **主体**：上海新榜信息技术股份有限公司
- **商科相关**：**中高**（新媒体营销、KOL 投放、内容产业报告）
- **内容形态**：榜单 + 数据工具 + 行业报告 + 资讯
- **更新频率**：榜单日更（需登录）

## 二、页面与技术形态

- **框架**：Next.js（`_next/data/<build>/index.json` 1837 字段）
- **渲染**：首页 4416 字符、152 链接，**公司介绍为主**，不是内容流
- **风控**：未见验证码；有 Sentry 监控
- **登录**：**强依赖**。`getLoginUser`、`checkUserMemberStatus`、`getUserAuthStatus` 全在启动时调用

## 三、数据源清单

| # | 类型 | 请求 / 位置 | 触发 | 返回 | 备注 |
|---|---|---|---|---|---|
| 1 | 页面数据 | `GET /_next/data/<buildId>/index.json` | page_load | **1837 字段** | 首页 SSR 数据（站点配置/介绍），非榜单数据 |
| 2 | 登录态 | `GET https://gw.newrank.cn/api/internalUser/nr/user/info/getLoginUser` | page_load | 2 字段 | 未登录返回空 |
| 3 | 会员状态 | `POST .../account/right/checkUserMemberStatus` | page_load | 2 字段 | 会员墙 |
| 4 | 用户信息 | `POST .../getUserInternal` | page_load | 4 字段 | — |
| 5 | **报告接口** | `POST https://gw.newrank.cn/api/tiny/xdnphb/report/analyze/queryNewReports` | page_load | 16 字段 | 行业报告列表（公开度较高） |
| 6 | 搜索趋势 | `POST .../mainSearch/trendSearch/getUserLabel` | page_load | 3 字段 | 搜索标签 |
| 7 | 客服 | `GET .../tracing/qy/user/getExclusiveKf` | page_load | 3 字段 | 销售 |

## 四、探索记录

1. 打开首页：正常，但页面是"公司介绍 + 榜单入口"，没有新闻流。
2. 启动即调 4 个登录/会员接口，说明**数据服务全部在登录后**。
3. 抓到 `queryNewReports`（行业报告），是相对公开的一块。
4. 榜单页（`/rank/...`）未进入，预计同样要登录。

## 五、结论：怎么抓最省事

- **推荐路径**：只抓**公开报告列表 + 报告详情**（queryNewReports），不做榜单；
- **不建议**：不要试图复现登录后的榜单接口（账号风控 + 会员费）；
- **替代**：需要"公众号榜单"时，用公开的第三方榜单或新榜公众号推文。

## 六、待确认 / 风险

| 项 | 说明 |
|---|---|
| 报告是否全文公开 | 部分报告要登录下载 |
| 榜单公开页 | `/rank` 是否有免登录榜单，未验证 |
| 账号风险 | 登录抓取违反平台规则，不建议 |
