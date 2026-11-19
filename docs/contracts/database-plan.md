# 数据库方案：为什么现在不迁 PostgreSQL

> 本文回答一个问题：M1 校内网页版要不要把 SQLite 换成 PostgreSQL。
> 结论：**不换。改用「单写者 + 采集回传」架构。** 迁 PG 留作 M2 的可选项，触发条件见第五节。
> 版本：v1 · 2026-11-19　（原计划里的「任务 D：SQLite → PG 迁移工具」据此改为「数据库架构调整」）

---

## 一、先说结论与理由

### 换 PG 的真实成本（不是换个驱动）

| 事实 | 数字 |
|---|---|
| 现有 DAL 用的是 `node:sqlite`（**同步 API**） | `packages/db/src/index.ts:2,816,831` |
| DAL 里的同步调用点 | **280 处**（`.prepare / .exec / .transaction`） |
| DAL 里 `async` 方法 | **0 个** |
| 依赖 DAL 的文件 | **21 个**（agent、profile、artifacts、dispatch、scripts…） |

`node-postgres` 是**异步**的。换库意味着 280 处调用点全部变成 `await`，
21 个文件的调用链跟着变成 async——包括 `packages/agent` 里判题、学情、记录器这些有 15 个断言守着的地方。
**这是 2–4 周的重构，不是 2–3 天的迁移脚本。**

### 而写入量根本不需要 PG

按 40 人、每人每天 20 轮、每轮 8 次写估算：

```
40 × 20 × 8 = 6400 次写/天 ÷ 8 小时 ≈ 0.22 次/秒
```

SQLite WAL 单进程写入能轻松到每秒数千次。**我们连零头都用不到。**

真正会撞锁的不是「人多」，而是「两个进程同时写同一个文件」——那是采集服务与应用的冲突，
用架构隔离解决，不需要换数据库。

---

## 二、真正的方案：单写者 + 采集回传

### 2.1 一个原则

> **一个 SQLite 文件，只允许一个进程写。**

| 进程 | 权限 | 说明 |
|---|---|---|
| 应用服务（Node） | **唯一写者** | 学情、题目、会话、产物、新闻入库都经它写 |
| 采集服务（Python） | **不直接写库** | 抓到的文章 POST 回应用服务，由应用写 |

这样彻底消除 `SQLITE_BUSY`，也消除「两边 schema 演进不同步」的风险。

### 2.2 采集回传接口（新增，给采集服务用）

```
POST /internal/news/ingest
Header: X-Internal-Token: <服务间共享密钥>
Body: { articles: NewsArticle[], run: { source, status, fetched, inserted, updated, skipped, errors, failures[] } }
返回: { inserted, updated }
```

- 只在服务间调用，**不对公网暴露**（绑定内网地址或走 unix socket）。
- `run` 记录写进 `source_runs`，保证采集统计不丢。
- Python 侧只需把现在 `db.upsertNews(...)` 换成 `httpx.post(...)`，改动很小。
- 好处：采集服务可以搬到另一台机器，甚至可以多实例（都回传给同一个应用）。

### 2.3 为什么不在 Python 侧开只读

能读不能写也可以，但**不建议**：
- 只读连接也要处理 WAL checkpoint 与 schema 版本；
- 采集侧本来就要读「已有 url 去重」，这个判断交给应用更准（应用有完整的业务表）；
- 一个写者 + 一个回传接口，边界最清楚。

### 2.4 应用侧要做的三件事

1. **写队列**：`node:sqlite` 是同步的，单进程内天然串行，但**事务要包在一起**。
   现在多处是「先 insert 消息、再 insert turn、再 update 状态」三条独立语句——服务端要包成事务，
   否则进程被重启会留下半条记录。
2. **`busy_timeout` 保留**：`packages/db/src/index.ts:834` 已有 `busy_timeout = 5000`，保持。
3. **备份**：用 `VACUUM INTO 'backup.db'` 或 `db.backup()`，不要直接复制文件（WAL 模式下会拷到不完整状态）。

---

## 三、M1 的验收判据（数据库部分）

| 判据 | 怎么验 |
|---|---|
| 40 人并发不出现 `SQLITE_BUSY` | 压测脚本跑 40 并发 × 10 轮，统计错误码 |
| 采集与应用不同时写 | 检查 Python 侧代码里不再有 `upsertNews`/`INSERT INTO` |
| 事务完整 | 强制杀掉进程后重启，`chat_messages` 与 `chat_turns` 不出现孤儿 |
| 备份可恢复 | 备份文件能在全新 home 里打开并通过 health 自检 |

---

## 四、如果将来确实要迁 PG（M2 之后）

### 4.1 触发条件（满足任一条才做）

1. 需要**多实例部署**（负载均衡 / 多台服务器）——SQLite 无法共享；
2. 写入稳定超过 **1000 次/秒**；
3. 老师端需要**跨班复杂分析**（多表聚合 + 窗口函数），且 SQLite 版本已明显变慢；
4. 学校要求「数据库必须是独立服务 + 具备行级权限」。

