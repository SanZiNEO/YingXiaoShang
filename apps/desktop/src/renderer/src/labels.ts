/** Student-facing labels for controlled internal enums. Never render raw values. */

export const CHAPTER_SHORT: Record<string, string> = {
  ch01: '营销导论',
  ch02: '管理哲学',
  ch03: '营销环境',
  ch04: '消费者行为',
  ch05: '组织市场',
  ch06: '营销调研',
  ch07: '市场营销战略',
  ch08: '产品策略',
  ch09: '价格策略',
  ch10: '渠道策略',
  ch11: '促销策略',
  ch12: '计划控制',
  ch13: '营销新发展',
}

export function chapterText(chapterId: string | undefined, chapters: Array<{ id: string; number: number; title: string }>): string {
  if (!chapterId) return '课程通识'
  const matched = chapters.find((chapter) => chapter.id === chapterId)
  const short = CHAPTER_SHORT[chapterId] ?? matched?.title
  const number = matched?.number ?? Number(/ch(\d{1,2})/.exec(chapterId)?.[1] ?? 0)
  if (!short && !number) return '课程通识'
  return number ? `第${number}章${short ? ` · ${short}` : ''}` : short!
}

export const PHASE_LABEL: Record<string, string> = {
  pre: '学习前',
  learning: '学习中',
  post: '学习后',
  review: '复习',
  assessment: '评估',
}

export const INTENT_LABEL: Record<string, string> = {
  chat: '聊天',
  explain: '概念解释',
  case: '案例精讲',
  news: '新闻分析',
  news_lab: '新闻分析',
  practice: '练习出题',
  research: '调研设计',
  bp: '商业计划',
  growth: '学习复盘',
  plan: '学习计划',
  diagnose: '起点诊断',
}

export const DECISION_LABEL: Record<string, string> = {
  act: '执行',
  ask: '追问',
  chat: '对话',
}

export const TURN_STATUS_LABEL: Record<string, string> = {
  running: '进行中',
  completed: '已完成',
  partial: '部分完成',
  failed: '失败',
}

export const TAG_ROLE_LABEL: Record<string, string> = {
  core: '核心',
  example: '例证',
  mention: '提及',
  context: '情境',
}

export function phaseLabel(phase: string | undefined): string {
  return phase ? PHASE_LABEL[phase] ?? '判断中' : '判断中'
}

export function intentLabel(intent: string | undefined): string {
  return intent ? INTENT_LABEL[intent] ?? '任务' : '任务'
}

export function decisionLabel(decision: string | undefined): string {
  return decision ? DECISION_LABEL[decision] ?? '处理' : '处理'
}

export function turnStatusLabel(status: string | undefined): string {
  return status ? TURN_STATUS_LABEL[status] ?? '状态未知' : '状态未知'
}

export function tagRoleLabel(role: string | undefined): string {
  return role ? TAG_ROLE_LABEL[role] ?? '相关' : '相关'
}
