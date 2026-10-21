import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type OpenDialogOptions } from 'electron'
import { Context } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import mammoth from 'mammoth'
import LearningDb from '@learning-agent/db'
import { Matcher } from '@learning-agent/matcher'
import { QuestionSmith } from '@learning-agent/questions'
import { ResearchService } from '@learning-agent/research'
import { BpService } from '@learning-agent/bp'
import { ProfileService } from '@learning-agent/profile'
import { ArtifactService } from '@learning-agent/artifacts'
import { AgentService } from '@learning-agent/agent'
import { NewsService } from '@learning-agent/news'
import { DeepSeekLlm } from './llm.js'
import { loadDotEnv } from './env.js'
import { SettingsStore } from './settings.js'

/** The local demo identity. Every service call still receives it explicitly. */
const DEMO_STUDENT_ID = 'student_demo'

let window: BrowserWindow | undefined
let db: LearningDb
let matcher: Matcher
let questionSmith: QuestionSmith
let research: ResearchService
let bp: BpService
let profileService: ProfileService
let artifacts: ArtifactService
let agentRuntime: AgentService
let newsService: NewsService
let newsTimer: NodeJS.Timeout | undefined
let settings: SettingsStore
let llm: DeepSeekLlm

async function initServices(): Promise<void> {
  // 老师习惯把 key 写在 .env；Electron 不会自动读，这里补上（已存在环境变量优先）。
  loadDotEnv([
    process.cwd(),
    join(app.getAppPath(), '..', '..'),
    app.getAppPath(),
  ])
  // Agent prompts ship as resources/prompts; in dev they live in the workspace.
  process.env.LEARNING_AGENT_PROMPT_ROOTS = [
    join(process.resourcesPath, 'prompts'),
    join(app.getAppPath(), '..', '..', 'packages', 'agent'),
  ].join(';')
  // Adding `productName` renamed Electron's userData directory, so settings
  // written by an earlier build live under the package name. Carry them over
  // once instead of silently losing the student's API key.
  const settingsPath = join(app.getPath('userData'), 'settings.json')
  if (!existsSync(settingsPath)) {
    const legacyPath = join(app.getPath('appData'), '@learning-agent', 'desktop', 'settings.json')
    if (existsSync(legacyPath)) {
      mkdirSync(dirname(settingsPath), { recursive: true })
      copyFileSync(legacyPath, settingsPath)
    }
  }
  settings = new SettingsStore(settingsPath)
  llm = new DeepSeekLlm(() => settings.read())
  const appHome = process.env.LEARNING_AGENT_HOME || join(homedir(), '.learning-agent')
  // A packaged build ships a seeded database (electron-builder `extraResources`,
  // so it sits beside app.asar). Copy it on first run so the app opens with
  // chapters, textbook tags, and news instead of an empty schema.
  const dbPath = join(appHome, 'data', 'learning.db')
  if (!existsSync(dbPath)) {
    const seedPath = [
      join(process.resourcesPath, 'seed', 'learning.db'),
      join(app.getAppPath(), 'seed', 'learning.db'),
    ].find((candidate) => existsSync(candidate))
    if (seedPath) {
      mkdirSync(dirname(dbPath), { recursive: true })
      copyFileSync(seedPath, dbPath)
    }
  }
  const ctx = new Context()
  ctx.provide('llm', llm)
  await ctx.plugin(LearningDb, { appHome })
  db = ctx.learningDb
  matcher = new Matcher(ctx)
  questionSmith = new QuestionSmith(ctx)
  research = new ResearchService(ctx)
  bp = new BpService(ctx)
  profileService = new ProfileService(ctx)
  artifacts = new ArtifactService(ctx, {
    appHome,
    templatesDir: join(app.getAppPath(), 'templates'),
  })
  newsService = new NewsService(ctx, { apiKey: () => settings.read().apiKey })
  agentRuntime = new AgentService(ctx)
}

function startNewsAutomation(): void {
  const minutes = Math.max(1, Number(process.env.LEARNING_AGENT_NEWS_REFRESH_MINUTES ?? 30) || 30)
  const tick = async (): Promise<void> => {
    await newsService.ensureFresh()
    // Refresh only stores articles; tagging is separate so a slow tag pass
    // cannot block the fetch. Backfill also covers articles ingested earlier.
    await matcher.backfill(20)
  }
  newsTimer = setInterval(() => {
    void tick()
  }, minutes * 60_000)
  newsTimer.unref?.()
  void tick()
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 700,
    title: '营小商',
    backgroundColor: '#f7f7f5',
    webPreferences: {
      preload: join(app.getAppPath(), 'out', 'preload', 'index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  window.on('closed', () => {
    window = undefined
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(app.getAppPath(), 'out', 'renderer', 'index.html'))
  }
}

