import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type OpenDialogOptions } from 'electron'
import { Context } from '@deepseek-ai/cordis'
import { basename, dirname, extname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
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
import { dispatchMethod } from '@learning-agent/dispatch'
import { DeepSeekLlm } from './llm.js'
import { friendlyError } from './errors.js'
import { startupFailure, startupHealth } from './health.js'
import { loadDotEnv } from './env.js'
import { SettingsStore } from './settings.js'
import { defaultBounds, MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, readWindowState, resolveAppHome, trackWindowState } from './window-state.js'
import { startNewsBackend, stopNewsBackend } from './news-backend.js'
import { TurnCanceller } from './turn-canceller.js'

/** Local demo identity; every service call receives it explicitly. */
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
let newsStartupTimer: NodeJS.Timeout | undefined
let settings: SettingsStore
let llm: DeepSeekLlm

async function initServices(): Promise<void> {
  // Electron 不读 .env；这里补进 process.env，已有变量优先。
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
  // `productName` changes Electron's userData dir; older settings sit under the
  // package name. Copy once, otherwise the stored API key is lost.
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
  const appHome = resolveAppHome()
  // Packaged builds ship a seeded database via electron-builder `extraResources`,
  // so it sits beside app.asar. Copy it on first run or the schema starts empty.
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
  const newsBaseUrl = await startNewsBackend({ appPath: app.getAppPath(), appHome })
  matcher = new Matcher(ctx)
  questionSmith = new QuestionSmith(ctx)
  research = new ResearchService(ctx)
  bp = new BpService(ctx)
  profileService = new ProfileService(ctx)
  artifacts = new ArtifactService(ctx, {
    appHome,
    templatesDir: join(app.getAppPath(), 'templates'),
  })
  newsService = new NewsService(ctx, {
    baseUrl: newsBaseUrl,
    apiKey: () => settings.read().apiKey,
  })
  agentRuntime = new AgentService(ctx)
}

function startNewsAutomation(): void {
  const minutes = Math.max(1, Number(process.env.LEARNING_AGENT_NEWS_REFRESH_MINUTES ?? 30) || 30)
  const tick = async (): Promise<void> => {
    try {
      // Python owns the real workers; this only asks it to collect when the
      // local library is empty/stale. It must never block the UI startup.
      await newsService.ensureFresh()
    } catch (error) {
      console.warn('[news] refresh request failed', error)
    }
    // Refresh only stores articles; tagging is separate so a slow tag pass
    // cannot block the fetch. Backfill also covers articles ingested earlier.
    await matcher.backfill(20)
  }
  newsTimer = setInterval(() => {
    void tick()
  }, minutes * 60_000)
  newsTimer.unref?.()
  // The Python service already starts every source immediately on boot; give it
  // one minute before the desktop's stale-check can enqueue a duplicate round.
  newsStartupTimer = setTimeout(() => {
    void tick()
  }, 60_000)
  newsStartupTimer.unref?.()
}

function createWindow(): void {
  // 上次关闭时的位置；显示器被拔掉时 readWindowState 会返回 undefined。
  const saved = readWindowState()
  const bounds = saved ?? defaultBounds()
  window = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    title: '营小商',
    backgroundColor: '#f7f7f5',
    webPreferences: {
      preload: join(app.getAppPath(), 'out', 'preload', 'index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  trackWindowState(window)
  if (saved?.maximized) window.maximize()
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
/** 桌面端专属：选一个本地文件并预览。Web 端用上传代替。 */
async function openFileDialog(): Promise<unknown> {
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

/**
 * 业务分发：真正的实现在 `@learning-agent/dispatch`，这里只做「Electron 侧适配」。
 *
 * 这样服务端化时不需要照抄一份业务逻辑（`packages/dispatch` 是唯一来源）。
 * `studentId` 桌面端仍允许入参覆盖（用于演示切换学生）；服务端必须改为从会话派生。
 */
async function invoke(method: string, input: unknown): Promise<unknown> {
  const args = (input ?? {}) as Record<string, unknown>
  const studentId = typeof args.studentId === 'string' && args.studentId.length > 0
    ? args.studentId
    : DEMO_STUDENT_ID
  return dispatchMethod(
    {
      db,
      news: newsService,
      matcher,
      profile: profileService,
      artifacts,
      agent: agentRuntime,
      host: {
        revealFile: (path) => { shell.showItemInFolder(path) },
        previewFile: (path) => previewFile(path),
        openFileDialog: openFileDialog,
      },
    },
    method,
    input,
    { studentId },
  )
}

/**
 * 只把可执行的中文提示交给界面；上游英文栈留在日志里。
 */
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  try {
    await initServices()
  } catch (error) {
    // 窗口还没建，学生只会看到「双击没反应」。这里必须自己说出来，并给一条自救路径。
    const failure = startupFailure(error)
    const appHome = resolveAppHome()
    const detail = `\n\n数据目录：${appHome}`
    if (!failure.canResetLocalData) {
      dialog.showErrorBox(failure.title, `${failure.body}${detail}`)
      app.exit(1)
      return
    }
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: failure.title,
      message: failure.title,
      detail: `${failure.body}${detail}`,
      buttons: ['备份旧数据并重置', '退出'],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice !== 0) {
      app.exit(1)
      return
    }
    try {
      const dbPath = join(appHome, 'data', 'learning.db')
      if (existsSync(dbPath)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        renameSync(dbPath, `${dbPath}.broken-${stamp}`)
      }
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${dbPath}${suffix}`
        if (existsSync(sidecar)) renameSync(sidecar, `${sidecar}.broken-${new Date().toISOString().replace(/[:.]/g, '-')}`)
      }
    } catch (resetError) {
      dialog.showErrorBox('重置失败', `没能移动旧数据文件：${resetError instanceof Error ? resetError.message : String(resetError)}${detail}`)
      app.exit(1)
      return
    }
    app.relaunch()
    app.exit(0)
    return
  }

  ipcMain.handle('learning:invoke', (_event, method: string, input: unknown) => invoke(method, input))
  // 每一轮对话一个控制器：学生点「停止」就中断在途模型请求。
  const turnCanceller = new TurnCanceller()
  ipcMain.handle('learning:cancel', (_event, requestId: unknown) => {
    const id = typeof requestId === 'string' ? requestId : ''
    return { cancelled: turnCanceller.cancel(id) }
  })

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
    const turn = turnCanceller.begin(requestId)
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
          // 必须真的把 signal 交给执行链，否则停止按钮只是界面上停、模型还在跑。
          // scripts/verify-cancel-wiring.ts 会断言这一行存在（源码级），
          // 因为只测 runAgentLoop 测不到这条接线。
          signal: turn.signal,
        },
      )
    } catch (error) {
      throw friendlyError(error)
    } finally {
      turn.done()
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
  }) => {
    try {
      return await agentRuntime.answerQuestionSet({
        studentId: input.studentId || DEMO_STUDENT_ID,
        sessionId: input.sessionId,
        artifactId: input.artifactId,
        answers: Array.isArray(input.answers) ? input.answers : [],
        chapterId: input.chapterId,
      })
    } catch (error) {
      // 交卷失败要说清「这次没记成成绩」，否则学生以为白答了。
      throw friendlyError(error, { context: 'answer' })
    }
  })
  ipcMain.handle('learning:health', () => {
    const health = startupHealth({
      chapters: db.listChapters().length,
      knowledgePoints: db.listChapters().reduce((sum, chapter) => sum + db.listKpsByChapter(chapter.id).length, 0),
      newsArticles: db.countNews(),
    })
    return { ...health, appHome: resolveAppHome() }
  })
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
  if (newsStartupTimer) clearTimeout(newsStartupTimer)
  stopNewsBackend()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
