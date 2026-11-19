# 70 腾讯新闻·财经/产经

> 入口：https://news.qq.com/ch/finance/
> 摸底时间：2026-11-18
> 摸底方式：veddata 真实浏览器（首页 + 进入文章页）
> 状态：可用，**有明文 JSON 列表接口**

## 一、这是什么站

- **定位**：腾讯新闻财经/产经频道，企业新闻与热点公司事件传播快
- **主体**：腾讯新闻
- **商科相关**：**中高**（公司事件、产业动态；但以转载为主）
- **内容形态**：新闻流 + 专题 + 视频 + 热榜
- **更新频率**：分钟级

## 二、页面与技术形态

- **框架**：SPA + JSON feed（页面自身只渲染 1,569 字符，内容全靠接口）
- **渲染**：首页 1,569～1,726 字符 / 104～115 链接
- **风控**：无验证码；有登录入口（非强制）
- **广告**：`news.ssp.qq.com/ad`、`bon.qq.com`、京东联盟

## 三、数据源清单

| # | 类型 | 请求 / 位置 | 触发 | 返回 | 备注 |
|---|---|---|---|---|---|
| 1 | **内容列表** | `POST https://i.news.qq.com/web_feed/getPCList` | page_load | `data[]` 1,416 字段 | **核心源** |
| 2 | 频道字典 | `GET https://i.news.qq.com/getQNChannels` | page_load | 15,154 字段 | 全部频道 ID |
| 3 | 标签流 | `POST https://i.news.qq.com/getTagFeedList` | page_load | 3,450 字段 | 话题聚合 |
| 4 | 标签信息 | `GET https://i.news.qq.com/web_backend/v2/getTagInfo` | page_load | 1,109 字段 | 标签元数据 |
| 5 | 收藏/合集 | `GET https://i.news.qq.com/web_feed/getCollectionArticles` | page_load | 908 字段 | 专题 |
| 6 | 文章页 | `https://news.qq.com/rain/a/<id>` | 点击 | HTML | 正文 |

**getPCList 请求体**（实测）：

```json
{
  "base_req": { "from": "pc" },
  "forward": "2",
  "qimei36": "<cookie 里的设备 ID>",
  "device_id": "<同 qimei36>",
  "flush_num": 1,
  "channel_id": "news_news_finance",
  "item_count": 12,
  "is_local_chlid": "0"
}
```

返回每条：`id` / `articletype` / `title` / `publish_time` / `pic_info` / `link_info.share_url`（= `https://view.inews.qq.com/a/<id>`）/ 互动数。

## 四、文章级验证（真实进入）

- **文章**：《发生了什么？黄金突遭猛烈抛售，金价跌破3800美元创14个月新低》
- **URL**：`https://news.qq.com/rain/a/20261118A0762700`
- **正文**：**3,107 字符 / 53 链接**（含导航），正文约 2,300 字
- **时间**：2026-11-18 10:43
- **来源**：FX168 财经网（转载）
- **付费墙/登录**：无
- **结论**：文章页正文完整；列表接口是这批里最干净的 JSON 之一

## 五、结论：怎么抓最省事

- 直接打 `getPCList`，按 `channel_id` 切频道（财经=`news_news_finance`，产经需在 `getQNChannels` 里查）；
- 用 `flush_num` 翻页；文章页走 `news.qq.com/rain/a/<id>`；
- **建议**：**P1** 接入（接口最省事），但转载多，入库保留 `来源`

## 六、待确认 / 风险

| 项 | 说明 |
|---|---|
| device_id | 来自 cookie（`RK`/qimei），需先访问首页取 |
| 翻页参数 | `flush_num`/`forward` 需实测上限 |
| 转载比例 | 高，原创少 |
| 广告 | 多，需过滤 |
