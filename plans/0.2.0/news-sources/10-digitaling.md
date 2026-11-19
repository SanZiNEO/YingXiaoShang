# 10 数英 DIGITALING

> 入口：https://www.digitaling.com/
> 摸底时间：2026-11-18
> 摸底方式：veddata（真实浏览器 + 网络捕获）
> 状态：**可用，且是最优质的一类：明文 JSON 接口 + 结构化标签**

## 一、这是什么站

- **定位**：广告、营销、创意案例库 + 行业观点，代理商/品牌方都在用
- **主体**：数英网（广告营销服务平台）
- **商科相关**：**极高**（营销案例、品牌 campaign、文案、公关、招聘）
- **内容形态**：文章 + 项目（案例）+ 指数 + 招聘 + 课堂
- **更新频率**：当日多条（样本为 2026-11-18）

## 二、页面与技术形态

- **框架**：服务端渲染 + 明文 JSON API（`/api/...`），带 `ci_session` cookie，无签名
- **渲染**：首屏 4398 字符、528 链接；栏目：首页/文章/项目/招聘/广场/指数/课堂/数英奖
- **风控**：本次未见验证码
- **RSS**：页面有 RSS 图标（`a.icon.bsns_blk_rss`），说明提供订阅源

## 三、数据源清单

| # | 类型 | 请求 / 位置 | 触发 | 返回 | 备注 |
|---|---|---|---|---|---|
| 1 | **文章列表接口** | `GET https://www.digitaling.com/api/getArticles/type/viewCount` | page_load | 81 字段 | 每条：`articleId / title / cover / collectCount / zan / commentCount / **tags** / publishTime` |
| 2 | **案例列表接口** | `GET https://www.digitaling.com/api/getProjects/type/viewCount` | page_load | 119 字段 | 项目/案例（品牌 + 代理商 +  campaign） |
| 3 | 最新评论 | `GET /api/getLatestComment/type/1`、`/type/2` | page_load | 121 字段 | 互动数据，可做热度 |
| 4 | 作者文章 | `GET /api/getWriterArts` | page_load | 222 字段 | 按作者聚合 |
| 5 | 招聘 | `GET /api/getLatestJobs`、`/api/getJobHotBanner` | page_load | 270 / 21 字段 | 行业招聘，非内容 |
| 6 | RSS | 页面 RSS 图标 | 手动 | XML | 订阅入口 |
| 7 | 详情页 | `digitaling.com/articles/<articleId>.html` | — | HTML | 由 articleId 拼 URL |

## 四、探索记录

1. 首页正常："最新收录文章/项目"直接可见，当日多篇。
2. 捕获 7 条接口，全部是 `/api/getXxx` 明文 GET，响应 `{isSuccess:1, content:[...]}`。
3. `getArticles` 返回字段里**自带 tags**（"文案,许飞,后会有期,文案方法" / "营销,公关,观点洞察"），对标签匹配是现成红利。
4. 文章列表按 `viewCount` 排序，说明可按热度取。

## 五、结论：怎么抓最省事

- **推荐路径**：直接调 `getArticles` + `getProjects` → 按 `articleId` 拼详情页 → 取正文；
- **红利**：tags 自带，可直接映射到营销知识点（文案/公关/创意/投放）；
- **注意**：`publishTime` 是 Unix 秒；接口无签名，但带 session cookie，建议带一次首页 cookie 再调。

## 六、待确认 / 风险

| 项 | 说明 |
|---|---|
| 翻页参数 | 当前只见 `type`，页码/offset 需再试（可能在 `page` 参数） |
| 详情页正文 | 未验证；数英正文一般完整 |
| 接口频控 | 明文接口可能有频控，建议 ≥1 秒/次 |
| 版权 | 案例含品牌方素材，入库建议标题+摘要+链接 |
