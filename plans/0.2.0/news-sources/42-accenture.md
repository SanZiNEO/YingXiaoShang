# 42 埃森哲（中国）

> 入口：https://www.accenture.com/cn-zh
> 摸底时间：2026-11-18
> 摸底方式：veddata（真实浏览器 + 网络捕获）
> 状态：**可用，AEM 站点，纯 SSR HTML**

## 一、这是什么站

- **定位**：全球咨询公司中国站，洞察报告、消费者研究、数字化案例
- **主体**：Accenture（埃森哲）
- **商科相关**：**极高**（消费者洞察、数字化转型、供应链，报告可作教学材料）
- **内容形态**：洞察文章 + 研究报告 + 视频 + 案例
- **更新频率**：月/季（首页推"美好生活新主张——埃森哲中国消费者洞察"）

## 二、页面与技术形态

- **框架**：**Adobe Experience Manager（AEM）**（`/libs/granite/csrf/token.json`、`__satelliteLoaded`）
- **渲染**：1677 字符、155 链接，SSR
- **风控**：无验证码；OneTrust Cookie 同意（`cdn.cookielaw.org`）
- **登录**：无

## 三、数据源清单

| # | 类型 | 请求 / 位置 | 触发 | 返回 | 备注 |
|---|---|---|---|---|---|
| 1 | 页面列表 | `/cn-zh` HTML | page_load | 1677 字符 / 155 链接 | 栏目：业务领域 / 我们的洞察 / 我们是谁 |
| 2 | AEM CSRF | `GET /libs/granite/csrf/token.json` | page_load | 0 字段 | AEM 标准接口，无内容 |
| 3 | 动画资源 | `content/dam/.../lottie/*.json` | page_load，2 次 | 1025/873/1014 字段 | Lottie 动画，不是文章 |
| 4 | Cookie 同意 | `cdn.cookielaw.org/...` | page_load | 219/2697 字段 | OneTrust |
| 5 | 洞察文章 | `/cn-zh/insights/...` | — | HTML | 正文 SSR |

## 四、探索记录

1. 打开首页：正常，首屏是"一起重塑"品牌视频 + 消费者洞察报告卡。
2. 新增 10 条记录：AEM csrf、3 个 Lottie 动画、OneTrust 同意——**无内容接口**。
3. 判断：文章与洞察走 HTML，AEM 的 model.json 接口未暴露。

## 五、结论：怎么抓最省事

- **推荐路径**：抓 `/cn-zh/insights` 列表 HTML → 详情页；
- **注意**：OneTrust 会挡一下，服务端抓取带 consent cookie 更稳；
- **频率**：月/季更新，低频轮询。

## 六、待确认 / 风险

| 项 | 说明 |
|---|---|
| 洞察列表 URL | 需确认（`/cn-zh/insights` 或 `/cn-zh/about/insights`） |
| 报告 PDF | 部分需留资 |
| 版权 | 咨询报告版权严格，索引+摘要为主 |
