# 05 · 写作执行手册（派给子代理时逐字带上）

> 你在为「营小商服务端 / 客户端拆分」的某一轮写细化文档。目标不是写散文，而是让另一个主代理拿着你的文档就能派工、让实现者照着就能写代码、让验收者照着就能判过。

## 0. 环境与路径（先确认，再干活）

| 项 | 值 |
|---|---|
| 仓库根 | `E:\Documents\GitHub\YingXiaoShang` |
| 本 plan | `E:\Documents\GitHub\YingXiaoShang\plans\server-client-split` |
| 你的轮次目录 | `<plan>/<A..I>-*/`（例：`plans\server-client-split\A-server-core`） |
| 执行环境 | 本地 Windows（PowerShell 7）。**先用 `Test-Path E:\Documents\GitHub\YingXiaoShang` 确认**；路径不存在就停下来报告，不要改写到别的盘或别的目录 |

## 1. 开工前必读（按顺序，别跳）

1. `plans/server-client-split/00-master/01-frozen-contracts.md` —— 契约口径，你的文档不能与它冲突。
2. `plans/server-client-split/00-master/02-ownership-and-parallel.md` —— 你能写哪些路径。
3. `plans/server-client-split/00-master/03-references.md` —— 可引用的外部链接。
4. `plans/server-client-split/00-master/04-doc-template.md` —— 你要写的 4 份文档的骨架。
5. 你这一轮的 `README.md` —— 原始需求（**不要改写它**，它是验收基线）。
6. 相关源码（见 §2）。

## 2. 调查源码：必须落到「路径:行号」

写任何「现状是这样」的判断前，先证明：

```powershell
# 找定义
Select-String -LiteralPath "apps\desktop\src\main\index.ts" -Pattern "case 'news.list'" -Context 0,6
# 找调用方
Select-String -Path "apps\desktop\src\renderer\src\*.tsx" -Pattern "'news.list'"
```

每份文档的 `## 3 真实依据` 至少给出 **6 条** `路径:行号`，每条写清「这段代码现在做什么 / 为什么会阻塞本轮目标」。
行号必须是你当场查到的；写之前再核对一次（文件可能被别的轮次改过——只读文件一般不会）。

**本轮的必读源码清单**

| 轮次 | 必读 |
|---|---|
| A | `apps/desktop/src/main/index.ts`（`invoke` 全量）、`preload/index.ts`、`main/errors.ts`、`main/health.ts`、`packages/agent/src/index.ts:44-116`、`packages/agent/src/team.ts:17-35`、`packages/db/src/index.ts:92-448` |
| B | `services/news-crawler-py/src/news_crawler/db.py`、`models.py`、`normalize.py`、`query.py`、`.scratch/*.db`（抽样看数据）、`docs/QUERY-API.md` |
| C | `services/news-crawler-py/pyproject.toml`、`.gitignore`、`src/news_crawler/cli.py`、`http_api.py:38-39`、`README.md` §1-§3 |
| D | `packages/db/src/index.ts:92-448`（全部 `CREATE TABLE`）、`pipeline/seed-db.ts`、`apps/desktop/src/main/index.ts:71-81`（seed 复制） |
| E | `tools/automated-testing/src/client/learning-client.ts`、`chat-events.ts`、`scenarios/dependencies.ts`、`src/scenarios/p0-*.spec.ts`（抽样 3 条） |
| F | `apps/desktop/src/main/llm.ts`、`packages/agent/src/tool-loop.ts`、`apps/desktop/src/main/health.ts`、`01-frozen-contracts.md` §9 |
| G | `scripts/package-desktop.mjs:52-58`（`VACUUM INTO` 用法）、`docs/requirements/R17-local-data.md` §4、`01-frozen-contracts.md` §10.5 |
| H | `tools/automated-testing/src/scenarios/p0-03/06/08*`、`p1-02/03*`、`src/driver/*`、`README.md` §「编写约束」 |
| I | `apps/desktop/src/renderer/src/renderers.tsx`（回答/题目/学情长什么样）、`docs/requirements/R16-conversation-ui.md` |

## 3. 搜外部参考：一次一个词，用通用词

工具：`magpie` 连接器的 GitHub MCP（`mcp__magpie__github_search_repositories` / `_search_code`），以及官方文档站。

规则：

