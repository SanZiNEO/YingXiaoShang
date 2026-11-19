# 56 证券时报

> 入口：https://www.stcn.com/
> 摸底时间：2026-11-18
> 摸底方式：veddata（真实浏览器 + 网络捕获）
> 状态：**可接入**（2026-11-18 决策：B 档并入；偏资本市场，按内容过滤）

## 一、这是什么站

- **定位**：资本市场信息披露媒体，A 股、上市公司、券商、基金
- **主体**：证券时报社
- **商科相关**：**中低**（资本市场强，营销/品牌弱）
- **内容形态**：快讯 + 上市公司公告解读 + 行情 + 数据
- **更新频率**：极高频

## 二、页面与技术形态

- **框架**：SSR + 行情 HTML 接口
- **渲染**：7026 字符、436 链接
- **风控**：**有阿里云验证码**（`#ali-captcha-verifycode-btn`、`captcha-open.aliyuncs.com`）
- **登录**：部分功能需登录

## 三、数据源清单

| # | 类型 | 请求 / 位置 | 触发 | 返回 | 备注 |
|---|---|---|---|---|---|
| 1 | 分时行情 | `GET https://www.stcn.com/candlestick/index-time-trend.html` | page_load，8 次 | 9 字段 | 指数分时 |
| 2 | **热榜** | `GET https://www.stcn.com/article/index-hot-list.html` | page_load | 52 字段 | 新闻热榜 |
| 3 | 热门板块 | `GET https://www.stcn.com/article/hot-plate.html` | page_load | 62 字段 | 板块行情 |
| 4 | 自选股 | `GET https://www.stcn.com/article/my-stocks.html` | page_load | 33 字段 | 需登录态 |
| 5 | 验证码 | `POST https://1ou5tl.captcha-open.aliyuncs.com/` | page_load | 11 字段 | 阿里云验证码 |

## 四、探索记录

1. 打开首页：内容以 A 股行情、涨停板、英伟达财报为主。
2. 抓到 4 个内容/行情接口 + 1 个验证码接口。
3. 验证码说明有风控（虽未弹出验证页）。

## 五、结论：怎么抓最省事

- **建议**：**可接**。理由：2026-11-18 用户决策 B 档并入；内容偏资本市场，靠 tag 匹配过滤；验证码只挂首页，文章页未拦截正文。
- **若要财经背景**：用第一财经/21 世纪/每经替代。

## 六、待确认 / 风险

| 项 | 说明 |
|---|---|
| 验证码触发 | 高频访问可能弹 |
| 相关性 | 营销类稿件占比低 |

## 七、veddata 复测（2026-11-18 12:10）

- **列表接口**：`GET https://www.stcn.com/article/index-hot-list.html` 返回 10 条，字段 `title` / `url`（`/article/detail/<id>.html`）
- **样本**：`https://www.stcn.com/article/detail/4340469.html`
- **正文**：3,165 字符 / 143 链接；作者、来源、时间齐全
- **验证码**：文章页仍加载阿里云验证码脚本（`#ali-captcha-verifycode-btn`），但未拦截正文
- **结论**：可接入，列表走 hot-list 接口，详情页直接解析