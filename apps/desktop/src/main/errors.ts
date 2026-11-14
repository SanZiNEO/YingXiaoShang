/**
 * 把底层错误翻译成学生看得懂的一句话。
 *
 * 原则：① 说清发生了什么；② 说清他能不能自己救；③ 不出现英文栈/内部术语。
 * 这里做成纯函数是为了能单独测——这些文案是产品的一部分，不能靠手点碰运气。
 */

export interface FriendlyOptions {
  /** 「重发」类文案要提到这一段没有被记成作答，避免学生以为白做了。 */
  context?: 'chat' | 'answer'
}

export function friendlyError(error: unknown, options: FriendlyOptions = {}): Error {
  const raw = error instanceof Error ? error.message : String(error)
  const stripped = raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
  const retryHint = options.context === 'answer'
    ? '这次作答没有记成成绩，可以直接重试。'
    : '刚才这一轮没有保存成结果，可以直接重发。'

  if (/已停止/.test(stripped)) {
    return new Error('已停止这一轮（你点的停止）。这次没有保存结果，可以重新提问。')
  }
  if (/DEEPSEEK_API_KEY is not configured|请先在设置中填写|apiKey.*(empty|missing)/i.test(stripped)) {
    return new Error('还没配置模型密钥：点左下角「设置」填入 DeepSeek Key 后再发一次。')
  }
  // 断网/被墙/代理挂了都会落到这里；中文提示比 fetch failed 有用得多。
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|getaddrinfo|network|socket hang up|TLS|certificate/i.test(stripped)) {
    return new Error(`连不上模型服务器：先检查网络；如果开着代理或加速器，先关掉再试。${retryHint}`)
  }
  if (/401|403|invalid.?api.?key|unauthori[sz]ed|authentication_error|Invalid credential/i.test(stripped)) {
    return new Error('模型密钥无效或已过期，请在「设置」里重新填写。')
  }
  if (/402|insufficient|balance|quota/i.test(stripped)) {
    return new Error('模型账户余额/额度不足，请先在 DeepSeek 后台充值后再试。')
  }
  if (/429|rate.?limit|too many requests/i.test(stripped)) {
    return new Error('模型调用太频繁了，等几秒再发一次。')
  }
  if (/timeout|timed out|aborted|ETIMEDOUT/i.test(stripped)) {
    return new Error(`这一步等太久了，已经停下。${retryHint}`)
  }
  if (/transport failed|stream.*(closed|interrupted)|premature close/i.test(stripped)) {
    return new Error(`模型连接中途断了（不是你操作的问题）。${retryHint}`)
  }
  if (/SQLITE|database is locked|disk I\/O|ENOSPC|read-only database/i.test(stripped)) {
    return new Error('本地数据写入失败：可能是磁盘满了，或者软件还开着另一个窗口。关掉多余的窗口再试。')
  }
  if (/模型没有返回任何内容|empty (response|completion)/i.test(stripped)) {
    return new Error(`模型这次没有返回内容。${retryHint}`)
  }
  // 兜底：至少把英文前缀去掉，并给一句可执行的建议。
  return new Error(`${stripped}（如果反复出现，把这句话截图发给老师）`)
}
