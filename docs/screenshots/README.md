# 营小商 · 学生使用界面截图

来源：本机部署的 Web 服务（`pnpm web:build` + `pnpm web:start`），
用 Playwright + 本机 Chrome 实际走完“空态 → 用胖东来案例讲消费者”流程后截取。
截图使用干净的 `student_demo`（林晓）数据目录，避免测试会话污染。

| 文件 | 内容 |
|---|---|
| `01-empty-state.png` | 按当前学习状态生成的空态：标题、说明与 2–3 个入口 |
| `02-case-lesson.png` | 聊天回复 + 右栏案例精讲总览；可见消费者/消费者市场/学习三张卡 |
| `03-case-dialogue.png` | “消费者”知识点：定义 → 案例对应 → 案例对话 |
| `04-learning-dialogue.png` | “学习”知识点：定义 → 胖东来体验/心智/跨城行为 → 对话 |

复现：

```bash
pnpm web:build
LEARNING_AGENT_HOME="$PWD/.scratch/screenshot-home" pnpm db:seed
LEARNING_AGENT_HOME="$PWD/.scratch/screenshot-home" pnpm db:seed:student
LEARNING_AGENT_HOME="$PWD/.scratch/screenshot-home" LEARNING_AGENT_WEB_PORT=3084 pnpm web:start
LEARNING_AGENT_WEB_URL=http://127.0.0.1:3084 node scripts/capture-screenshots.mjs
```
