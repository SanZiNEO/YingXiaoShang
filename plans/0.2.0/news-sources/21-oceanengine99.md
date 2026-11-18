# 21 巨量99

> 入口：https://99cases.oceanengine.cc/
> 摸底时间：2026-11-18
> 摸底方式：veddata（真实浏览器 + 网络捕获）
> 状态：**可用，Vue SPA + 明文 JSON 接口**

## 一、这是什么站

- **定位**：巨量引擎（抖音）官方"99 个好案例"案例库，覆盖 20+ 垂直行业
- **主体**：巨量引擎（字节跳动广告平台）
- **商科相关**：**极高**（抖音生态营销、短剧营销、品牌种草、效果广告，都是当下教学热点）
- **内容形态**：案例（图文/视频/方法论）+ 精选专题 + 获奖案例
- **更新频率**：不定期（专题更新为主）

## 二、页面与技术形态

- **框架**：Vue SPA（`__VUE_HMR_RUNTIME__`、`__VUE_DEVTOOLS_HOOK_REPLAY__`）
- **渲染**：首屏 HTML 只有 1622 字符、9 链接，内容全靠接口
- **风控**：无验证码；有 `JSESSIONID` cookie
- **登录**：不需要

## 三、数据源清单

| # | 类型 | 请求 / 位置 | 触发 | 返回 | 备注 |
|---|---|---|---|---|---|
| 1 | **首页案例接口（核心）** | `POST https://99cases.oceanengine.cc/case/newApi/home/list` | page_load | **473 字段** | `data[]` → `detailList[]`：`caseId / caseName / industryType / marketingScenarios / preface / pcCover / fileUrl` |
| 2 | 关键词接口 | `POST /case/newApi/newCase/keywordList` | page_load，2 次 | 8 字段 | 搜索热词 |
| 3 | 专题菜单 | `POST /case/newApi/specialTopic/nodeTopicMenu` | page_load | 58 字段 | 精选专题结构 |
| 4 | 图片资源 | `wicresoft99.oss-cn-hangzhou.aliyuncs.com` | — | OSS 直链 | 案例封面/素材，带签名 Expires |

## 四、探索记录

1. 打开 `99cases.oceanengine.cc`：跳转到 `/index`，页面正常。
2. 首屏 1622 字符——典型 SPA，正文不在 HTML。
3. 抓到 3 个 `/case/newApi/...` POST 接口，全部明文、无签名（只有 session cookie）。
4. `home/list` 返回结构里直接带 `industryType`（互动影视）、`marketingScenarios`（短剧营销），**分类现成**。

## 五、结论：怎么抓最省事

- **推荐路径**：调 `home/list` 拿案例卡（caseId/caseName/行业/场景）→ 按 caseId 打开详情；
- **优势**：官方案例、结构化分类（行业 × 营销场景），比媒体二手案例更准；
- **注意**：图片在 OSS 带签名过期，抓文字为主；视频案例只有链接。

## 六、待确认 / 风险

| 项 | 说明 |
|---|---|
| 是否有分页参数 | `home/list` 未见 page 字段，可能首页只给固定批 |
| 详情页接口 | 未捕获（caseId 拼详情页需再试） |
| 更新频率 | 专题制，低频；适合按月轮询 |
| 版权 | 官方公开案例，引用需注明巨量引擎 |
