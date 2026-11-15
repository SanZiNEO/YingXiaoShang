# 4 条 P2 的定位与修法（待执行）

> 目的：不复述记忆，全部给到「文件:行号 + 现在为什么错 + 怎么改 + 怎么证明改好了」。
> 状态：定位完成，**等独立复核跑完再动手**（避免它跑验证脚本时读到中间态）。

---

## P2-① 模型空返回时，已经流出的正文被丢掉

**位置**：`packages/agent/src/tool-loop.ts:386-390`

```ts
if (text.length > 0) lastText = text
if (toolCalls.length === 0) {
  if (text.length === 0) throw new Error('模型没有返回任何内容')
  return { text, rounds: round, called, calls, context: contextStats() }
}
```

**为什么会丢**：`lastText` 一直在维护（line 386），但空返回时直接抛错。
上一轮模型已经吐过的正文（学生已经在屏幕上看了一半）就这样被当成「失败」。
上层把失败转成错误提示，已经上屏的字被替换掉，学生看到「模型没有返回任何内容」——
但他明明刚看到一堆字。

**改法**：

```ts
if (toolCalls.length === 0) {
  if (text.length > 0) return { text, ... }
  if (lastText.length > 0) {
    // 已经流出去的字不能凭空消失：宁可给半截，也不要给「没有返回」。
    return { text: lastText, ... }
  }
  throw new Error('模型没有返回任何内容')
}
```

注意 `lastText` 只在 `text.length > 0` 时更新，所以它保存的是「最近一次有内容的轮次」，
不是拼接。这一点要在注释里写清，避免以后有人以为是拼接。

**证明**：新增断言脚本 `scripts/verify-empty-return.ts`（纯函数级）。
需要把这段判定抽成一个可测函数，例如：

```ts
export function resolveRoundText(input: { text: string; lastText: string }):
  { kind: 'ok'; text: string } | { kind: 'empty' }
```

断言：
- text 有内容 → ok，取 text
- text 空、lastText 有内容 → ok，取 lastText
- 两个都空 → empty（上层才报错）

**变红**：把 `lastText` 分支删掉 → 第二条断言必须失败。

---

## P2-② 交卷失败后重试，判的是库里的旧答案

**位置**：`packages/agent/src/index.ts:787`

```ts
const baseAnswers = retrying && existing && existing.answers.length > 0
  ? existing.answers
  : input.answers
```

**为什么错**：`retrying` 时**无条件用库里的答案**。
学生在界面上把答案改了、点「重试未判题目」，`input.answers` 里是新答案，
但 `baseAnswers` 取的是 `existing.answers`（旧答案）。于是判题判的还是旧答案，
学生怎么改都没用——**这是最伤人的一类 bug：他做了动作，系统当没看见**。

**改法**：按 `questionId` 合并，**新答案优先，顺序对齐旧记录**：

```ts
const previous = existing?.answers ?? []
const incoming = new Map(input.answers.map((item) => [item.questionId, item]))
const baseAnswers = retrying && previous.length > 0
  ? previous.map((old) => incoming.get(old.questionId) ?? old)
  : input.answers
```

为什么必须保持 `previous` 的顺序：下面用 `storedResults[index]` / `storedStatuses[index]`
按下标复用已判结果（`if (statuses[index] === 'ok') continue`）。
顺序一变，判分结果就会串到别的题上。这是这次修改**唯一真正的风险点**，
必须在注释里写明。

同时补一条护栏：如果 `input.answers` 里出现 `previous` 中没有的 `questionId`，
说明界面传错了（不该发生）——不静默丢弃，而是把它追加到末尾并让既有的
「不属于这份题目集」校验去拒绝。

**证明**：扩 `scripts/verify-question-submit.ts`
- 首次交卷：2 题，第 2 题判分失败 → status = partial
- 学生改第 2 题答案 → 重试
- 断言：**判题收到的答案 = 改后的新答案**（不是库里的旧答案）
- 断言：第 1 题没有被重复提交（attempt 数量不变）

**变红**：把 `baseAnswers` 改回 `existing.answers` → 「新答案」断言必须失败。

---

## P2-③ 新会话首轮失败，界面仍用旧 sessionId

