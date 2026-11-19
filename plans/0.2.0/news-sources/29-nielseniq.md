# 29 尼尔森IQ NielsenIQ

> 入口：https://nielseniq.com/global/zh/ → 跳转 https://nielseniq.cn/global/zh/
> 摸底时间：2026-11-18
> 摸底方式：veddata（真实浏览器 + 网络捕获）
> 状态：可打开，OneTrust 同意墙 + 报告下载留资

## 一、这是什么站

- **定位**：全球消费者研究机构（原尼尔森零售测量），零售、快消、便利店洞察
- **主体**：NielsenIQ（NIQ）
- **商科相关**：**高**（零售数据、快消趋势、渠道洞察）
- **内容形态**：洞察文章 + 报告（PDF，表单下载）
- **更新频率**：月/季

## 二、页面与技术形态

- **框架**：企业官网（OneTrust 同意管理 + UserWay 无障碍 + Microsoft Dynamics 表单）
- **渲染**：707 字符、173 链接；打开的是文章页「便利店趋势洞察：变局中的新机遇」
- **风控**：无验证码，但有 OneTrust Cookie 横幅（Accept All / Reject All）
- **登录**：报告下载走 Dynamics 表单（姓名/邮箱留资）

## 三、数据源清单

| # | 类型 | 请求 / 位置 | 触发 | 返回 | 备注 |
|---|---|---|---|---|---|
| 1 | 站内文章 | `nielseniq.cn/global/zh/` 文章页 | page_load | 707 字符 / 173 链接 | 标题与摘要可见 |
| 2 | 同意管理 | `geolocation.onetrust.com`、`cookie-cdn.cookiepro.com` | page_load | 4/3 字段 | 必须先处理 cookie |
| 3 | **报告表单** | `formui-usa1.mkt.dynamics.com/.../FormLoader` | page_load | 38 字段 | 下载报告要填 Microsoft Dynamics 表单 |
| 4 | 表单提交 | `public-eur.mkt.dynamics.com/.../visits` | 交互 | 2 字段 | 留资提交 |
| 5 | 内容接口 | **无** | — | — | 全站没有列表 JSON 接口 |

## 四、探索记录

1. 打开 `nielseniq.com/global/zh/` → 跳 `nielseniq.cn` 文章页。
2. 首屏 707 字符，是文章摘要级内容，列表不在这里。
3. 新增 14 条记录：全部是 OneTrust / Dynamics 表单 / UserWay 无障碍，**无一条内容接口**。
4. 报告"下载报告"按钮指向 Dynamics 表单，说明是**留资换 PDF**。

## 五、结论：怎么抓最省事

- **推荐路径**：抓文章页 HTML（标题+摘要），报告目录靠人工；
- **不建议**：不要自动提交留资表单（合规与隐私风险）；
- **替代**：尼尔森数据常被 CBNData/第一财经引用，可走转载。

## 六、待确认 / 风险

| 项 | 说明 |
|---|---|
| 是否有洞察列表页 | 未定位（可能在 `/insights/` 下） |
| 报告正文 | 只在 PDF 里，需表单 |
| Cookie 墙 | 服务端抓取要带 consent cookie |
