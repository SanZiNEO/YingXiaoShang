# 60 中国日报商业（China Daily Business）

> 入口：https://www.chinadaily.com.cn/business
> 摸底时间：2026-11-18
> 摸底方式：veddata（真实浏览器 + 网络捕获）
> 状态：**可接入**（英文源，保留原文+摘要，给 AI 消费）

## 一、这是什么站

- **定位**：中国日报英文版商业频道（中国经济、公司、政策、科技、汽车）
- **主体**：China Daily（中国日报）
- **商科相关**：**中**（内容对口；英文由 AI 总结/翻译后消费，不按字面匹配）
- **内容形态**：英文新闻 + 数据 + 视频
- **更新频率**：日更

## 二、页面与技术形态

- **框架**：传统门户 SSR
- **渲染**：3013 字符、264 链接
- **风控**：无验证码
- **登录**：无

## 三、数据源清单

| # | 类型 | 请求 / 位置 | 触发 | 返回 | 备注 |
|---|---|---|---|---|---|
| 1 | 页面列表 | `/business` HTML | page_load | 3013 字符 / 264 链接 | 栏目：Policies / Companies / Industries / Technology / China Data / Motoring |
| 2 | 频道页 | `/business/...` | — | HTML | 英文稿 |
| 3 | 内容接口 | **无** | — | — | 0 条本站记录 |

## 四、探索记录

1. 打开 `/business`：正常，头条是"Enhanced services trade expected to bolster cross-border businesses"等英文稿。
2. 0 条新增接口（新增记录是上一站东方财富的登录/上报）。
3. 纯 HTML，结构标准。

## 五、结论：怎么抓最省事

- **建议**：**可接**（2026-11-18 B 档并入；英文源保留原文+摘要，由 AI 总结/翻译，再按语义匹配知识点）；
- **例外**：若要做"英文营销术语/国际案例"素材，可单独抓 `Companies` 频道；
- **优先级**：最低。

## 六、待确认 / 风险

| 项 | 说明 |
|---|---|
| 语言 | 英文，需翻译或双语匹配 |
| 相关性 | 商业新闻为主，营销方法少 |
| 版权 | 官方英文媒体，转载需授权 |

## 七、文章级验证（2026-11-18）

- **文章**：《Enhanced services trade expected to bolster cross-border businesses》
- **URL**：`https://www.chinadaily.com.cn/a/202611/18/WS6afcf5f1e4b03ebf8519d05f.html`
- **整页正文**：5,003 字符 / 140 链接
- **作者**：By Zhong Nan
- **结构化数据**：JSON-LD（headline/url/image/datePublished，13 字段）
- **付费墙/登录**：无
- **结论**：**英文商业稿可抓，带标准 JSON-LD**；路径 `/a/YYYYMM/DD/WS<hash>.html`

## 八、veddata 复测（2026-11-18 12:18）

- **列表**：`/business` 3,055 字符 / 264 链接，静态 HTML；文章路径 `/a/YYYYMM/DD/WS<hash>.html`
- **样本**：`https://www.chinadaily.com.cn/a/202611/18/WS6afcf5f1e4b03ebf8519d05f.html`
- **正文**：整页 5,003 字符 / 140 链接；作者 `By Zhong Nan`，带 JSON-LD
- **结论**：可接入，英文商业稿完整可读