interface FilePreview {
  path: string
  name: string
  kind: 'markdown' | 'html' | 'text' | 'image' | 'pdf' | 'unsupported'
  content: string
  mime: string
}

async function previewFile(filePath: string): Promise<FilePreview> {
  const extension = extname(filePath).toLowerCase()
  const name = basename(filePath)
  if (extension === '.md' || extension === '.markdown') {
    return { path: filePath, name, kind: 'markdown', content: await readFile(filePath, 'utf8'), mime: 'text/markdown' }
  }
  if (extension === '.docx') {
    const result = await mammoth.convertToHtml({ path: filePath })
    return { path: filePath, name, kind: 'html', content: result.value, mime: 'text/html' }
  }
  if (extension === '.html' || extension === '.htm') {
    // 页面类产物落库就是 .html，前端用沙箱 iframe 渲染。
    return { path: filePath, name, kind: 'html', content: await readFile(filePath, 'utf8'), mime: 'text/html' }
  }
  if (['.txt', '.csv', '.json'].includes(extension)) {
    return { path: filePath, name, kind: 'text', content: await readFile(filePath, 'utf8'), mime: 'text/plain' }
  }
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(extension)) {
    const buffer = await readFile(filePath)
    const mime = extension === '.svg' ? 'image/svg+xml' : `image/${extension === '.jpg' ? 'jpeg' : extension.slice(1)}`
    return { path: filePath, name, kind: 'image', content: `data:${mime};base64,${buffer.toString('base64')}`, mime }
  }
  if (extension === '.pdf') {
    const buffer = await readFile(filePath)
    return { path: filePath, name, kind: 'pdf', content: `data:application/pdf;base64,${buffer.toString('base64')}`, mime: 'application/pdf' }
  }
  return { path: filePath, name, kind: 'unsupported', content: '', mime: 'application/octet-stream' }
}

/** 导出格式只认这三种；其余按 Word 处理。 */
function exportFormat(value: unknown): 'md' | 'docx' | 'html' {
  return value === 'md' || value === 'html' ? value : 'docx'
}

