/**
 * 业务分发层：桌面端与 Web 服务端共用同一套方法实现。
 *
 * 为什么抽出来：`apps/desktop/src/main/index.ts` 里那 250 行 switch 是**产品行为的唯一来源**。
 * 服务端化时如果照抄一遍，两边就会慢慢分叉（判题、学情、历史压缩各改一半）。
 * 抽成 `createDispatch(deps)` 后：
 *   - 桌面：`ipcMain.handle('learning:invoke', (_, m, i) => dispatch(m, i, { studentId }))`
 *   - 服务端：`app.post('/rpc/:method', (req) => dispatch(req.params.method, req.body, { studentId: req.user.id }))`
 *
 * 注意：`studentId` 由**调用方从会话派生**，不从入参读。桌面端传固定学生；
 * 服务端必须传登录学生——这是多用户下的安全边界，不要在方法内部再读 `args.studentId`。
 */
import type LearningDb from '@learning-agent/db'
import type { Matcher } from '@learning-agent/matcher'
import type { ProfileService } from '@learning-agent/profile'
import type { ArtifactService } from '@learning-agent/artifacts'
import type { AgentService } from '@learning-agent/agent'
import type { NewsService } from '@learning-agent/news'

/** 只有桌面端具备的能力（文件系统 / 原生对话框）。服务端不传。 */
export interface DispatchHost {
  revealFile?: (path: string) => void
  previewFile?: (path: string) => Promise<unknown>
  openFileDialog?: () => Promise<unknown>
}

export interface DispatchDeps {
  db: LearningDb
  news: NewsService
  matcher: Matcher
  profile: ProfileService
  artifacts: ArtifactService
  agent: AgentService
  host?: DispatchHost
}

export interface DispatchContext {
  /** 已认证学生 id。桌面端是固定 demo 学生；服务端必须来自会话。 */
  studentId: string
}

