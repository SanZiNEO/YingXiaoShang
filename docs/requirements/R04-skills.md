# R04 Skill 与手册

> 状态：MVP（本轮）
> 依赖：[R02](R02-prompt.md)
> 代码：`packages/agent/skills/`、`packages/agent/references/`、`packages/agent/src/prompts.ts`
> 上位原则：[`../principles/single-agent.md`](../principles/single-agent.md)

## 1. 要什么（学生可见结果）

- 营小商做案例精讲、出题、调研、BP、成长卡时，按同一套判据检查「做到什么程度算合格」，不凭印象发挥。
- 学生感觉不到「加载了一份规则」；只看到结论更稳、该说资料不足时就说资料不足。
- 判据不常驻上下文：没用到时不占篇幅，用到时才读，读完同一轮不重复读。
- 读不到判据时明确报错，不静默换成另一份，也不假装读过。

## 2. 落位（提示词 / 工具 / skill / 数据）

三层分工，同一句话只存一处：

| 层 | 回答什么问题 | 长度 | 例子 |
|---|---|---|---|
| 提示词 | 你是谁、每轮先判断什么、什么时候读哪份 | 常驻，短 | 身份、回复规范、边界 |
| skill | 这件事做到什么程度算合格、什么情况下不许交付 | 短，可勾选 | 案例精讲的 11 条自查 |
| 手册 | 具体怎么做、框架、rubric、模板 | 长，按需读 | 出题流程、调研方法、能力分级 |

- skill 是**判据**，不是角色，不是 agent，不是代码分支。
- 手册是**方法论**，由 skill 或提示词指向；skill 不重复手册正文。
- 数据（知识点、教材、新闻、产物）不放在这两层，走 [R03](R03-tools.md)。

## 3. 行为（一轮里怎么发生）

1. 启动时扫描 `packages/agent/skills/*/SKILL.md`，解析 frontmatter 的 `name` 与 `description`，得到 skill 目录。
2. system 只放目录：每行 `- <name>：<description>`，并注明「只是目录，正文要 read_skill」。
3. 模型判断需要判据时调用 `read_skill({ name })`；工具返回去掉 frontmatter 的正文。
4. 正文进入 `messages`，同一轮再次调用返回「本轮已经读过」，不重复占上下文。
5. 模型按判据产出内容；需要方法论时再调 `read_reference` 读对应手册。
6. 本轮结束，skill 正文不写回 system，也不进下一轮 system。

## 4. 契约

目录规范：

```text
packages/agent/skills/
  README.md                 # 开发者说明，不是 skill
  <name>/
    SKILL.md                # 唯一入口
```

`SKILL.md` 格式：

```markdown
---
name: <小写短横线，与目录名一致>
description: <干什么 + 什么时候触发 + 什么时候不该用；≤ 200 字符>
---

# <标题>

## 什么时候用 / 不用
## 判据（可勾选）
## 硬规则（违反即不合格）
## 自查清单
## 失败处理（不硬编）
## 指向的手册（read_reference 的 name）
```

加载契约：

```ts
// packages/agent/src/prompts.ts
export interface SkillEntry { name: string; description: string; path: string }
export function loadSkillCatalog(): SkillEntry[]
export function loadSkill(name: string): string

// packages/agent/src/tools/read-tools.ts
// 新增工具
read_skill: { name: string } => string
```

- `read_skill` 只接受目录里存在的 `name`；未知名字返回 `没有这份 skill：x。可选：a / b / …`。
- skill 根目录与 `agents/`、`references/` 同级：开发时是 `packages/agent/skills/`，打包后是 `resources/prompts/skills/`；沿用 `LEARNING_AGENT_PROMPT_ROOTS`，不新增环境变量。`prompts.ts` 的 `read()` 增加 `'skills'` 类型，路径为 `<root>/skills/<name>/SKILL.md`。
- 文件存在但读不到、frontmatter 缺 `name` 或 `description`：启动时报错并指出文件路径；不静默跳过。
- 正文去掉 frontmatter 后返回；不裁剪、不改写。
- `read_skill` 记 `turn.reads.skills`（见 [R05](R05-context-on-demand.md)），不写 `citations`：判据不是原文证据。
- 同一轮用 `firstTime('skill:<name>')` 去重；新的一轮重置。
- 目录文本 ≤ 1,000 字符；`description` 超 200 字符时截断并加 `…`。

新增一个 skill：

1. 建 `skills/<name>/SKILL.md`，写 frontmatter 与判据。
2. 不改代码；重启后目录自动出现。
3. 在 `agents/mentor.md` 的「什么时候读」表里加一行（可选，但推荐）。
4. 打包配置必须包含 `skills/`，否则安装包读不到。

## 5. 边界（不做什么、失败怎么表现）

