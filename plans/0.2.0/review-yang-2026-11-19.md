# 杨泽易提交审查（2026-11-19，main @ d76d8f1c）

> 审查对象：`91f9aaa...d76d8f1c` 共 9 个提交、252 个文件。
> 审查方式：GitHub API 读 compare 与关键文件原文（本地 `git fetch` 因网络失败），
> 结论只对本文件列出的证据负责；未运行他的代码（本地无 Python venv）。
> 分级沿用 `review-kit.md`：P0 会挂住/错交付、P1 明显退化或误导、P2 收敛与维护。

---

## 一、总判断

**方向对，不能直接发交付包。**

两条线各自都有真实产出：

- **Python 新闻采集服务**（86 文件、40+ 源）：架构清楚，WAL + `busy_timeout` 都做了，
  有控制面 HTTP API、查询门面、bench 报告、20+ 份逐站探测记录。**这正是服务端阶段要的东西。**
- **Electron 自动化测试框架**（56 文件）：六层结构、依赖台账、隔离 home/userDataDir、
  证据链（meta/log/ipc/windows/close/db + 失败截图与 DOM）、明确禁止 `waitForTimeout`。
  **这是目前仓库里质量最高的一块工程基建。**

但有一个 P0：**桌面交付包会退化成「新闻联网不可用」**（见 P0-1）。在修掉之前，
不能基于现在 main 出新的学生包。

**更正（2026-11-19 复核后）**：本文件初版曾写「30 条 spec 是 0 字节空文件」，**这是错的**。

实测：`find tools/automated-testing/src/scenarios -name "*.spec.ts" -size 0 | wc -l` → `0`；
31 个 spec 全部有内容（最小 1414 字节），每个含 15–29 条 `expect(`。

**我为什么会判错**：当时 `raw.githubusercontent.com` 连接失败，`curl` 输出 0 字节，
我把「网络失败」当成了「文件为空」；GitHub compare API 对 252 个文件的 diff 也省略了 patch
（`additions: 0`），我据此二次误判。这是把工具失败当成事实的典型错误，已写进 review-kit。

**真实结论**：31 条用例都写了断言、引用了依赖台账，**但没有任何证据表明它们跑过**
（本地没有 Electron 测试环境）。准确表述是「已编写、未运行验证」，不是「空的」也不是「做完了」。

---

## 二、P0

### P0-1 桌面端新闻联网依赖仓库根 `.venv`，而打包不含它

- **位置**：`apps/desktop/src/main/news-backend.ts:60-90`、`packages/news/src/index.ts` 的 `request()`（现 :379）
- **事实**：
  - `findExecutable()` 只认三处：`NEWS_CRAWLER_PYTHON` 环境变量、
    仓库根 `.venv/Scripts/news-crawler.exe`、`.venv/Scripts/python.exe`。
  - `findServiceDir()` 找的是 `services/news-crawler-py/pyproject.toml`。
  - 两者都不存在时：`console.warn` 后**返回 url**（不抛错，启动不失败）。
  - `NewsService` 已改成纯 HTTP 客户端，`request()` 在 fetch 失败时直接抛错。
  - `electron-builder.yml` **本次未改动**（compare 里没有这个文件）→ 打包不会带
    `services/` 与 `.venv`。
- **后果**：学生机器上（解压即用的包）
  1. 本地新闻检索仍可用（`listNews` 走 SQLite，不受影响）
  2. **联网补抓全部失败**：`search_news` 会走到 catch，学生看到「联网补抓失败」或只有本地旧闻
  3. 30 分钟定时刷新同样失败（已被 try/catch 兜住，只会打 warn）
- **为什么算 P0**：这正是学生最常感知的路径（查最新新闻），且**当前交付包一旦换 main 就静默降级**。
- **修法（二选一，推荐 a）**：
  - **a. 桌面端保留一条不依赖 Python 的联网路径**：`searchAndIngest` 在 Python 服务不可用时，
    退回调用 DeepSeek Search API（实测 0.3–0.5 秒、自带正文），完全不碰爬虫。
    Python 服务只在服务端部署时使用。改动小，且保住「解压双击即用」。
  - b. 把 Python + venv 打进 Electron 包：体积 +50 MB 以上，跨机器 Python 环境脆弱
    （缺 VC 运行库、路径含中文、杀软误报），不建议。

---

## 三、P1

### P1-1 本地检索的正文门槛从 300 字降到 40 字（未随附质量标注）

