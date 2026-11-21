export interface StartupHealthInput {
  chapters: number
  knowledgePoints: number
  newsArticles: number
}

export interface StartupHealth {
  ok: boolean
  warnings: string[]
  notices: string[]
}

/** Copied from apps/desktop/src/main/health.ts: the wording is a product contract. */
export function startupHealth(input: StartupHealthInput): StartupHealth {
  const warnings: string[] = []
  const notices: string[] = []
  if (input.chapters === 0) {
    warnings.push('没有读到课程章节（0 个）。安装包可能不完整：请重新解压一次安装包；若仍不行，联系老师重新要一份。')
  } else if (input.knowledgePoints === 0) {
    warnings.push('读到了章节，但知识点是 0 个。安装包可能不完整，请重新解压一次安装包。')
  }
  if (input.chapters > 0 && input.newsArticles === 0) {
    notices.push('本地新闻库还是空的（不影响聊天）。问新闻时会提示「本地没有」，需要联网补抓。')
  }
  return { ok: warnings.length === 0, warnings, notices }
}
