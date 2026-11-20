/**
 * M1 · 移除 SSE 终态 done 帧（声明式变异规格）
 *
 * 对应 02-contract §10 / 04-acceptance §5 M1：
 *   落点 apps/server/src/chat/stream.ts，流结束不再发 `done` 终态帧；
 *   应变红用例 E-070（SSE 顺序：终态帧 event: done 恰好一次）。
 *
 * 锚点策略：运行时只接受「全文唯一命中」的候选，一个都不唯一就记 anchor-miss，绝不强行改写。
 *   A 轮实现经 `SseWriter` 发帧，终态是 `writer.done({ ... })`（apps/server/src/chat/stream.ts:127，
 *   全文唯一 1 次）。早先的 `event: done` / `sendEvent(res, 'done',` 一类候选在真实文件里 0 次命中，
 *   100% anchor-miss —— 那等于 M1 从来没被真正验证过。
 *
 * 替换为什么不是「整段调用删掉」：本机制按字符串替换单点锚点，整段多行载荷写进 anchor 会在
 * 任何格式化改动后失效；而只把函数头换成注释会留下悬空的 `({ ... })` 对象字面量，文件直接编译不过，
 * 测出来的就不是「不发 done」而是「服务端起不来」。这里改成给调用套一个恒假分支：
 * 载荷字面量保持原位（语法不变），调用永不执行（语义就是「不再发 done 帧」）。
 */

export default {
  id: 'M1',
  title: '移除 SSE 终态 done 帧发送',
  file: 'apps/server/src/chat/stream.ts',
  targetCase: 'E-070',
  targetCommand: 'node run.mjs --target http --only E-070',
  redExpectation:
    'E-070 变红：流结束时没有 done 终态帧——要么读取端等不到终态抛 StreamTimeout（记 failed 并写明原因），要么 doneCount / doneNoTrailingEvents 断言不成立。',
  notRunWhenMissing: true,
  edits: [
    {
      anchor: 'writer.done(',
      anchorAlternatives: [
        'writer.done (',
        "emit('done'",
        "sendEvent(res, 'done'",
      ],
      replace: 'if (false) writer.done(',
      description:
        '锚点取 SseWriter 的终态调用 `writer.done(`（stream.ts:127，全文唯一）。替换为 `if (false) writer.done(`：' +
        '调用进入恒假分支，载荷字面量保持原位所以文件仍然可编译可启动，效果是该轮不再发 done 帧。' +
        '候选 0 次或多次命中判 anchor-miss，不改文件。',
    },
  ],
}
