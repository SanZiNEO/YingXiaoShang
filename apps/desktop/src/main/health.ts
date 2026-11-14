/**
 * 启动自检：库里该有的东西有没有。
 *
 * 为什么需要：安装包不完整（杀软删了 seed、解压中断）时，数据库会建成空库，
 * 界面照样能打开，但章节和知识点全是 0，学生看到的是「什么都不懂」的助教，
 * 而且不会报错。这种情况必须自己说出来，而不是让人猜。
 */

export interface StartupHealthInput {
  chapters: number
  knowledgePoints: number
  newsArticles: number
}

export interface StartupHealth {
  ok: boolean
  /** 会挡住使用的（安装包不完整）。 */
  warnings: string[]
  /** 不影响使用、但值得知道的。 */
  notices: string[]
}

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

/**
 * 启动失败时该让学生看到什么。
 *
 * 最糟的情况是「双击没反应」：initServices 抛错时窗口还没创建，学生只能猜。
 * 这里把错误分成「可以自己修（本地数据坏了 → 备份后重置）」和「要找人」两类。
 */
export interface StartupFailure {
  title: string
  body: string
  canResetLocalData: boolean
}

export function startupFailure(error: unknown): StartupFailure {
  const raw = error instanceof Error ? error.message : String(error)
  const isCorruptDb = /file is not a database|database disk image is malformed|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(raw)
  const isPermission = /EACCES|EPERM|read-only database|SQLITE_CANTOPEN|unable to open database/i.test(raw)
  const isDiskFull = /ENOSPC|SQLITE_FULL|disk I\/O error/i.test(raw)

  if (isCorruptDb) {
    return {
      title: '本地数据损坏，营小商打不开',
      body: '可以点「备份旧数据并重置」：旧文件会改名保留，新的空白数据库会重新建立，课程内容会从安装包恢复。',
      canResetLocalData: true,
    }
  }
  if (isDiskFull) {
    return {
      title: '磁盘空间不足，营小商打不开',
      body: '请清理磁盘（至少留 500MB）后再启动。也可以点「备份旧数据并重置」重新建立本地数据库。',
      canResetLocalData: true,
    }
  }
  if (isPermission) {
    return {
      title: '没有权限读写本地数据',
      body: '可能是杀毒软件拦截，或者软件装在只读目录。把营小商换到普通文件夹（例如 D 盘新建一个文件夹）再试。',
      canResetLocalData: false,
    }
  }
  return {
    title: '营小商启动失败',
    body: `错误信息：${raw}\n\n把这句话截图发给老师，附上下面显示的数据目录路径。`,
    canResetLocalData: false,
  }
}
