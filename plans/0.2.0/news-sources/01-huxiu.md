# 01 虎嗅

> 入口：https://www.huxiu.com/
> 摸底时间：2026-11-18
> 摸底方式：veddata（Chromium 真实浏览器 + 网络/内嵌数据捕获）
> 状态：首页可用；频道页触发滑块验证

## 一、这是什么站

- **定位**：商业与科技深度内容平台，评论与产业观察为主
- **主体**：虎嗅网（商业媒体）
- **商科相关**：**中高**（"商业消费""金融财经"频道直接对口；"前沿科技""车与出行"偏产业）
- **内容形态**：原创文章 + 聚合观点，非快讯
- **更新频率**：首页当日更新（样本文章为 2026-11-18 当天）

## 二、页面与技术形态

- **框架**：Nuxt 3（SSR），页面带 `__NUXT_DATA__`（devalue 序列化的索引数组，不是普通 JSON）
- **渲染**：首屏服务端渲染，正文无需 JS 也能拿到
- **风控**：**有**。首页正常；访问 `/channel/103.html` 后立刻跳到"滑动验证页面"（`.nc-container` 680×40，阿里系滑块）
- **登录**：阅读不强制登录；收藏/评论需要

## 三、数据源清单

| # | 类型 | 请求 / 位置 | 触发 | 返回 | 备注 |
|---|---|---|---|---|---|
| 1 | 内嵌 SSR 数据 | `<script id="__NUXT_DATA__">` | html_parse | 1405 字段 | 首页信息流全在里面：`home-index` → `focus` / `hotArticles` / `daily` / `momentList` / `sameChannel` / `viewpoint` 等 |
| 2 | 列表字段（内嵌） | 同上，文章对象 | — | `object_type` / `object_id` / `title` / `summary` / `pic_path` / `url` / `label` / `author_info` / `count_info` / `channel_info` | 每条都带详情页绝对 URL，如 `https://www.huxiu.com/article/4906401.html` |
| 3 | 频道清单接口 | `POST https://api-ms-article.huxiu.com/v1/channel/channelList` | page_load | 29 字段，14 个频道 | body `{"platform":"www"}`；频道含 `channel_id`（105 前沿科技、103 商业消费、115 金融财经…） |
| 4 | 搜索接口 | `POST https://api-article.huxiu.com/search/keyword` | page_load | 3 字段 | 关键词搜索入口 |
| 5 | 广告接口 | `POST https://api-ad-product.huxiu.com/Api/Product/SDK/Advert/Query/queryAdvertListInfo` | page_load | 56 字段 | 广告位数据，抓正文时要过滤 |
| 6 | 埋点/会话 | `POST https://api-ms-log.huxiu.com/v1/hx/session`、`/v1/hx/report` | page_load | 3 / 2 字段 | 与内容无关 |
| 7 | 消息状态 | `POST https://api-message.huxiu.com/message/getStatus` | page_load | 3 字段 | 与内容无关 |
| 8 | 站点静态 | `/manifest.json`、`s2-www.huxiucdn.com/_nuxt/builds/meta/hx-www-202611161450.json` | page_load | 27 / 5 字段 | 版本号可用来判断改版 |

## 四、探索记录（看到什么）

1. 打开首页：5631 字符正文、378 个链接，页面正常，无验证。
2. 网络捕获到 23 条数据源，其中真正有用的是 `__NUXT_DATA__`（含完整信息流）和 `channelList`。
3. 打开频道页 `/channel/103.html`：**立即变为"滑动验证页面"**（118 字符、0 链接，`请按住滑块，拖动到最右边`，TraceID `2f5e3b80…`）。
4. 由此确认：首页放行，栏目/翻页路径有风控。

## 五、结论：怎么抓最省事

- **推荐路径**：抓首页 SSR 的 `__NUXT_DATA__`，从 `home-index` 里取 `focus` / `hotArticles` / `daily` 的 `url` + `title` + `summary` + `channel_info`，再逐条打开详情页取正文。
- **正文位置**：详情页同为 Nuxt SSR，正文应在 `__NUXT_DATA__` 的文章对象内（本次未验证，因频道页被验证拦截）。
- **不要**：不要打频道页翻页接口，风控最先拦这里。
- **注意**：`__NUXT_DATA__` 是 **devalue 索引数组**（`["ShallowReactive",1]`、数字引用），不是标准 JSON，解析要按"数组下标解引用"处理。

## 六、待确认 / 风险

| 项 | 说明 |
|---|---|
| 详情页是否也触发滑块 | 未验证；若触发，需真实浏览器低频访问 |
| 频道列表接口是否要签名 | `channelList` body 只有 `platform`，未见签名；但频道页风控说明另有校验 |
| 正文完整性 | 部分深度文章可能分段/付费，需抽样确认 |
| 抓取频率 | 建议 ≥2 秒/次，避免触发滑块 |

## 七、对项目的意义

- 商科素材可用，但**风控等级中等偏高**，不适合放进"服务端定时全量爬"的第一批；
- 若接入，建议：只取首页信息流 + 详情页，放弃频道翻页；用真实浏览器通道（veddata/Playwright），不用裸 HTTP。

## 七、文章级验证（2026-11-18）

- **目标**：首页头条图链 `https://www.huxiu.com/article/4906426.html`
- **结果**：详情页直接跳到「滑动验证页面」——`body` 仅 **118 字符**，出现 `.nc-container` 680×40 滑块，TraceID `2f5e3b8017949719599833606e94c6`
- **结论**：**列表页可读，文章详情页被滑块验证拦截**，服务端抓正文不可行；需过验证方案或改用其他源（虎嗅的 RSS/合作接口）

## 八、深度复测（2026-11-18 11:36）

- `https://www.huxiu.com/article/4906426.html` 与 `https://m.huxiu.com/article/4906426.html` **都跳滑块验证**
- body 仅 118 字符，`.nc-container` 680×40，阿里云 captcha（`captcha-pro-open.aliyuncs.com`）
- `https://www.huxiu.com/rss/0.xml` 30 秒超时，RSS 通道也不可用
- 截图：`.scratch/huxiu-captcha-20261118_huxiu_20261118-113639.png`
- **结论：详情页服务端抓取不可行，列入待人工验证**

## 九、新会话复测：反转（2026-11-18 11:52）

- 重新开启浏览器会话后，**同一 URL 直接打开成功**：
  `https://www.huxiu.com/article/4906426.html`
- 页面标题《拖更两个月的GPT-6.2，居然是一个“汇报狂魔”？-虎嗅网》
- 整页正文 **5,158 字符 / 49 链接**，含 `#ai-summary` 摘要块，正文可读
- 说明：滑块是**会话/频控触发**，不是永久付费墙；新建会话或换出口 IP 重试即可
- **结论：可抓，但需带重试/换会话策略；不再列入待人工验证**

## 十、最终剔除（2026-11-18 12:02）

- 再次打开文章页，**又出现滑块验证**（body 118 字符，`.nc-container` 680×40）
- 用户手动拖动滑块，页面提示**“验证失败”**
- 此前 11:52 “新会话直接打开成功”是**一次性放行**，不可复现
- **结论：虎嗅详情页无法稳定抓取，从名单剔除**
