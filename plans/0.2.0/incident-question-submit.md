# 事故：生成题目「无法交卷 / 多选只能选一个」

> 来源：学生反馈（2026-11-07）。已修复，提交见 git log `fix(quiz)`。

## 一、现象

1. 让营小商出题 → 题干和选项正常显示；
2. 选完选项，交卷按钮点了没反应，或者说「交卷失败」；
3. 多选题只能选中一个选项。

## 二、根因（两条，都在真实数据上复现过）

### 1. 多选题被当成单选

生成出来的题目里 `type` 是英文 token：

```json
{"id":"q4","type":"multiple_choice","answer":"A,B,D"}
```

而界面判断多选用的是 `type === '多选'`，英文 token 不等于中文，于是按单选渲染 →
点第二个选项就把第一个清掉。

### 2. 交卷必然失败：题目没进 `questions` 表

- 题目只写在 `artifacts.content_json` 里；
- `question_attempts.question_id` 有外键指向 `questions(id)`；
- 判题子代理也是 `db.getQuestion(questionId)` 取题。

所以 `getQuestion('q1')` 返回 undefined → 抛「题目数据缺失」→ 一道题都判不了。
证据：本机 `questions` 表里 456 行全是题库原生题（`q_418a...`），
那份 20 题诊断题的 `q1..q20` **一行都没有**；`question_attempts` 长期 0 行。

## 三、修法

| 位置 | 改动 |
|---|---|
| `packages/shared` | 新增 `normalizeQuestionType()` / `isChoiceQuestion()`：`multiple_choice`、`multi_select`、`多选题` 等统一成中文口径 |
| `packages/agent/src/question-registry.ts`（新） | 题目登记：把 artifact 里的题写进 `questions` 表；id 冲突时才全局化（`q_<hash>`），老产物保留原题号 |
| `packages/agent/src/artifacts.ts` | 产物落库时对 `question_set` 做登记 + 题型归一 |
| `packages/agent/src/index.ts` | 交卷/单题作答前先补登记（**老题目也能交卷**，不用重出题） |
| `packages/agent/src/text.ts` | `scoreAnswer` 先归一题型，多选按集合比对 |
| `apps/desktop/.../renderers.tsx` | 多选判断改用 `normalizeQuestionType()` |

## 四、验证

`scripts/verify-question-submit.ts`（19 条断言，能变红）：

- 题型归一 7 条；
- 多选判分：全对 / 对 2/3 / 全错；
- 登记：初始没有行 → 登记后有两行 → 题型是中文 → **作答记录能写入（外键满足）** → 重复登记不报错 → 老产物保留 `q1`。

端到端（`probe/a0-dsh/b11-submit.mts`，用学生实际那份 20 题）：

```
题目集：第4章 消费者市场与购买行为分析 · 20题诊断题组
前两题题型: q1:single_choice  q2:judgment
提交答案: q1=B  q4=A,B,D
交卷状态: completed | 判出条数: 2
attempts: 0 → 2 ✅ 写入成功
```

## 五、遗留

- 老题目集里英文 token 的题，界面靠归一函数显示正常；但**题库统计**（`listQuestions` 按类型筛）
  只会看到新登记的题，历史题不追溯。
- 题目集合并（`merge`）时仍然按题干去重，id 由登记阶段统一，跨题目集不会撞号。
