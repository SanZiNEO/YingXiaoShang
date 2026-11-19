# 16 品牌星球 Brandstar

> 入口：https://www.brandstar.com.cn/
> 摸底时间：2026-11-18
> 摸底方式：veddata（真实浏览器 + REST/RSS 探测）
> 状态：**可用，且有全量 RSS ——目前最省事的源**

## 一、这是什么站

- **定位**：品牌叙事媒体 + 研究与咨询，新消费品牌深度案例
- **主体**：品牌星球 Brandstar
- **商科相关**：**极高**（品牌战略、品牌叙事、新消费案例）
- **内容形态**：深度报道 + 研究议题 + 品牌资讯 + 视频人物
- **更新频率**：周更为主（首页最新 2026-10-14 / 2026-09-04）

## 二、页面与技术形态

- **框架**：**WordPress**（`wp-emoji-settings`、`wp-skip-link`），前端做了定制
- **渲染**：SSR HTML，首屏 1330 字符、93 链接
- **风控**：无验证码；WordPress REST 被安全插件封
- **登录**：阅读不强制

## 三、数据源清单

| # | 类型 | 位置 | 触发 | 返回 | 备注 |
|---|---|---|---|---|---|
| 1 | **RSS 全文源（核心）** | `https://www.brandstar.com.cn/feed/` | GET | **279,176 字符 XML** | RSS 2.0，带 `<content:encoded>`，**接近全文**，一篇不用再打开 |
| 2 | REST API | `/wp-json/wp/v2/posts` | GET | 被拦 | 返回 `{"code":"private_reader_route","status":404}`，安全插件封了 |
| 3 | 页面列表 | 首页 HTML | page_load | 1330 字符 / 93 链接 | 深度报道 / 研究议题 / 资讯 |
| 4 | 现有适配器 | `packages/news/src/sources/brandstar.ts` | 定时 | **0 条（已失效）** | 旧正则在找 `/in-depth/<id>`、`/news/<id>`，站点已改成 `/articles/...` |

## 四、探索记录

1. 打开首页：WordPress 特征明显（`wp-emoji-settings`、`wp-skip-link`），页面为品牌叙事长文。
2. 试 `/wp-json/wp/v2/posts?per_page=3` → 404 `private_reader_route`（安全插件），REST 不可用。
3. 试 `/feed/` → **成功，279KB XML**，条目含标题、链接、发布时间、正文（`content:encoded`）。
4. 现有适配器返回 0 条的原因确认：站点 URL 结构变了（旧正则匹配不到）。

## 五、结论：怎么抓最省事

- **推荐路径**：**直接解析 `/feed/` RSS**，一次拿全量最近文章（含正文），不用逐篇打开；
- **修复适配器**：把 brandstar 适配器从"正则扫列表"改成"解析 RSS"即可，改动最小、收益最大；
- **注意**：RSS 通常只给最近 N 篇（10–20），定时轮询足够；历史稿需分页或站点地图。

## 六、待确认 / 风险

| 项 | 说明 |
|---|---|
| RSS 条数上限 | 需数一下当前条目数（本次只看了开头） |
| `<content:encoded>` 完整度 | 接近全文，但可能截断图片说明 |
| 更新频率 | 周更，轮询间隔可放长（如 6 小时） |

## 七、文章级验证（2026-11-18）

- **文章**：《K天王中国行，源一资本对话NNormal：新一代越野品牌，为何能吸引中国跑者？》
- **URL**：`https://www.brandstar.com.cn/articles/source-8348/`
- **整页正文**：5,917 字符 / 42 链接（页面标「约 13 分钟」长文）
- **时间/标签**：2026-10-14，关联标签 NNormal / 源一资本 / KONTENT
- **付费墙/登录**：无
- **结论**：**品牌星球已改版为 WordPress 单篇 `/articles/source-<id>/`，正文可抓，质量高**；旧的 `/in-depth/` 适配器已失效，需按新路径重写
