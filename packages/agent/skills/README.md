# Skills

本目录存放 agent 的 **skill**：一段可被模型按需加载的规则文本，回答「这件事做到什么程度算合格」。

和另外两个目录的分工：

| 目录 | 装什么 | 回答的问题 |
|---|---|---|
| `agents/` | 角色（mentor 等） | 你是谁、对谁说话 |
| `references/` | 知识手册（case-playbook 等） | 具体怎么做 |
| **`skills/`** | **判据** | **做到什么程度算合格、什么情况下不许交付** |

## 为什么要把判据单独拆出来

主提示词越堆越长，模型越容易跑偏——长提示词里同时塞了「角色」「步骤」「格式」「禁忌」四类信息，
模型无法判断哪条优先。拆开之后：

- 角色留在 `agents/`，长而稳定
- 步骤留在 `references/`，按需读
- 判据放 `skills/`，短、可勾选、可单独迭代

## 现有 skill

| skill | 何时用 | 文件 |
|---|---|---|
| `case-coach` | 做案例精讲、校验已有精讲 | [`case-coach/SKILL.md`](case-coach/SKILL.md) |

## 格式约定

遵循 Anthropic Agent Skills 的通用格式：

```yaml
---
name: <小写短横线>
description: <干什么 + 什么时候触发；这一行决定模型会不会加载它>
---
```

- `description` 写**触发条件**，不写能力吹嘘。
- 正文只写判据与硬规则；具体内容与模板放 `references/`，保持本文件短。
- 不写角色扮演、不写 emoji、不用「建议用户……」这类引导语——对齐项目「只陈述事实」的原则。

## 待确认

当前 `packages/agent/src` 里**还没有 skill 加载器**（`skillId` 只是 artifact 的一个字段）。
所以本目录目前是**规范先行**：文件先定下来，加载与注入留待后续实现。

落地方式有两条，需要 @SanZiNEO 定：

1. 启动时扫描 `packages/agent/skills/*/SKILL.md`，解析 frontmatter 的 `description` 做触发匹配；
2. 或仿照 `references/` 的做法，由代码按需 `read_file` 注入，不自动匹配。

在定下来之前，本目录的文件不会被任何代码读取。
