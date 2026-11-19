# 47 雨果跨境

> 入口：https://www.cifnews.com/
> 摸底时间：2026-11-18
> 摸底方式：veddata（真实浏览器 + 网络捕获）
> 状态：**可用，接口极多（单页 40+ 请求），跨境电商数据富矿**

## 一、这是什么站

- **定位**：跨境电商品牌出海产业互联网平台（亚马逊、TikTok Shop、独立站、选品）
- **主体**：雨果跨境（CIFNews）
- **商科相关**：**极高**（跨境电商、出海营销、选品，外贸/电商方向核心源）
- **内容形态**：资讯 + 活动（大会/沙龙）+ 课程 + 开店服务 + 选品
- **更新频率**：极高频

## 二、页面与技术形态

- **框架**：自研前端 + 多子域 ajax（`api.cifnews.com`、`ajax.cifnews.com`、`www.cifnews.com/index/ajax/...`）
- **渲染**：7822 字符、**1169 链接**
- **风控**：无验证码
- **登录**：开店/课程需登录，资讯免登录

## 三、数据源清单

| # | 类型 | 请求 / 位置 | 触发 | 返回 | 备注 |
|---|---|---|---|---|---|
| 1 | **首页重要位** | `GET https://api.cifnews.com/page/ajax/important` | page_load，2 次 | **4706 字段** | 首页要闻聚合 |
| 2 | **推荐位** | `GET https://ajax.cifnews.com/support/view/index-recommend` | page_load | 496 字段 | 推荐文章 |
| 3 | **文章推荐** | `GET https://www.cifnews.com/index/ajax/recommend/article` | page_load | 70 字段 | 文章列表（推荐流） |
| 4 | 服务模块 | `GET https://www.cifnews.com/index/ajax/service` | page_load | 192 字段 | 开店/服务入口 |
| 5 | 头部搜索热词 | `GET https://ajax.cifnews.com/index/v1/header/search-top` | page_load | 16 字段 | 热搜词 |
| 6 | **活动专题** | `GET https://ajax.cifnews.com/activity/subject`、`/subject/<id>/active` | page_load，**10+ 次** | 6679 / 300+ 字段 | 大会/沙龙排期，活动营销素材 |
| 7 | 课程校验 | `POST /yuke/service/ajax/auth/course/check` | page_load | 6 字段 | 课程权限 |
| 8 | 关注信息 | `GET /seller/subscribe/ajax/follower/info/...` | page_load | 70 字段 | 作者关注 |

## 四、探索记录

1. 打开首页：正常，头部是跨境大会/选品大会排期。
2. 单页触发 **43 条新记录**，其中 `activity/subject/<id>/active` 被调十余次（每个活动一个请求）。
3. `page/ajax/important` 返回 4706 字段——首页要闻全量。
4. 全部明文 GET，无签名。

## 五、结论：怎么抓最省事

- **推荐路径**：`index/ajax/recommend/article` + `page/ajax/important` 拿列表 → 详情页；
- **注意**：接口太碎（43 个/页），抓取时只挑 2-3 个内容接口，别全量复现；
- **附加值**：活动专题数据可做"跨境营销活动日历"。

## 六、待确认 / 风险

| 项 | 说明 |
|---|---|
| 分页参数 | 推荐流是否有 page 未确认 |
| 详情页正文 | 未验证 |
| 请求量 | 单页 43 请求，服务端抓要精简 |

## 七、文章级验证（2026-11-18）

- **文章**：《跨境大卖的AI三年节奏：2019信息化、2022数字化、2025 AI底座》
- **URL**：`https://www.cifnews.com/article/189644`
- **整页正文**：6,767 字符 / **882 链接**（导航极重，必须正文容器）
- **接口**：详情页请求 `GET https://api.cifnews.com/page/ajax/important?key=article_detail&...`，返回 `data[69]`、约 4,755 字段
- **付费墙/登录**：无
- **结论**：**正文可抓但页面噪声大**；优先走 `api.cifnews.com` 的 article_detail 接口取结构化正文
