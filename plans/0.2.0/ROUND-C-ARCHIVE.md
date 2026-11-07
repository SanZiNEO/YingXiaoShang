# C 轮（切片一）：学情档案闭环

> 状态：**已实现、已自测、独立复核通过（可合）**。提交 `211d36f`、`c6b75a1`。
> 这一片只解决「档案不更新」，不动运行时（原生替换仍是 B 轮）。

---

## 一、断在哪（修复前的实测证据）

```
聊天结束 → upsertTurn 写入 record_json: {}          ← index.ts 原样
记录器   → asRecord({}) 要求 turnId + status        ← recorder.ts
         → 拿到 {} 返回 undefined → break
         → summarized_seq 永远停在 0
         → learning_states / growth_records 从未写入
```

本机数据库实测（`~/.learning-agent/data/learning.db`）：

| 检查 | 数值 |
|---|---|
| `turns` 行数 | 27 |
| `record_json` 为 `{}` 的轮次 | 27 / 27（每行 2 字节） |
| `summary_ledger` | 11 条，**全部 `pending`，`summarized_seq` 全 0** |
| `learning_states` | **0 行** |
| `growth_records` | **0 行** |
| `evidence` | 9 行（全部来自题目提交，与聊天无关） |

结论：不是「偶尔不同步」，是**从来没同步过**。

## 二、改了三处

| 位置 | 改动 |
|---|---|
| `packages/agent/src/index.ts` | 聊天轮次写完整 `TurnRecord`：`turnId/status/scope/phaseBefore/phaseAfter/artifactIds/errors/ledgerWatermark/startedAt/finishedAt`… 有 warnings 时 `status='partial'` |
| `packages/agent/src/recorder.ts` | 已完成但没有有效 record 的**历史轮次**跳过并推进水位；`running` 的轮次继续挡住（消息还没写完） |
| `packages/agent/src/index.ts` | 返回值复用同一次 projection，不再末尾重算 |

第二条是关键：**光修写入，老用户还是卡住**——他们的历史轮次全是 `{}`，
循环一进去就 break，新轮次永远排不到。跳过老轮次才能自愈。

## 三、验证（两种数据形态，都不是我这台机器的特例）

| 形态 | record_json | 本会话 ledger | learning_states | episode | failed |
|---|---|---|---|---|---|
| A 老用户旧库（水位全 0、历史 record 为空） | 605 字节 ✅ | **8/8 summarized** ✅ | 1 行 ✅ | 2 | 0 |
| B 新解压的种子库 | 514 字节 ✅ | **8/8 summarized** ✅ | 1 行 ✅ | 1 | 0 |

复现命令（探针在仓库内，不进产品）：

```bash
LA_PROBE_HOME=<数据目录> LA_TEMPLATES=<仓库>/apps/desktop/templates \
LEARNING_AGENT_PROMPTS_DIR=<仓库>/packages/agent \
DEEPSEEK_API_KEY=... pnpm exec tsx probe/a0-dsh/b9-archive-sync.mts
```

会打印六条断言：record 长度、ledger 水位、learning_states 行数、
episode 数、evidence 数、failed ledger 数。

## 四、为什么不需要迁移脚本

没有新表、没有改 schema，`TurnRecord` 一直是 schema 里的既有结构，
只是以前喂了空对象。老数据靠 recorder 的跳过分支自然消化，
不需要用户手动重建数据库，也不需要版本判断。

## 五、已知副作用（要记住）

对话轮次现在会触发一次**后台证据抽取**（`profile.extractEvidence`，一次模型调用）。

- 不阻塞本轮回答（`recorder.schedule` 是后台的），但会和下一轮请求争带宽；
- 实测证据从 11 → 13 条，说明抽取真的在跑；
- 如果以后觉得「聊完马上再问」变慢，先看这里（C 轮后续可做：只在学生说了
  足够长的推理时抽取，或用更小模型）。

## 六、没做的事

- 成长卡 / 能力维度仍依赖 `growth_snapshots`，需要更多轮次才看得出变化；
- 聊天里抽出的证据 `review_status='draft'`，老师侧还没有审核入口（E 轮）；
- 历史轮次里真正有价值的学生原话**不会补抽**证据——只推进水位，不追溯。
  这是有意的：补抽要重跑历史模型调用，成本和不确定性都高，且学生已看不到那些轮次。

---

## 七、独立复核发现并已修的问题（`c6b75a1`）

复核按 `review-kit.md` 判据查出三条，全部属实：

| 级别 | 问题 | 修法 |
|---|---|---|
| P1 | `snapshotAfter` 用 `message: ''` 投影，而 phase 判定（`state.ts:177` 的 `postRequest` 等）只看 message → 学生说「我写完了」时 `phaseBefore=post`、`phaseAfter=learning` 倒退 | 改成用本轮原话投影，`phaseBefore` 与 `phaseAfter` 同一口径 |
| P1 | 上面那条的直接后果：`recorder.ts` 里 `record.phaseAfter === 'post'` 永不成立 → `growth_snapshots` 从聊天轮次永远写不进去 | 同上，分支现在可达 |
| P1 | `R03-tools.md:70`、`R06-knowledge.md:64` 仍写 `read_kp` 的 `name` 必填 | 同步为 `name` 或 `names`，注明不能同时为空 |
| P2 | `R05-context-on-demand.md:118` 引用的 `read-tools.ts:58-59` 已因批量改造偏移 | 改为 `:73-74` |
| P2 | `names` 传成字符串时误报「缺少参数」 | 字符串按单个处理 |

**这条 P1 很关键**：如果不修，我这一轮等于只修了「水位能前进」，
但「学生做完作业 → 记一次成长快照」这条链仍然断着，而那正是老师最想看的。

实测（`LA_UTTERANCE='我写完了，帮我看看这份作业的问题在哪？'`）：

```
record.phaseBefore → phaseAfter: post → post     （修前 post → learning）
```

## 八、复核怎么做的（可复用）

按 `plans/0.2.0/主代理-轮次任务模板.md` 派单，模板 `review`，brief 里给三样东西：

1. **范围**：认提交号，不认口述；
2. **背景**：说清「这一版还跑自研循环，原生替换是 B 轮」，否则会被当成原则违背；
3. **必答三问**：字段与 schema 是否一致、有没有只在我本机成立的前提、工具契约有没有被破坏。

复核独立跑了 typecheck 与 `verify-doc-refs.py`，没有采信我的自测数字。
它给的证据是 `文件:行号` + 代码摘录，符合 review-kit 第五节格式。
