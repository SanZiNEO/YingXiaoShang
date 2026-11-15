/**
 * 流式事件的界面状态迁移（纯函数，可单独测）。
 *
 * 抽出来的原因：这几条规则全是**学生能直接感知**的行为，但以前写在 React 的
 * `setStream` 回调里，只能靠手点验证。其中「工具事件清空已出文字」一条，
 * 代码里写着「收回这段，避免半截话上屏」，看起来像有意的设计，实际违反了
 * `docs/requirements/R21-response-speed.md:11/48/80`——出了的字不能又消失。
 *
 * 现在这里只有事实，没有 JSX：给定上一条状态和一条新事件，算出下一条状态。
 */

/** 一轮对话中主进程推给界面的进度事件。 */
export interface ChatStreamEvent {
  requestId: string
  agent: string
  type: 'round' | 'text' | 'tool' | 'tool-end' | 'session'
  round?: number
  text?: string
  tool?: string
  sessionId?: string
}

export interface StreamState {
  requestId: string
  text: string
  step: string
}

/** 工具名 → 用户可读的动作文案；进度提示不暴露内部工具名。 */
export const TOOL_LABEL: Record<string, string> = {
  list_chapter_kps: '正在看本章有哪些知识点',
  read_material: '正在取教材材料',
  read_kp: '正在读知识点定义',
  read_textbook: '正在读教材原文',
  read_reference: '正在查手册',
  search_news: '正在检索新闻',
  read_news: '正在读新闻原文',
  write_page: '正在写页面',
  emit_question_set: '正在出题',
}

/**
 * 把一条事件应用到当前状态上。
 *
 * 返回 `undefined` 表示这条事件不属于当前这一轮（例如上一轮晚到的事件），
 * 调用方保持原状态不变。
 */
export function applyStreamEvent(
  current: StreamState | undefined,
  item: ChatStreamEvent,
): StreamState | undefined {
  if (!current || current.requestId !== item.requestId) return current

  if (item.type === 'tool') {
    // **不清 text**：保留已显示正文，只更新阶段提示。
    return { ...current, step: TOOL_LABEL[item.tool ?? ''] ?? '查资料' }
  }
  if (item.type === 'text' && item.agent === 'lead') {
    return { ...current, text: current.text + (item.text ?? ''), step: '' }
  }
  if (item.type === 'round' && item.agent === 'lead' && current.step === '') {
    return { ...current, step: '正在组织回答…' }
  }
  return current
}
