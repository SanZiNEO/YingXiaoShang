# 44 哈佛商业评论（中文版）

> 入口：https://www.hbrchina.org/ → 跳转 https://www.hbrcitic.com/#/home
> 摸底时间：2026-11-18
> 摸底方式：veddata（真实浏览器 + 网络捕获）
> 状态：**可用，明文 API + 游标分页 —— 优质源**

## 一、这是什么站

- **定位**：哈佛商业评论中文版（中信出版运营），管理、营销、组织、案例
- **主体**：中信出版 / HBR 中文版
- **商科相关**：**极高**（市场营销、品牌、管理案例，教学最对口的一类）
- **内容形态**：深度文章 + 案例库 + 书籍 + 视听
- **更新频率**：日/周（首页有 2026-10-16 文章）

## 二、页面与技术形态

- **框架**：Vue SPA（hash 路由 `#/home`），接口在 `newsapi-hbr.caijingmobile.com`
- **渲染**：2901 字符、43 链接，内容靠接口
- **风控**：无验证码（有 devtools 检测 `__devtoolsDetector`，但不影响）
- **登录**：有登录/注册，阅读部分文章可能需要

## 三、数据源清单

| # | 类型 | 请求 / 位置 | 触发 | 返回 | 备注 |
|---|---|---|---|---|---|
| 1 | **文章列表接口（核心）** | `GET https://newsapi-hbr.caijingmobile.com/article/list?last_id=&client_type=1` | page_load | **529 字段** | `data.focus_articles[]`：`article{id / title / description / author / column_id / column_name / publish_time / image_url / last_id}`，**游标分页（last_id）** |
| 2 | 栏目列表 | `GET .../column/list` | page_load | 82 字段 | 栏目树（市场营销/人才管理等） |
| 3 | 站点信息 | `GET .../site` | page_load | 102 字段 | 站点配置 |
| 4 | 侧栏 | `GET .../moduleSidebar/list` | page_load | 23 字段 | 侧栏模块 |
| 5 | 广告 | `GET .../ad/list` | page_load，2 次 | 14 字段 | 广告位 |
| 6 | 文章详情 | `hbrcitic.com/#/article/<id>` 或 API | — | HTML/JSON | 由 article id 拼 |

## 四、探索记录

1. 打开 `hbrchina.org` → 自动跳 `hbrcitic.com/#/home`。
2. 首页是 hash 路由 SPA，但文章标题/摘要已在首屏渲染（2901 字符）。
3. 抓到 5 个 `newsapi-hbr` 接口，全部明文 GET，无签名。
4. `article/list` 的参数是 `last_id` + `client_type`，说明是**游标分页**（比页码更稳）。

## 五、结论：怎么抓最省事

- **推荐路径**：`article/list?last_id=<上一页最后一条>` 循环拉取 → 按 article id 取详情；
- **红利**：每条自带 `column_name`（栏目）、`author`、`publish_time`，可直接做分类和标签；
- **注意**：`client_type=1` 是 PC 标识，别丢。

## 六、待确认 / 风险

| 项 | 说明 |
|---|---|
| 详情正文接口 | 未捕获（可能在 `/article/detail`） |
| 付费比例 | HBR 部分内容会员制，需抽样 |
| 图片 | `res.hbrcitic.com` 带 OSS 参数，可直取 |
