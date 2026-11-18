# 新增新闻源适配器规范（Python 后端）

> 适用范围：`services/news-crawler-py`。一个源 = **一个文件**，只写自己的文件，
> 不改任何共享文件。这是 40+ 源能并行开发的前提。

## 1. 一个源的最小形态

`src/news_crawler/sources/<source_id>.py`：

```python
from __future__ import annotations

from ..html import clean_text, first_html, html_to_text, page_date, page_summary, page_title
from ..models import (
    RawArticle,
    RawListItem,
    RawPage,
    SourceCapabilities,
    SourceDescriptor,
    SourcePolicy,
)
from .base import NewsSource, soup_of


class FooSource(NewsSource):
    async def list_page(self, cursor: str | None) -> RawPage:
        html = await self.http.get_text(self.id, self.descriptor.entry)
        soup = soup_of(html)
        items: list[RawListItem] = []
        for node in soup.select("列表选择器"):
            href = str(node.get("href") or "")
            ...
            items.append(RawListItem(source_id="稳定id", url=absolute, title=title))
        return RawPage(items=items, next_cursor=None)

    async def fetch_detail(self, item: RawListItem) -> RawArticle:
        html = await self.http.get_text(self.id, item.url)
        soup = soup_of(html)
        content_html = first_html(soup, (".article-content", "#content"))
        return RawArticle(
            source_id=item.source_id,
            url=item.url,
            title=page_title(soup, item.title),
            author=...,
            published_at=page_date(soup, item.published_at),
            summary=page_summary(soup, item.summary),
            content=html_to_text(content_html),
            content_html=content_html,
        )


DESCRIPTOR = SourceDescriptor(...)
ADAPTER = FooSource
```

**sourceId 规则**（与 `plans/0.2.0/news-ingest-protocol.md` 一致）：小写字母/数字/连字符，2–32 位，
**多词用连字符**：`sina-finance`。Python 模块名不能带连字符，所以**文件名 = sourceId 把 `-` 换成 `_`**：
`sina-finance` ↔ `sources/sina_finance.py`。发现器会校验两者一致，不一致直接报错。
已有的 8 个源（socialbeta / yicai / jiemian / nbd / brandstar / latepost / eeo / stcn）已迁移完毕，不要改。
数字开头的站名要改写：36 氪 → `kr36`，163 财经 → `money163`。

## 2. DESCRIPTOR 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✔ | 稳定 sourceId，与文件名一致，**入库后不可改**（DB `source` 列、统计、AI 调用都靠它） |
| `name` | ✔ | 中文展示名，如「第一财经」 |
| `group` | ✔ | 见下表枚举 |
| `homepage` | ✔ | 站点首页 |
| `adapter` | ✔ | `html-list` / `json-list` / `rss` / `spa-json` 之一，描述「列表从哪来」，不是实现细节 |
| `entry` | ✔ | 真正拿列表的 URL（频道页或接口），必须 `https://`（站点仅 http 时写 http 并在 note 说明） |
| `pagination` | ✔ | `none` / `page`（页码 cursor）/ `cursor`（接口给的游标） |
| `capabilities` | ✔ | `requires_browser`、`anti_crawler`、`auth`、`content_mode`（`full`/`summary`）、`supports_pagination` |
| `policy` | ✔ | 见第 3 节 |
| `language` | | `zh`（默认）/ `en` |
| `enabled` | | 默认 `True`；接不进来的源写 `False` |
| `note` | | `enabled=False` 的**必填**，一句话写死原因和日期 |

`group` 枚举：`industry`（行业动态）`case`（营销案例）`data`（数据/研究/趋势）
`finance`（财经媒体）`official`（官方机构数据）`consulting`（咨询/商学院）
`ecommerce`（电商/跨境）`portal`（综合门户财经）`brandnews`（企业/品牌动态）。
`group` 会写进入库行的 `section`，不要自造新值。
导出到入库注册表（`news-ingest/v1` 的 `group` 只有 5 个值）时的映射：
`industry→news`、`finance→news`、`portal→news`、`case→marketing`、`brandnews→marketing`、
`data→data`、`consulting→data`、`official→official`、`ecommerce→vertical`。

## 3. 每源 policy（默认值，按站点调整并写理由）

