/**
 * 交卷重试时的答案合并。
 *
 * 规则只有两条，但都很容易被写反：
 *  ① **顺序**必须沿用上一次的记录（判题结果按 `storedResults[index]` 下标复用，
 *     顺序一变判分就串题）；
 *  ② **内容**必须用学生这次提交的（他改了答案，就不能再判旧的）。
 *
 * 背景：旧实现直接 `baseAnswers = existing.answers`，于是学生改完答案点
 * 「重试未判题目」，判的还是库里那份旧的——他做了动作，系统当没看见。
 */

export interface SubmittedAnswer {
  questionId: string
  answer: string
}

export function mergeRetryAnswers(
  previous: SubmittedAnswer[],
  incoming: SubmittedAnswer[],
): SubmittedAnswer[] {
  if (previous.length === 0) return incoming
  if (incoming.length === 0) return previous
  const byId = new Map(incoming.map((item) => [item.questionId, item]))
  const seen = new Set(previous.map((item) => item.questionId))
  const merged = previous.map((old) => byId.get(old.questionId) ?? old)
  // 界面上不该出现「上次没有的新题」；万一出现也不静默丢掉。
  const extra = incoming.filter((item) => !seen.has(item.questionId))
  return extra.length > 0 ? [...merged, ...extra] : merged
}
