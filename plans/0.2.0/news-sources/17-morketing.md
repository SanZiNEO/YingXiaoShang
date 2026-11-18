# 17 Morketing

> 入口：https://www.morketing.com/
> 摸底时间：2026-11-18
> 摸底方式：veddata（真实浏览器；此前 .NET 客户端超时）
> 状态：**可用（8.8 秒打开），Nuxt SSR + 明文接口**

## 一、这是什么站

- **定位**：全球营销商业媒体，品牌增长、广告技术、CXO 访谈、行业盘点
- **主体**：Morketing（营销商业媒体平台）
- **商科相关**：**极高**（营销趋势、品牌案例、广告投放、AI 营销）
- **内容形态**：深度稿 + 快讯 + 专栏 + 报告下载 + 活动
- **更新频率**：高频（首页多条当日/近日）

## 二、页面与技术形态

- **框架**：Nuxt（`window.__NUXT__`），SSR + Element UI
- **渲染**：6947 字符、32 链接；**标题与正文可见**
- **风控**：无验证码；打开耗时 8.8 秒（首屏重）
- **登录**：有登录/注册弹窗（多个 `el-dialog`），阅读不强制

## 三、数据源清单

| # | 类型 | 请求 / 位置 | 触发 | 返回 | 备注 |
|---|---|---|---|---|---|
| 1 | **内嵌 SSR（核心）** | `window.__NUXT__` | js_global | 对象，含 `layout / data[]` | `data[0].navs` = 栏目（最新文章/热点/资讯/行业/趋势/案例/专访/活动）；`bannerList` = 文章卡（`id / name / img / url: https://www.morketing.com/detail/<id> / intro`） |
| 2 | 配置接口 | `POST /api/morketing/webConfig` | page_load | 22 字段 | 站点配置 |
| 3 | 热搜接口 | `POST /api/morketing/hotSearch` | page_load，2 次 | 3 字段 | 热搜词 |
| 4 | 手机区号 | `POST /api/user/mobilePrefixList` | page_load | 3 字段 | 登录用 |
| 5 | 媒体库接口 | `POST /api/morketing/media` | page_load | 67 字段 | 返回 `media_List`：**公众号/小程序清单**，不是文章 |
| 6 | 详情页 | `https://www.morketing.com/detail/<id>` | — | HTML | 由 bannerList 的 url 直接拼 |

## 四、探索记录

1. veddata 打开首页：3565ms 打开浏览器 + 8825ms 进页，**成功**。
2. 捕获 5 条数据源；`/api/morketing/media` 实测 200 `{"code":1,"msg":"ok","data":{"media_List":[...]}}`，确认是媒体清单。
3. 再次打开首页（本次）：`__NUXT__` 里出现完整 `navs` 与 `bannerList`，banner 直接带 `detail/28677` 这类文章 URL。
4. 结论：**之前"打不开"是 .NET 客户端问题（TLS/UA/风控），站点本身健康**。

## 五、结论：怎么抓最省事

- **推荐路径**：解析 `__NUXT__` 的 `bannerList` / 列表数据 → 按 `detail/<id>` 打开详情页取正文；
- **备用**：直接抓首页 HTML（标题已在页面里）；
- **附加价值**：`/api/morketing/media` 的公众号清单可作为"营销自媒体资源库"；
- **不要**：不要用裸 .NET HTTP 客户端（会超时），要用真实浏览器或补齐 TLS/UA。

## 六、待确认 / 风险

| 项 | 说明 |
|---|---|
| 文章列表接口 | 未捕获到独立列表 API，列表应在 `__NUXT__` 或 HTML |
| 详情页正文 | 未验证 |
| 首屏性能 | 8.8 秒，服务端抓取要设长超时（≥30s） |
| 版权 | 原创营销媒体，建议标题+摘要+链接 |

## 七、文章级验证（2026-11-18）

- 首页 6,951 字符 / 仅 32 链接（**链接数异常少**）
- 头条 `<h3>` 被包在 `a.in-right-forum-more` 内，但该 `<a>` **没有 href**，点击仅走 JS；`ved_act` 点击超时且拿不到详情 URL
- **结论**：列表可读、详情入口是 JS 事件不是普通链接；**需走接口或 DOM 点击取 id**，不能靠 href 拼 URL
