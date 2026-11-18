# 26 巨量算数（现"抖音指数"）

> 入口：https://trendinsight.oceanengine.com/
> 摸底时间：2026-11-18
> 摸底方式：veddata（真实浏览器 + 网络捕获）
> 状态：**已从清单移除**（跳转登录，无公开正文）

## 一、这是什么站

- **定位**：抖音生态的内容/搜索趋势指数（关键词热度、行业榜单、人群画像）
- **主体**：巨量引擎（字节跳动）
- **商科相关**：**高**（热点趋势、内容选题、消费洞察）
- **内容形态**：指数工具 + 榜单 + 行业指南 + 洞察报告
- **更新频率**：日更（登录后）

## 二、页面与技术形态

- **现状**：访问 `trendinsight.oceanengine.com` → 跳转 `/arithmetic-index` → **再跳 `creator.douyin.com/creator-micro/creator-count/`**
- **提示文案**：「巨量算数」产品现已升级为「抖音指数」，正为您跳转
- **框架**：ByteDance 内部前端（`__REDUCK__`、Slardar 监控、SSO）
- **登录**：**强依赖**（`passport/account/info`、`sso/check_login` 全在启动时调）

## 三、数据源清单

| # | 类型 | 请求 / 位置 | 触发 | 返回 | 备注 |
|---|---|---|---|---|---|
| 1 | 跳转页 | `trendinsight.oceanengine.com/arithmetic-index` | page_load | 93 字符 | 只有跳转提示 + 导航 |
| 2 | 最终落地 | `creator.douyin.com/creator-micro/creator-count/` | 自动跳转 | — | 抖音创作者中心，需登录 |
| 3 | 账号信息 | `GET /passport/account/info/v2/` | page_load | 6 字段 | 未登录为空 |
| 4 | SSO 检查 | `POST https://sso.oceanengine.com/passport/sso/check_login/` | page_load | 3 字段 | 登录态校验 |
| 5 | 指数日期 | `GET /api/v2/index/get_all_valid_date`、`get_valid_date_for_relation` | page_load | 3 字段 | 指数可用日期（数据接口存在，但需登录） |
| 6 | 配置/监控 | `get_tcc_pc_new_config`、`vcs.zijieapi.com`、`mcs.zijieapi.com` | page_load | 多 | 基础设施，无内容 |

## 四、探索记录

1. 打开 `trendinsight.oceanengine.com` → 立即出现"已升级为抖音指数"跳转页（93 字符）。
2. 4 秒后自动跳到 `creator.douyin.com/creator-micro/creator-count/`。
3. 全程 27 条新记录，绝大多数是字节基础设施（TCC 配置、MCS 埋点、Slardar、SSO），只有 `get_all_valid_date` 属于业务接口。
4. 结论：**公开的"算数"入口已经收口到登录后的创作者中心**。

## 五、结论：怎么抓最省事

- **建议**：**不作为爬虫源**（登录态 + 平台条款限制）；
- **替代**：热点趋势可用微博热搜、抖音热榜公开页、新榜/飞瓜的公开榜单文章；
- **若内部使用**：可在有账号的环境里人工导出指数截图，不做自动化。

## 六、待确认 / 风险

| 项 | 说明 |
|---|---|
| 是否还有免登录指数页 | 旧链接全部跳转，暂未发现 |
| 账号风险 | 自动化抓取违反平台协议 |
| 数据价值 | 高，但通道受限 |