- **一次只传一个关键词**，不要 `a b c` 拼五六个词。
- **不要带领域限定**（不要写 education / marketing / course / 教学 / 商科）。这个领域没人做过，限定越多越搜不到可借鉴的形态。
- 好词：`openapi`、`jsonrpc`、`sse`、`compose`、`dockerfile`、`loadtest`、`backup`、`pgloader`、`stryker`、`sqlite`、`postgres`、`oauth`、`logging`、`histogram`、`contract`、`fixture`。
- 每个轮次至少**自己再搜 2 次**（不能只吃 `03-references.md` 的现成饭）；把结果里真实存在的 URL 记下来。
- 引用格式：`[Rn] 名称 — URL — 支撑哪一节 — 借鉴什么/不照搬什么`。**URL 必须是你从工具结果里复制的**，不许手打记忆里的地址。
- 搜不到就如实写：「该形态在公开仓库中未找到同类实现，以下为自定方案，风险见 §7」——不要编。

## 4. 写文档：顺序与依赖

1. 先写 `01-scope.md`（把边界和产物钉死）。
2. 再写 `02-contract.md`（把字段、错误、事件写死；这里最容易返工）。
3. 再写 `03-implementation.md`（对着契约写实现，不要偷偷改契约）。
4. 最后写 `04-acceptance.md`（对着契约写验收；每条 AC 必须能追到某个契约点）。
5. 四份都写完，跑 §5 的自检；红了就改，直到绿。

每份文档开头写「一句话」，让主代理 3 秒判断这份文档能不能直接用。

## 5. 自检（必须真跑，把输出贴进 `04-acceptance.md` §7）

```powershell
cd E:\Documents\GitHub\YingXiaoShang
python plans\server-client-split\00-master\check-docs.py
```

它会检查：四份文档是否齐、节数、每节是否有 `[Rn]`、参考节 URL 数量、`路径:行号` 是否真实、占位词。
**退出码 0 才算完成**；退出码 1 时按报错逐条修，不要绕过脚本。

另外自查三条：

```powershell
# 1) 本轮文档里所有外部链接去重后数量
Select-String -Path "plans\server-client-split\A-server-core\*.md" -Pattern "https://" -AllMatches |
  ForEach-Object { $_.Matches.Value } | Sort-Object -Unique | Measure-Object
# 2) 有没有 TODO/待补
Select-String -Path "plans\server-client-split\A-server-core\*.md" -Pattern "TODO|待补|后面再说"
# 3) git 有没有被你改脏（除本轮目录外应为空）
git status --porcelain
```

## 6. 禁区（违反即返工）

- 不改 `packages/**`、`apps/desktop/**`（H 轮临时 patch 除外，且必须还原）、`docs/**`、根 `pnpm-lock.yaml`（A 轮 install 除外）。
- 不跑 `docker compose down -v`；不删 `.scratch/` 下别人的目录。
- 不碰真实数据目录（`%APPDATA%`、`~/.learning-agent`、`<repo>/.learning-agent`）；要库就复制到 `.scratch/run/<轮次>/`。
- 不 `git commit`、不 `git push`、不 `git stash`。
- 不编造行号、URL、命令输出、性能数字。
- 不把 `README.md` 原有内容改写成你的文档（README 保持原样）。

## 7. 交付报告（回给派你的主代理，纯文本，不要写文件）

```text
轮次：A
产出：
  plans/server-client-split/A-server-core/01-scope.md（行数）
  …/02-contract.md（行数）
  …/03-implementation.md（行数）
  …/04-acceptance.md（行数）
自检：check-docs.py 退出码 0/1 + 关键输出 3 行
外部参考：去重 URL 数 N，其中本轮新搜到 M 条（列 2 条为例）
未解决：<最多 3 条，每条写影响与建议>
```

## 8. 判自己「写够了」的标准

- 一个没看过这个仓库的人，只读你的 4 份文档 + 冻结契约，能写出代码并通过你的验收清单。
- 你的 `02-contract.md` 里，每个字段都有类型、可空性、默认值、边界、来源。
- 你的 `04-acceptance.md` 里，每条 AC 都能用一条命令复现，且写明「看到什么算失败」。
- 你的每个 `##` 节都能指出至少一个外部参考，且那个参考**真的**支撑了这节的观点。