**位置**：
- 创建点：`packages/agent/src/index.ts:405-409`（`handleConversation` 内部建 session）
- 失败点：`apps/desktop/src/main/index.ts:472`（`throw friendlyError(error)`）
- 渲染层：`apps/desktop/src/renderer/src/App.tsx:984`（catch 里 `refreshAll(sessionId)`，用的是闭包旧值）

**为什么错**：sessionId 只在**成功返回**时才给到渲染层（`setSessionId(result.sessionId)`）。
首轮失败时：
1. 主进程里已经建了一条新会话（库里有一行）
2. 渲染层还拿着 `undefined`（或上一次的旧 sessionId）
3. 学生重发 → 主进程又建一条新会话 → **会话越攒越多，历史对不上**

**改法**：把「会话已建立」当成运行时事实，**尽早推给界面**。

1. `packages/agent/src/team.ts`：`TeamEvent` 增加
   ```ts
   type: 'round' | 'text' | 'tool' | 'tool-end' | 'session'
   sessionId?: string
   ```
2. `packages/agent/src/index.ts`：`handleConversation` 建好 sessionId 后，**立刻**
   `hooks?.onEvent?.({ agent: 'lead', type: 'session', sessionId })`
3. `apps/desktop/src/renderer/src/App.tsx` 的 `onChatEvent`：
   收到 `type === 'session'` → `setSessionId(item.sessionId)`
4. `env.d.ts` / `model.ts` 里的 `ChatStreamEvent` 补 `sessionId?: string`

这样即使模型请求立刻失败，界面也已经知道真实 sessionId，重发会接在同一个会话上。

**证明**：扩 `scripts/verify-cancel.ts` 或新建 `verify-session-id.ts`：
- 用假 llm 让第一次请求抛错
- 断言：抛错**之前**已经收到过 `type === 'session'` 的事件，且 sessionId 非空
- 断言：第二次请求传入的 sessionId === 第一次事件里的 sessionId

**变红**：把 emit 那行删掉 → 断言失败。

---

## P2-④ 空题目集只说「没有可渲染的题目」，没有下一步

**位置**：`apps/desktop/src/renderer/src/renderers.tsx:101-105`

```tsx
if (questions.length === 0) {
  return artifact.content.trim().length > 0
    ? <MarkdownView text={artifact.content} />
    : <Empty>这份题目集没有可渲染的题目。</Empty>
}
```

**为什么错**：学生看到一句死话，没有任何可点的东西。他不知道是「AI 出错了」
还是「自己操作错了」，只能关掉或反复重发。这是「用不下去」的典型。

**改法**：给 `ArtifactRendererProps` 加一个可选回调，由 App 传进来：

```ts
onAsk?: (text: string) => void
```

空题目集时渲染两个按钮：
- 「重新出这一章的 5 道题」 → `onAsk('重新出这一章的 5 道题')`
- 「先讲这一章的重点」 → `onAsk('先讲这一章的重点，再出题')`

App.tsx 里传 `onAsk={(text) => void send(text)}`。

**证明**：这类纯 UI 分支不好测，做法是把判定抽成纯函数：
```ts
export function emptyQuestionSetAction(artifact: { content: string }):
  { kind: 'markdown' } | { kind: 'retry' }
```
断言：content 有内容 → markdown；无内容 → retry（界面必须给按钮）。

**变红**：让函数恒返回 markdown → 断言失败。

---

## 执行顺序（为什么是这个顺序）

1. **③**（sessionId）—— 唯一会「制造脏数据」的一条，先修
2. **②**（旧答案）—— 学生做了动作系统当没看见，第二伤
3. **①**（丢正文）—— 体验伤
4. **④**（死胡同）—— 引导缺失

每条：改 → 补断言 → 跑全绿 → **变红实验** → 还原 → 下一条。
四条全绿后：`pnpm run typecheck` → 打 1105h → 真机冒烟 → 提交。

---

## 顺带要修的文档

`plans/0.2.0/implementation-progress.md` 里 F01–F19 那 19 行**全部还是空勾**，
但其中很多已经在后续轮次真正修掉了（F01 signal、F10 出题入库、F11 record_json、
F13 历史预算…）。这张表已经不能当进度看，必须逐条核对后改状态，
否则下一个人会以为「19 个 P0/P1 全没修」。
