# 14 广告人网

> 入口：https://www.admen.cn/
> 摸底时间：2026-11-18
> 摸底方式：veddata（真实浏览器 + 网络捕获）
> 状态：**可用，Nuxt 3 + 明文 JSON 接口，可分页**

## 一、这是什么站

- **定位**：广告行业门户，杰出广告人、实战金案、传播资源、行业资讯
- **主体**：广告人网（广告人文化集团）
- **商科相关**：**高**（广告人/代理商/实战案例/行业活动）
- **内容形态**：资讯 + 案例库 + 人物库 + 资源库
- **更新频率**：当日（"18 小时前""1 天前"）

## 二、页面与技术形态

- **框架**：Nuxt 3（`_nuxt/builds/meta/...json`、`unhead:payload`）
- **渲染**：4187 字符、252 链接，首屏 SSR
- **风控**：无验证码
- **登录**：有登录/注册（手机号+密码、验证码），阅读不强制

## 三、数据源清单

| # | 类型 | 请求 / 位置 | 触发 | 返回 | 备注 |
|---|---|---|---|---|---|
| 1 | **内容分页接口（核心）** | `POST https://www.admen.cn/api/app/cms/content-server/find-page-list` | page_load，5 次 | **9876 字段** | body `{"cmsContentClassificationId":69,"cmsCategoryId":113,"size":70,"current":1}`；返回 `records[]`：`id / categoriesName / keywords / likeNum / uploadAt / introImageUrl / status`，**size/current 可分页** |
| 2 | 内容列表接口 | `POST /api/app/cms/content-server/find-list` | page_load，2 次 | 812 字段 | 另一种列表形态（不分页？） |
| 3 | **案例库分页** | `GET /api/app/cms/admenCase/pageAdmenCase` | page_load | 916 字段 | 实战金案 |
| 4 | 实战金案展示 | `GET /api/admen/home/select-xyj-show-works` | page_load | 1146 字段 | 首页金案位 |
| 5 | 导航树 | `GET /api/app/cms/cmsNavigations/list` | page_load，2 次 | 494 字段 | 全部栏目 ID，做分类映射用 |
| 6 | 关于我们 | `GET /api/app/cms/content-server/getAboutUs` | page_load | 3 字段 | 无内容 |

## 四、探索记录

1. 打开首页：正常，资讯流带"时间 + 阅读数 + 点赞数"。
2. 抓到 9 条记录，主体是 `/api/app/cms/...` 系列，全部明文 JSON、无签名。
3. `find-page-list` 的 body 里明确了 `size` 与 `current` 两个分页参数，`size=70` 一次可拿 70 条。
4. `cmsNavigations/list` 返回 494 字段的栏目树，可按栏目 ID 精准抓"实战金案"。

## 五、结论：怎么抓最省事

- **推荐路径**：`find-page-list`（size=70、current 递增）批量拉列表 → 详情页取正文；
- **分类**：先拉 `cmsNavigations/list` 拿 `cmsContentClassificationId` / `cmsCategoryId`，只取"实战金案/案例"类；
- **优势**：单次 70 条、明文 JSON，是这批源里**最适合服务端定时爬**的之一。

## 六、待确认 / 风险

| 项 | 说明 |
|---|---|
| 分类 ID 语义 | 69/113 对应哪个栏目未确认，需对照导航树 |
| 详情页正文 | 未验证 |
| 接口频控 | 未见签名，但 5 次并发说明可承受；仍建议 ≥1 秒/次 |
| 版权 | 案例含品牌素材，建议标题+摘要+链接 |

## 七、文章级验证（2026-11-18）

- **文章**：《干货拉满！2026战马能量饮料营销大赛培训会高能收官，备赛秘籍一次性全透底！》
- **URL**：`https://www.admen.cn/content/50232`
- **整页正文**：3,097 字符 / 63 链接（正文约 2,000 字）
- **作者/时间**：战马，2026-11-17 16:00:47，10,099 阅读
- **付费墙/登录**：无（登录弹窗不拦截）
- **结论**：文章页可抓；`/content/<id>` 稳定
