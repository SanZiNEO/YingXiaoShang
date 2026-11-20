# I · 小程序 UI 原型（纯 mock）

## 要实现

- 5 个静态页面：提问、回答带引用、出题、答题、学情。
- 全部用 mock JSON，不连服务端。
- 提问页：输入框、章节选择、发送按钮。
- 回答页：正文分段、引用卡片、来源可点开。
- 出题页：题目集信息、开始答题、空题目集有兜底和重试。
- 答题页：上一题/下一题、交卷、提交状态。
- 学情页：进度、能力等级、成长快照、证据；无证据显示空状态。
- 浏览器直接打开 `index.html` 可预览，页面间可跳转。
- 375px 宽度不横向滚动。

## 产出

```text
tools/miniprogram-mock/
  index.html
  pages/ask.html
  pages/answer.html
  pages/questions.html
  pages/answer-sheet.html
  pages/profile.html
  assets/styles.css
  assets/app.js
  fixtures/student.json
  fixtures/chat.json
  fixtures/citations.json
  fixtures/questions.json
  fixtures/profile.json
```