- 不把 skill 正文放进 system；system 只有名称与触发描述。
- 不把 skill 写成角色、人格、语气设定；这些属于提示词。
- 不按关键词自动匹配 skill；由模型看目录自己选。
- 不为某个 skill 写代码分支；skill 是内容，不是调用路径。
- skill 不直接写产物；产物仍走 `write_page` / `emit_question_set`。
- skill 不引用旧角色名（如「交给某某」）；一份 skill 只对自己负责。
- 读不到：返回明确错误或启动失败；不允许「读不到就用默认判据」的静默降级。
- skill 正文不重复手册；需要细节时写「读 `read_reference('<name>')`」。

## 6. 验收（场景 → 期望）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 新会话抓 system | 只出现 skill 名称与触发描述；搜不到任一 `SKILL.md` 正文里的独有句子 |
| 2 | 学生说「把这条新闻做成案例精讲」 | 模型调 `read_skill('case-coach')`；正文进入 messages；`trace.reads.skills` 含 `case-coach` |
| 3 | 同一轮再次调用同一个 skill | 返回「本轮已经读过，内容完全相同」；不重复返回正文 |
| 4 | 调用不存在的 skill | 返回 `没有这份 skill：x。可选：…`；不静默换一份 |
| 5 | 删掉某个 `SKILL.md` 的 `description` | 启动报错并指出文件；不带着半份目录继续跑 |
| 6 | 只新增一个 skill 目录 | 重启后 system 目录出现该 skill；`tool-loop.ts`、`team.ts` 无改动 |
| 7 | 全文检索 skill 正文 | 不出现任何内部分工称呼：角色名、身份名、「交给某某」这类转交话术 |

## 7. 现状与差距（代码事实）

| # | 事实 | 位置 |
|---|---|---|
| 1 | 仓库里只有一份 skill：`case-coach`，115 行 | `packages/agent/skills/case-coach/SKILL.md` |
| 2 | `skills/README.md` 明确写「还没有 skill 加载器」「本目录的文件不会被任何代码读取」 | `packages/agent/skills/README.md:45`、`:53` |
| 3 | `case-coach/SKILL.md` 仍把出题、评价交给旧角色名 | `packages/agent/skills/case-coach/SKILL.md:19`、`:113-114` |
| 4 | `case-coach/SKILL.md` 要求产出 `case_study` 结构，但当前写工具只有 `page` 与 `question_set` | `packages/agent/skills/case-coach/SKILL.md:79`、`packages/agent/src/tools/write-tools.ts:95` |
| 5 | 七份手册已按需读：`read_reference` 的 enum 来自 `REFERENCE_NAMES` | `packages/agent/src/tools/read-tools.ts:292-306`、`packages/agent/src/prompts.ts:59-67` |
| 6 | 手册名写错时返回可选清单；文件缺失时 `loadReference()` 抛错 | `packages/agent/src/tools/read-tools.ts:305-306`、`packages/agent/src/prompts.ts:43-45` |
| 7 | 主提示词有手册索引，没有 skill 索引 | `packages/agent/agents/mentor.md` 的「手边的资料」表 |
| 8 | 打包只带 `agents/` 与 `references/`，不带 `skills/`；注释还写「6 份角色提示词（1 个入口 + 5 个分工）」 | `apps/desktop/electron-builder.yml:15-20` |
| 9 | `artifacts.ts` 的 `skillId: 'agent'` 只是常量，不是 skill 标识 | `packages/agent/src/artifacts.ts:115` |
| 10 | 旧的 `case-coach.ts`（841 行）无调用方，且写死商超品牌，和 skill 内容重复 | `packages/agent/src/case-coach.ts:606`、`packages/agent/src/case-library.ts:64-72` |
| 11 | `case-coach/SKILL.md` 的「六步」与 `references/case-playbook.md` 的六步重复；skill 应只留判据 | `packages/agent/skills/case-coach/SKILL.md:23-30`、`packages/agent/references/case-playbook.md:6-43` |

## 8. MVP 范围与后续

**MVP 做到哪**

- 实现 `loadSkillCatalog()` / `loadSkill()` 与 `read_skill` 工具；system 只放目录。
- 重写 `case-coach/SKILL.md`：只留判据、硬规则、自查清单、失败处理；删掉旧角色转交、`case_study` 输出要求，以及与 `case-playbook` 重复的六步。
- 删除 `case-coach.ts` 死代码；案例精讲的实现走提示词 + skill + `write_page`，见 [R10](R10-case-lesson.md)。
- 打包配置加入 `skills/`，并修正过时注释。
- 补一条启动校验：skill 目录缺失、frontmatter 不完整、文件不可读都报错。

**后续留什么**

- 新增出题、调研、BP、成长卡判据时，各加一份 `SKILL.md`，不新增代码分支。
- 需要更细的评分表时，放 `references/`，由 skill 指向，不塞进 skill 正文。

**明确不做**

- skill 常驻 system、自动关键词匹配、按 skill 起 agent、按 skill 写代码分支。
- skill 里写角色扮演、语气设定、分工称呼。
- 把手册正文复制进 skill。
