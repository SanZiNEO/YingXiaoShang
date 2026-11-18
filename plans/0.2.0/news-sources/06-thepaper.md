# 06 澎湃新闻

> 入口：https://www.thepaper.cn/
> 摸底时间：2026-11-18
> 摸底方式：veddata（真实浏览器 + 网络捕获）
> 状态：可用；Next.js SSR + contentapi 接口群

## 一、这是什么站

- **定位**：时政与思想类综合新闻，财经/时事频道有大量政策与产业报道
- **主体**：澎湃新闻（上海报业集团）
- **商科相关**：**中**（财经频道可用；首页以时政为主，需按频道过滤）
- **内容形态**：快讯 + 深度 + 专题 + 视频
- **更新频率**：高频（首页按分钟级更新）

## 二、页面与技术形态

- **框架**：Next.js（`__NEXT_DATA__` 902 字段），SSR + contentapi
- **渲染**：首屏 HTML 只有 1625 字符（内容大量在 `__NEXT_DATA__` 和接口里）
- **风控**：阿里云验证码（`captcha-open.aliyuncs.com`、`cloudauth-device`），页面有 `#__captcha_btn_nvc`
- **登录**：有登录态接口，阅读不强制

## 三、数据源清单

| # | 类型 | 请求 / 位置 | 触发 | 返回 | 备注 |
|---|---|---|---|---|---|
| 1 | 内嵌 SSR | `<script id="__NEXT_DATA__">` | html_parse | 902 字段 | 首页数据快照 |
| 2 | **首页卡片接口** | `GET https://api.thepaper.cn/contentapi/wwwIndex/wwwIndexInterleave` | page_load | 174 字段 | 返回 `pcChannelInterleaveInfo`，按 position 排卡片（specialCard 等） |
| 3 | **频道树接口** | `GET https://cache.thepaper.cn/contentapi/node/getWwwAllNodes` | page_load，2 次 | **2211 字段** | 全站栏目节点，做分类映射最有用 |
| 4 | 侧栏接口 | `GET https://cache.thepaper.cn/contentapi/wwwIndex/rightSidebar` | page_load | **3089 字段** | 榜单/侧栏内容 |
| 5 | 登录态 | `GET https://api.thepaper.cn/userservice/user/web/getLoginStatus` | page_load | 4 字段 | — |
| 6 | 地区 | `GET https://api.thepaper.cn/contentapi/region/getRegionByRequestIp` | page_load | 4 字段 | 本地频道用 |
| 7 | 互动/游戏 | `POST https://api.thepaper.cn/interaction/onekeyblackwhite/grayInfo`、`/gameapi/crossword/page` | page_load | 6 / 15 字段 | 与内容无关 |
| 8 | 验证码 | `POST https://1dl38w.captcha-open.aliyuncs.com/`、`upload.captcha-open.aliyuncs.com` | page_load | 8 / 2 字段 | 阿里云验证码 |

## 四、探索记录

1. 打开首页：正常，页面有"查看更多"按钮和验证码按钮。
2. `wwwIndexInterleave` 返回的是**首页卡片位**（专题卡、H5 卡、视频卡），不是文章列表——说明列表主体在 `__NEXT_DATA__` 或按频道接口拉。
3. `getWwwAllNodes` 返回 2211 字段，是**全站栏目树**（频道/子栏目），对"按商科频道过滤"非常有用。
4. 出现两条阿里云验证码请求，说明有风控埋点（本次未触发验证页）。

## 五、结论：怎么抓最省事

- **推荐路径**：先调 `getWwwAllNodes` 拿频道树 → 定位"财经/商业"节点 → 解析页面 HTML 或 `__NEXT_DATA__` 取列表；
- **正文**：详情页 HTML（澎湃正文结构稳定）；
- **注意**：首页 1625 字符说明纯 HTML 抓不到全部列表，必须带接口或 `__NEXT_DATA__`。

## 六、待确认 / 风险

| 项 | 说明 |
|---|---|
| 按频道取列表的接口 | 未捕获到 `nodeId` 参数接口，需进频道页再抓一次 |
| 验证码触发条件 | 高频访问可能触发阿里云滑块 |
| 时政内容占比 | 首页时政多，必须频道过滤后再入库，否则污染商科语料 |

## 八、文章级验证（2026-11-18）

- **URL**：`https://www.thepaper.cn/newsDetail_forward_34438986`
- **整页正文**：2,601 字符 / 61 链接
- **作者/时间**：宋舒吲，2026-11-10 09:23，来源澎湃新闻
- 页面存在 `#__captcha_btn_nvc` / `#__captcha_btn_nvcLogin` 按钮，但**正文正常加载，不拦截阅读**
- **结论：澎湃文章页可抓**；验证码只在登录/交互时触发
