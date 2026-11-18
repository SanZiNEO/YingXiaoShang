# 24 CBNData 第一财经商业数据中心

> 入口：https://www.cbndata.com/
> 摸底时间：2026-11-18
> 摸底方式：veddata（真实浏览器 + 网络捕获）
> 状态：**可用，明文分页接口 + 自带行业标签 —— 优质源**

## 一、这是什么站

- **定位**：消费大数据研究机构，消费趋势、行业报告、榜单
- **主体**：第一财经（CBNData，上海第一财经报业）
- **商科相关**：**极高**（消费趋势、品牌增长、人群研究，直接对口市场营销课程）
- **内容形态**：报告 + 看点文章 + 榜单 + 活动
- **更新频率**：日更（首页多条当日稿）

## 二、页面与技术形态

- **框架**：Next.js 前端 + `api-next.cbndata.com` 接口
- **渲染**：2430 字符、192 链接，首屏内容靠接口
- **风控**：未见验证码
- **登录**：有注册/登录，但列表与文章可读

## 三、数据源清单

| # | 类型 | 请求 / 位置 | 触发 | 返回 | 备注 |
|---|---|---|---|---|---|
| 1 | **内容分页接口（核心）** | `GET https://api-next.cbndata.com/consumerstation/web/home/informations?pageIndex=1&pageSize=20&oldTagId=` | page_load | 150 字段 | 返回 `data.list[]`：`id / title / image / **tags[]** / read_times / likes_count / favorite_counts / date`，**pageIndex/pageSize 可翻页** |
| 2 | **订阅标签接口** | `GET .../consumerstation/web/user/v1/sub_tags` | page_load | 84 字段 | 行业/人群标签库（做知识点映射的现成词表） |
| 3 | 广告位 | `GET .../content/portal/ad` | page_load | 4 字段 | 广告 |
| 4 | 友情链接 | `GET .../content/portal/friendshiplink` | page_load | 76 字段 | 站点导航 |
| 5 | 频道 | 首页导航：报告 / 看点 / 榜单 / 活动 / CBNDataBox | — | — | 榜单可单抓 |

## 四、探索记录

1. 打开首页：正常，头条是"李宁、斯凯奇、橙狮体育的匹克球生意"等消费稿。
2. 抓到 `home/informations`，参数写明 `pageIndex / pageSize`，响应里每条自带 `tags`（"宠物""宠物食品及用品""消费趋势"）。
3. `sub_tags` 返回 84 字段的标签体系——**和新榜/飞瓜不同，这个是公开的**。
4. 没有任何登录拦截，接口明文。

## 五、结论：怎么抓最省事

- **推荐路径**：`home/informations` 翻页（20 条/页）→ 按 `id` 拼详情页 → 取正文；
- **红利**：`tags` + `sub_tags` 可直接映射到"消费趋势/行业"知识点，**比新闻正文匹配更准**；
- **频率**：日更站点，30 分钟-1 小时轮询一次足够。

## 六、待确认 / 风险

| 项 | 说明 |
|---|---|
| 详情页 URL 规则 | 需按 id 确认（可能是 `/report/<id>` 或 `/article/<id>`） |
| 报告全文 | 部分研究报告需登录/付费下载，文章类免费 |
| 接口频控 | 未见签名，建议 ≥1 秒/次 |
| 版权 | 报告版权强，建议只入库标题+摘要+链接 |