async function invoke(method: string, input: unknown): Promise<unknown> {
  const args = (input ?? {}) as Record<string, unknown>
  const studentId = typeof args.studentId === 'string' && args.studentId.length > 0
    ? args.studentId
    : DEMO_STUDENT_ID
  switch (method) {
    case 'student.current': {
      const profile = db.getStudentProfile(studentId)
      return { studentId, name: profile?.name ?? '学生', cohort: profile?.cohort ?? '' }
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
        chapter: db.listChapters().find((item) => item.id === block.chapter_id),
        section: db.listSections(block.chapter_id).find((item) => item.id === block.section_id),
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
      return {
        guide,
        chapter: db.listChapters().find((item) => item.id === chapterId),
      }
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
      return {
        count: db.countNews(),
        newestFetchedAt: db.newestNewsFetchedAt() ?? '',
      }
    case 'news.refresh': {
      const sources = Array.isArray(args.sources) ? args.sources.map(String) : undefined
      const results = await newsService.refresh(sources)
      await matcher.backfill(20)
      return {
        results,
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
      return profileService.getProfile(studentId)
    case 'profile.growth':
      return profileService.growthSummary(studentId, typeof args.chapterId === 'string' ? args.chapterId : undefined)
    case 'profile.evidence':
      return profileService.listEvidence(studentId, {
        competencyId: typeof args.competencyId === 'string' ? args.competencyId : undefined,
        chapterId: typeof args.chapterId === 'string' ? args.chapterId : undefined,
        limit: typeof args.limit === 'number' ? args.limit : 100,
      })
    case 'profile.snapshot':
      return profileService.recordSnapshot(
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
      return profileService.memorySummary(studentId)
    case 'memory.upsert':
      return profileService.upsertMemoryFact({
        studentId,
        kind: (args.kind === 'goal' || args.kind === 'preference' || args.kind === 'constraint'
          || args.kind === 'background' || args.kind === 'self_assessment' || args.kind === 'open_question')
          ? args.kind
          : 'goal',
        key: String(args.key ?? ''),
        value: args.value,
      })
    case 'memory.delete':
      profileService.deleteMemoryFact(String(args.factId ?? ''))
      return { ok: true }
    case 'chat.sessions':
      return db.listChatSessions(studentId)
    case 'chat.messages':
      return db.listChatMessages(String(args.sessionId ?? ''))
    case 'agent.snapshot':
      return agentRuntime.getSnapshot(
        studentId,
        typeof args.sessionId === 'string' ? args.sessionId : undefined,
        typeof args.chapterId === 'string' ? args.chapterId : undefined,
      )
    case 'agent.suggestions':
      return agentRuntime.suggestions(
        studentId,
        typeof args.sessionId === 'string' ? args.sessionId : undefined,
      )
    case 'agent.turns':
      return agentRuntime.listTurns(String(args.sessionId ?? ''), typeof args.limit === 'number' ? args.limit : 50)
    case 'agent.ledger':
      return agentRuntime.listLedger(studentId)
    case 'agent.retry':
      await agentRuntime.retryLedger(studentId, String(args.sourceId ?? ''))
      return agentRuntime.listLedger(studentId)
    case 'agent.sessions': {
      const runtime = agentRuntime as unknown as { sessionSummaries?: (studentId: string) => unknown }
      return runtime.sessionSummaries ? runtime.sessionSummaries(studentId) : []
    }
    case 'files.reveal':
      shell.showItemInFolder(String(args.path ?? ''))
      return { ok: true }
    case 'files.preview':
      return previewFile(String(args.path ?? ''))
    case 'files.openDialog': {
      const options: OpenDialogOptions = {
        title: '打开学习资料',
        properties: ['openFile'],
        filters: [
          { name: '学习资料', extensions: ['md', 'docx', 'pdf', 'png', 'jpg', 'jpeg', 'webp', 'txt', 'csv'] },
          { name: '全部文件', extensions: ['*'] },
        ],
      }
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return undefined
      return previewFile(result.filePaths[0]!)
    }
    default:
      throw new Error(`unknown learning method: ${method}`)
  }
}

/**
 * 学生只该看到可执行的中文提示；上游英文栈留在日志里。
 */
function friendlyError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error)
  const stripped = raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
  if (/DEEPSEEK_API_KEY is not configured|请先在设置中填写/.test(stripped)) {
    return new Error('还没配置模型密钥：点左下角「设置」填入 DeepSeek Key 后再发一次。')
  }
  if (/401|invalid.?api.?key|unauthori[sz]ed/i.test(stripped)) {
    return new Error('模型密钥无效或已过期，请在「设置」里重新填写。')
  }
  if (/429|rate.?limit/i.test(stripped)) {
    return new Error('模型调用太频繁了，等几秒再发一次。')
  }
  if (/timeout|aborted|ETIMEDOUT|ECONNRESET/i.test(stripped)) {
    return new Error('模型响应超时，这一段没有记成你的作答，可以直接重发。')
  }
  return new Error(stripped)
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  await initServices()

  ipcMain.handle('learning:invoke', (_event, method: string, input: unknown) => invoke(method, input))
  ipcMain.handle('learning:chat', async (event, input: {
    studentId?: string
    sessionId?: string
    message: string
    scopeOverride?: unknown
    chapterId?: string
    requestId?: string
  }) => {
    const studentId = input.studentId || DEMO_STUDENT_ID
    if (typeof input.message !== 'string' || input.message.trim().length === 0) {
      throw new Error('消息不能为空')
    }
    const requestId = typeof input.requestId === 'string' ? input.requestId : ''
    try {
      return await agentRuntime.handleConversation(
        {
          studentId,
          sessionId: input.sessionId,
          message: input.message,
          scopeOverride: input.scopeOverride as never,
          chapterId: input.chapterId,
        },
        {
          // 把执行进度实时推给界面：先让字出来，再让整轮结束。
          onEvent: (step) => {
            if (event.sender.isDestroyed()) return
            event.sender.send('learning:chat-event', { requestId, ...step })
          },
        },
      )
    } catch (error) {
      throw friendlyError(error)
    }
  })
  ipcMain.handle('learning:answer', async (_event, input: {
    studentId?: string
    sessionId: string
    questionId: string
    answer: string
    artifactId?: string
    chapterId?: string
  }) => agentRuntime.answerQuestion({
    studentId: input.studentId || DEMO_STUDENT_ID,
    sessionId: input.sessionId,
    questionId: input.questionId,
    answer: input.answer,
    artifactId: input.artifactId,
    chapterId: input.chapterId,
  }))
  ipcMain.handle('learning:answer-set', async (_event, input: {
    studentId?: string
    sessionId: string
    artifactId: string
    answers: Array<{ questionId: string; answer: string }>
    chapterId?: string
  }) => agentRuntime.answerQuestionSet({
    studentId: input.studentId || DEMO_STUDENT_ID,
    sessionId: input.sessionId,
    artifactId: input.artifactId,
    answers: Array.isArray(input.answers) ? input.answers : [],
    chapterId: input.chapterId,
  }))
  ipcMain.handle('learning:settings:get', () => settings.readPublic())
  ipcMain.handle('learning:settings:set', (_event, value: { apiKey?: string; model?: string; clearApiKey?: boolean }) => settings.write(value))

  createWindow()
  startNewsAutomation()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  clearInterval(newsTimer)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