**注意**：仅仅「人多」不是理由（见第一节的写入量估算）。

### 4.2 迁移路线（降低一次性风险）

```
第 1 步：把 DAL 抽成接口（读/写方法签名不变，实现可替换）
第 2 步：实现 PG 版 DAL（async），先只跑测试，不接业务
第 3 步：双写影子库一段时间（SQLite 为主，PG 只写不读），比对结果
第 4 步：切换读，主写仍 SQLite
第 5 步：切换写，SQLite 退为备份
```

**不要一步切换**：21 个文件、280 个同步调用点，一次性改完没人能保证行为不变。

### 4.3 类型映射（届时照这个来）

| SQLite（现状） | PG 建议 | 说明 |
|---|---|---|
| `TEXT` 主键（如 `kp_001`） | `text` | **保持 text**，不要换 uuid——会打断所有外键与既有数据 |
| `INTEGER` | `integer` | 行数不会超过 21 亿 |
| `REAL` | `double precision` | |
| ISO 时间戳存 `TEXT` | **先用 `text`** | 现有代码用字符串比较排序（`ORDER BY published_at DESC`），ISO 8601 的字典序等于时间序，保持 text 零风险 |
| `*_json` 存 `TEXT` | **先用 `text`** | ⚠️ 改成 `jsonb` 后 node-postgres 返回**对象而不是字符串**，所有 `JSON.parse(row.x_json)` 会炸。要么全改 DAL，要么保持 text |
| 布尔（0/1 `INTEGER`） | **保持 `integer`** | 改成 `boolean` 后 `=== 1` 全失效 |
| `STRICT` 表 | 去掉 | PG 本身严格 |

### 4.4 迁移坑清单（都是会真的踩到的）

1. **`LIKE` 大小写**：SQLite 的 `LIKE` 对 ASCII 不区分大小写，PG 区分 → 关键词检索要改 `ILIKE` 或 `lower()`。
2. **`GROUP BY` 严格**：PG 要求所有非聚合列出现在 `GROUP BY` 里，SQLite 宽松。
3. **`LIMIT` 参数类型**：node-postgres 传字符串会报错，必须 `parseInt`。
4. **`INSERT OR REPLACE`** → 改 `ON CONFLICT ... DO UPDATE`（现有 `upsertNews` 已经是后者，没问题）。
5. **`PRAGMA journal_mode / busy_timeout`** → 删掉，改用连接池与事务。
6. **同步 → 异步**：最贵的一项，见 4.2 的分步路线。
7. **`node:sqlite` 的 `DatabaseSync` 事务**（`BEGIN/COMMIT`）→ 改成 `pool.connect()` + `client.query('BEGIN')`。

### 4.5 PG 参考 DDL（关键表，示意）

```sql
-- 课程内容（只读为主）
CREATE TABLE chapters (
  id text PRIMARY KEY,
  number integer NOT NULL,
  title text NOT NULL,
  source_path text NOT NULL
);

CREATE TABLE knowledge_points (
  id text PRIMARY KEY,
  chapter_id text NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  section_id text NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  name text NOT NULL,
  definition text NOT NULL,
  keywords_json text NOT NULL DEFAULT '[]',   -- 见 4.3：先保持 text
  examples_json text NOT NULL DEFAULT '[]',
  difficulty integer NOT NULL DEFAULT 2,
  source text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  parent_id text
);
CREATE INDEX knowledge_points_by_chapter ON knowledge_points(chapter_id);

-- 新闻（采集回传后写入）
CREATE TABLE news_articles (
  id text PRIMARY KEY,
  source text NOT NULL,
  title text NOT NULL,
  url text NOT NULL,
  published_at text NOT NULL,
  summary text NOT NULL DEFAULT '',
  content text NOT NULL,
  content_status text NOT NULL,
  fetched_at text NOT NULL
);
CREATE UNIQUE INDEX news_articles_by_url ON news_articles(url);
CREATE INDEX news_articles_by_published ON news_articles(published_at DESC);

-- 学情（写入最频繁）
CREATE TABLE chat_messages (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role text NOT NULL,
  content text NOT NULL,
  created_at text NOT NULL
);
CREATE INDEX chat_messages_by_session ON chat_messages(session_id, created_at);
```

其余 30 余张表按 `packages/db/src/index.ts` 的 DDL 一一对应即可（类型映射见 4.3）。
**建议用脚本从现有 DDL 生成，不要手抄**——手抄必漏索引。

---

## 五、结论摘要（给服务端实现者）

1. **不迁 PG**。用「应用服务独占写 learning.db + 采集回传」。
2. 采集服务删掉所有直写库的代码，改成 `POST /internal/news/ingest`（带内部 token）。
3. 应用侧把「多语句写入」包成事务。
4. 备份用 `VACUUM INTO`，不要复制文件。
5. 迁 PG 的触发条件写在第四节 4.1；真要做，按 4.2 分五步，不要一次切。