export async function dispatchMethod(
  deps: DispatchDeps,
  method: string,
  input: unknown,
  ctx: DispatchContext,
): Promise<unknown> {
  const args = (input ?? {}) as Record<string, unknown>
  const { db, news, matcher, profile, artifacts, agent, host } = deps
  const studentId = ctx.studentId
  const needHost = (name: keyof DispatchHost): never => {
    throw new Error(`${name} 只能在桌面端使用（Web 端请改用上传/下载）`)
  }

  switch (method) {
    case 'student.current': {
      const student = db.getStudentProfile(studentId)
      return { studentId, name: student?.name ?? '学生', cohort: student?.cohort ?? '' }
    }
    case 'chapters.list':
      return db.listChapters()
    case 'kps.list': {
      const chapter = typeof args.chapter === 'string' ? args.chapter : undefined
      const query = typeof args.query === 'string' ? args.query : ''
      const limit = typeof args.limit === 'number' ? args.limit : 80
      return query
        ? db.searchKps(query, chapter, limit)
        : chapter
          ? db.listKpsByChapter(chapter).slice(0, limit)
          : db.searchKps('', undefined, limit)
    }
    case 'getKp':
      return db.getKp(String(args.kpId ?? ''))
    case 'getBlock': {
      const block = db.getBlock(String(args.blockId ?? ''))
      if (!block) return undefined
      return {
        block,
        chapter: db.listChapters().find((item: { id: string }) => item.id === block.chapter_id),
        section: db.listSections(block.chapter_id).find((item: { id: string }) => item.id === block.section_id),
      }
    }
    case 'getResource': {
      const resourceId = String(args.resourceId ?? args.sourceId ?? '')
      if (resourceId.length === 0) return undefined
      const guide = db.getState<unknown>('resource', `guide/${resourceId}`)
      if (!guide || typeof guide !== 'object' || Array.isArray(guide)) return undefined
      const chapterId = 'chapter_id' in guide && typeof guide.chapter_id === 'string'
        ? guide.chapter_id
        : resourceId
      return { guide, chapter: db.listChapters().find((item: { id: string }) => item.id === chapterId) }
    }
    case 'listIdeology':
      return db.listIdeology()
    case 'news.list':
      return db.listNews({
        source: typeof args.source === 'string' ? args.source : undefined,
        since: typeof args.since === 'string' ? args.since : undefined,
        limit: typeof args.limit === 'number' ? args.limit : 20,
      })
    case 'news.status':
      return { count: db.countNews(), newestFetchedAt: db.newestNewsFetchedAt() ?? '' }
    case 'news.refresh': {
      const sources = Array.isArray(args.sources) ? args.sources.map(String) : undefined
      const outcome = await news.refresh(sources, { wait: false })
      await matcher.backfill(20)
      return {
        results: outcome.results,
        queued: outcome.queued,
        accepted: outcome.accepted,
        count: db.countNews(),
        newestFetchedAt: db.newestNewsFetchedAt() ?? '',
      }
    }
    case 'news.get': {
      const article = db.getNews(String(args.articleId ?? ''))
      if (!article) return undefined
      return {
        article,
        matches: db.getMatches(article.id),
        ideology: db.getIdeologyMatches(article.id),
      }
    }
    case 'news.match': {
      const result = await matcher.match({
        articleId: String(args.articleId ?? ''),
        topK: typeof args.topK === 'number' ? args.topK : 3,
      })
      return { matches: result.matches }
    }
    case 'questions.attempts':
      return db.listAttempts({
        studentId,
        questionIds: Array.isArray(args.questionIds) ? args.questionIds.map(String) : undefined,
        limit: typeof args.limit === 'number' ? args.limit : 200,
      })
    case 'profile.get':
      return profile.getProfile(studentId)
    case 'profile.growth':
      return profile.growthSummary(studentId, typeof args.chapterId === 'string' ? args.chapterId : undefined)
    case 'profile.evidence':
      return profile.listEvidence(studentId, {
        competencyId: typeof args.competencyId === 'string' ? args.competencyId : undefined,
        chapterId: typeof args.chapterId === 'string' ? args.chapterId : undefined,
        limit: typeof args.limit === 'number' ? args.limit : 100,
      })
    case 'profile.snapshot':
      return profile.recordSnapshot(
        studentId,
        String(args.chapterId ?? ''),
        args.checkpoint === 'pre' ? 'pre' : 'post',
      )
    case 'profile.review':
      db.updateEvidenceReview(
        String(args.evidenceId ?? ''),
        args.status === 'reviewed' || args.status === 'rejected' ? args.status : 'draft',
        String(args.note ?? ''),
      )
      return { ok: true }
    case 'artifacts.list':
      return artifacts.list(studentId, typeof args.limit === 'number' ? args.limit : 50)
    case 'artifacts.get':
      return artifacts.get(String(args.artifactId ?? ''))
    case 'artifacts.export':
      return artifacts.export(String(args.artifactId ?? ''), exportFormat(args.format))
    case 'memory.facts':
      return db.listMemoryFacts(studentId)
    case 'memory.episodes':
      return db.listMemoryEpisodes(studentId, typeof args.limit === 'number' ? args.limit : 50)
    case 'memory.summary':
      return profile.memorySummary(studentId)
    case 'memory.upsert':
      return profile.upsertMemoryFact({
        studentId,
        kind: (args.kind === 'goal' || args.kind === 'preference' || args.kind === 'constraint'
          || args.kind === 'background' || args.kind === 'self_assessment' || args.kind === 'open_question')
          ? args.kind
          : 'goal',
        key: String(args.key ?? ''),
        value: args.value,
      })
    case 'memory.delete':
      profile.deleteMemoryFact(String(args.factId ?? ''))
      return { ok: true }
    case 'chat.sessions':
      return db.listChatSessions(studentId)
    case 'chat.messages': {
      // **归属必须在这里挡**：`db.listChatMessages(sessionId)` 只按会话 id 取，不校验学生。
      // 之前这段注释写着「已在 AgentService/DB 层校验」，是错的——独立复核实测：
      // 用学生 A 的会话调 B 的 sessionId，能读到 B 的私密对话。
      // 会话不存在时返回空数组（界面显示空会话），不属于本人时抛错（不给内容，也不说存不存在以外的事）。
      const sessionId = String(args.sessionId ?? '')
      const session = db.getChatSession(sessionId)
      if (!session) return []
      if (session.student_id !== studentId) {
        throw new Error('这个会话不属于当前学生，换回自己的账号再看。')
      }
      return db.listChatMessages(sessionId)
    }
    case 'agent.snapshot':
      return agent.getSnapshot(
        studentId,
        typeof args.sessionId === 'string' ? args.sessionId : undefined,
        typeof args.chapterId === 'string' ? args.chapterId : undefined,
      )
    case 'agent.suggestions':
      return agent.suggestions(studentId, typeof args.sessionId === 'string' ? args.sessionId : undefined)
    case 'agent.turns':
      return agent.listTurns(String(args.sessionId ?? ''), typeof args.limit === 'number' ? args.limit : 50)
    case 'agent.ledger':
      return agent.listLedger(studentId)
    case 'agent.retry':
      await agent.retryLedger(studentId, String(args.sourceId ?? ''))
      return agent.listLedger(studentId)
    case 'agent.sessions': {
      const runtime = agent as unknown as { sessionSummaries?: (studentId: string) => unknown }
      return runtime.sessionSummaries ? runtime.sessionSummaries(studentId) : []
    }
    case 'files.reveal': {
      const reveal = host?.revealFile
      if (!reveal) needHost('revealFile')
      reveal!(String(args.path ?? ''))
      return { ok: true }
    }
    case 'files.preview': {
      const preview = host?.previewFile
      if (!preview) needHost('previewFile')
      return preview!(String(args.path ?? ''))
    }
    case 'files.openDialog': {
      const open = host?.openFileDialog
      if (!open) needHost('openFileDialog')
      return open!()
    }
    default:
      throw new Error(`unknown learning method: ${method}`)
  }
}

/** 导出格式归一：只有 md / html 是显式可选，其余按 docx。 */
export function exportFormat(value: unknown): 'md' | 'docx' | 'html' {
  return value === 'md' || value === 'html' ? value : 'docx'
}