| 字段 | 含义 | 常规值 |
|---|---|---|
| `interval_s` | 该源自己的循环间隔 | 门户/快讯 300–600；日报 900–1800；研究/咨询机构 6–24h |
| `detail_concurrency` | 该源详情并发 | 默认 2；runner 对非 anti 源至少抬到 4；有风控/重置的站设 1（如 nbd） |
| `min_interval_ms` | **仅 anti-crawler 源生效**的请求间隔 | 普通源忽略；anti 源默认 1000，NBD/证券时报可 500，不得低于 500 |
| `timeout_s` | 单请求超时 | 30；慢站 20–30 |
| `retries` | 重试次数 | 1；被重置/限流的站 0–1 |
| `max_items` | 单轮候选上限 | 30–200（首跑回填另开 `--unlimited`） |
| `max_pages` | 单轮最多翻几页 | 无分页 1；有分页 3–10 |

普通源**没有每请求固定间隔**：列表页一次拿一批地址，详情按 `detail_concurrency` 并发，解析一条入库一条。
只有风控明确的站才设 `capabilities.anti_crawler=True`，此时 `min_interval_ms` 才作为 opt-in gate 生效（例如 NBD 还需 `detail_concurrency=1`）。
**不要**在 adapter 里 `asyncio.sleep` 或自己限速：失败重试、退避、验证页识别都在 `http.py` 里做。

## 4. 硬性约束

1. **只用自己的文件**。禁止修改 `registry.py`、`sources/__init__.py`、`sources/base.py`、
   `models.py`、`db.py`、`output.py`、`runner.py`、`cli.py`、`http.py`、`html.py`、
   `normalize.py`、`pyproject.toml`，禁止动 `packages/news/**`（TS 前端与 Electron）、禁止 git 操作。
2. 需要共享小工具时新建 `sources/_util.py` 这类 `_` 前缀模块（发现器会跳过）。不新增第三方依赖。
3. 所有请求走 `self.http.get_text / get_json / post_json`，**不允许直接用 httpx/requests**，
   否则绕过每源限速与验证页识别。
4. `list_page` 里出错就**直接抛**（runner 会记 list 失败、不影响其它源）；`fetch_detail`
   里出错也直接抛（runner 逐条隔离）。不要在 adapter 内 `try/except` 把所有异常吞成空列表——
   那会让「抓不到」伪装成「没更新」。
5. `RawListItem.source_id` 用该站稳定 id（文章 id/path 段），不要用自增序号或时间。
   URL 归一、去重、canonical 已由 `normalize.py` 处理，adapter 只给原始绝对 URL。
6. 正文取 `content`（纯文本，`html_to_text`）；同时回填 `content_html` 方便排障。
   拿不到正文就只给 `summary`：短稿也是消息，`normalize` 会在正文不足时用 summary 兜底。
7. 分页：页码从 `page=2` 起递增，`next_cursor` 给下一页号；没有下一页返回 `None`。
   若翻到重复内容或空页，直接 `next_cursor=None`。
8. 不要伪造成功：站点确实抓不到（付费墙/登录墙/必须浏览器/证书坏）→ `enabled=False` + `note`，
   并在汇报里列为「未接入」。

## 5. 验证（每个源都要做，这是验收）

```powershell
cd E:\Documents\GitHub\YingXiaoShang\services\news-crawler-py
..\..\.venv\Scripts\python.exe -m news_crawler list-sources          # 能看到自己的 sourceId
..\..\.venv\Scripts\python.exe scripts\live_check.py --source <id> --source <id2> --min-items 5
..\..\.venv\Scripts\python.exe -m news_crawler crawl --source <id> --max-items 10 `
    --output .scratch\<id>.jsonl --db .scratch\<id>.db
..\..\.venv\Scripts\python.exe -m ruff check src\news_crawler\sources\<id>.py --fix
..\..\.venv\Scripts\python.exe -m pytest -q
```

通过标准：`live_check` 里该源 `status` 为 `success`，`ok>=5`（至少 5 条真实入库），
正文中位数 ≥300 字符（快讯/短稿型源明确在 `note`/汇报里说明，`ok>=5` 即可）；
`crawl` 的 JSONL 每行都带真实 `url` 与 `title`；同一源连跑两次，第二次应为 `inserted=0 或少量, skipped 多`
（增量去重生效）。

## 6. 逐站资料

`plans/0.2.0/news-sources/NN-*.md` 是逐站实测记录（入口、分页、正文容器、反爬、样本 URL），
先读对应那篇再动手；`news-source-pool.md` 第七节有每源可用的文章样本 URL。
文档与实测冲突时以**实测**为准，并把差异写进汇报。