- **位置**：`packages/agent/src/tools/read-tools.ts:436/439`（300 → 40）
- **为什么改**：Python 批量采集时很多条目正文不足 300 字，保持 300 会让它们不可见。
- **风险**：40 字的片段被当成「新闻正文」喂给模型，模型可能据此讲细节——
  这正是我们此前判定为「拿碎片当材料」的失败模式。
- **建议**：门槛保留 40，但工具结果里必须带 `content_status`（full/partial），
  并在结果头写清「以下 N 条中 M 条只有摘要」。模型才知道哪些只能当线索。

### P1-2（已降级为 P2）31 条用例均未验证「能跑通 / 能变红」

- **位置**：`tools/automated-testing/src/scenarios/`（31 个文件）
- **事实**：每个文件都有 15–29 条 `expect(`，都引用了 `dependencies.ts` 的实现侧 ID，
  质量看上去是一致的（`p0-01` 的 home 隔离、DB pragma、种子库计数写得尤其清楚）。
- **不知道的事**：**本机没有 Electron 测试环境，31 条一条都没跑过**。
  所以「能跑通」与「能变红」都未验证——这两件事才是「测试做完」的定义。
- **验收标准要写死**：一条用例算「完成」= 跑得起来 + 在实现被改坏时能变红 +
  `.artifacts/report.md` 里有它的结果。只有断言、没跑过，算「已编写未验证」。

> 这条从 P1 降为 P2：错误在我（见上方更正），不在他的交付。

### P1-3 SQLite 双写：桌面端与 Python 服务同写一个 `learning.db`

- **事实**：Python `db.py:71-72` 用 `journal_mode=WAL` + `busy_timeout=5000`；
  Node `packages/db/src/index.ts:833-834` 也是同样的设置。**两边都做对了**，
  这比裸 Concurrent 写安全得多。
- **残留风险**：Python 8 workers 同时入库时持有写锁，桌面端此时提交学习记录
  可能等满 5 秒后报 `SQLITE_BUSY`（学生看到「本地数据写入失败」）。
- **建议**：① Python 只写 news 相关表；② 桌面端启动时不要立刻 refresh；
  ③ 服务端部署时把「采集写库」与「应用读库」拆成两个库或两个实例。

---

## 四、P2

| 位置 | 问题 | 建议 |
|---|---|---|
| `package.json` | 删掉 `pipeline:news` 脚本，同时删了 `pipeline/ingest-news.ts` | 确认没有别的脚本引用；`verify-doc-refs` 要重跑 |
| `services/news-crawler-py` | 86 文件 / 40+ 源，单人维护成本高 | 源分级：核心 8 个必须活，其余「尽力而为」，失败只记 partial |
| `docs/requirements/R07-news.md` | 改了 33+/39- | 与代码再对一遍行号（`verify-doc-refs.py`） |
| 仓库流程 | 9 个提交**直接推 main**，无 PR、无独立复核 | 见《给杨泽易的分工建议》第三节 |

---

## 五、他提的设计建议，我认同的部分

> 「入库的时候其实可以不用 LLM 来打标签吧 / 我们应该人工先给所有知识点打好 tag /
> 然后这些 tag 做候选，用一个分类器就能分」

**这个判断是对的，建议采纳**，理由：

1. **知识点是封闭集合**（228 个 kp、13 章），本质是分类问题，不是生成问题。
2. **LLM 打标三个硬伤**：每篇一次调用（成本随文章数线性涨）、同一篇两次结果不同（不可复现）、
   判错时无法审计（说不清为什么打这个标）。
3. **人工打标只需做一次**：228 个 kp 的 tag 体系建好后，新文章用分类器打分，可批量、可复现、可回滚。
4. **落地顺序**：先做**章节级**（13 类，成本极低、准确率高），跑稳后再细化到知识点级。
   一步到位做 228 类，标注成本会把项目拖死。

需要补一条：分类器要**可解释**（给出命中词/相似度），否则老师问「为什么这篇算第 7 章」
答不上来。

---

## 六、结论与动作

| 动作 | 谁 |
|---|---|
| 修 P0-1（桌面端保留 DeepSeek Search 兜底路径） | 我方 |
| 把 300→40 的改动补上 `content_status` 标注 | 我方（小改） |
| 跑通 31 条用例，并按「必须能变红」验收（先 5 条） | 杨泽易 |
| 采集服务只用于服务端部署（M2），不塞进 Electron 包 | 杨泽易 + 我方约定 |
| 后续改成分支 + PR，至少一次独立复核再合 | 杨泽易 |
| 人工打标 + 分类器方案写进 `decisions.md` | 我方 |

**在新包发出前，必须完成 P0-1 与 P1-1。** 其余可以并行。
