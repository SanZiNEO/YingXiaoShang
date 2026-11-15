/**
 * 题目集渲染前的判定（纯函数）。
 *
 * 抽出来是为了能断言：空题目集**必须**给下一步入口。
 * 以前这里只有一句「这份题目集没有可渲染的题目。」，学生不知道是自己错了、
 * 还是软件坏了，只能关掉或反复重发——典型的死胡同。
 */

export type EmptyQuestionSetAction = 'markdown' | 'retry'

export function emptyQuestionSetAction(artifact: { content: string }): EmptyQuestionSetAction {
  return artifact.content.trim().length > 0 ? 'markdown' : 'retry'
}
