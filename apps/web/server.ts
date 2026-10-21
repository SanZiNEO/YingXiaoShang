import { timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { AgentService } from '@learning-agent/agent'
import { ArtifactService } from '@learning-agent/artifacts'
import { BpService } from '@learning-agent/bp'
import LearningDb from '@learning-agent/db'
import { Matcher } from '@learning-agent/matcher'
import { NewsService } from '@learning-agent/news'
import { ProfileService } from '@learning-agent/profile'
import { QuestionSmith } from '@learning-agent/questions'
import { ResearchService } from '@learning-agent/research'
import { DeepSeekLlm } from '../desktop/src/main/llm.js'
import { SettingsStore } from '../desktop/src/main/settings.js'

const ROOT_DIR = dirname(fileURLToPath(import.meta.url))
const DIST_DIR = join(ROOT_DIR, 'dist')
const TEMPLATES_DIR = join(ROOT_DIR, '..', 'desktop', 'templates')
const DEMO_STUDENT_ID = 'student_demo'
const MAX_BODY_BYTES = 2 * 1024 * 1024

const configuredPort = Number(process.env.LEARNING_AGENT_WEB_PORT ?? 3081)
const PORT = Number.isFinite(configuredPort) && configuredPort > 0 ? configuredPort : 3081
const ACCESS_TOKEN = (process.env.LEARNING_AGENT_ACCESS_TOKEN ?? '').trim()
const configuredHost = (process.env.LEARNING_AGENT_WEB_HOST ?? '').trim()
const HOST = configuredHost || (ACCESS_TOKEN.length > 0 ? '0.0.0.0' : '127.0.0.1')
const LOOPBACK_HOSTS: Record<string, true> = { '127.0.0.1': true, localhost: true, '::1': true }
const IS_LOOPBACK = LOOPBACK_HOSTS[HOST] === true

let appHome = ''
let db: LearningDb
let matcher: Matcher
let questionSmith: QuestionSmith
let research: ResearchService
let bp: BpService
let profileService: ProfileService
let artifacts: ArtifactService
let agentRuntime: AgentService
let newsService: NewsService
let settings: SettingsStore
let llm: DeepSeekLlm
let newsTimer: NodeJS.Timeout | undefined

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

/** 上游英文错误不直出给浏览器；能给出行动建议的就翻译一句。 */
async function withFriendlyError<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof HttpError) throw error
    const raw = error instanceof Error ? error.message : String(error)
    if (/DEEPSEEK_API_KEY is not configured|请先在设置中填写/.test(raw)) {
      throw new HttpError(503, '还没配置模型密钥：在服务端设置 DEEPSEEK_API_KEY 后重启即可。')
    }
    if (/401|invalid.?api.?key|unauthori[sz]ed/i.test(raw)) {
      throw new HttpError(502, '模型密钥无效或已过期，请更换 DEEPSEEK_API_KEY。')
    }
    if (/429|rate.?limit/i.test(raw)) throw new HttpError(503, '模型调用太频繁，请稍后再试。')
    throw new HttpError(502, '模型这次没有返回结果，可以再发一次。')
  }
}

async function initServices(): Promise<void> {
  process.env.LEARNING_AGENT_PROMPT_ROOTS ||= join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'agent')
  appHome = process.env.LEARNING_AGENT_HOME || join(homedir(), '.learning-agent')
  settings = new SettingsStore(join(appHome, 'settings.json'))
  llm = new DeepSeekLlm(() => settings.read())
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
    templatesDir: TEMPLATES_DIR,
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
    case 'files.preview':
    case 'files.openDialog':
      throw new HttpError(400, '浏览器版不读取本地文件；请使用桌面客户端打开本地文件。')
    default:
      throw new HttpError(400, `unknown learning method: ${method}`)
  }
}

function tokenMatches(authorization: string | undefined): boolean {
  if (!ACCESS_TOKEN) return true
  if (!authorization || !authorization.startsWith('Bearer ')) return false
  const provided = Buffer.from(authorization.slice('Bearer '.length))
  const expected = Buffer.from(ACCESS_TOKEN)
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '请求体过大')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new HttpError(400, '请求体不是合法的 JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, '请求体必须是 JSON 对象')
  }
  return value as Record<string, unknown>
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function sendText(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(message),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(message)
}

function methodNotAllowed(res: ServerResponse, allowed: string): void {
  res.setHeader('allow', allowed)
  sendJson(res, 405, { error: `method not allowed; use ${allowed}` })
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  const relative = pathname.replace(/^\/+/, '')
  let target = resolve(DIST_DIR, relative.length > 0 ? relative : 'index.html')
  if (target !== DIST_DIR && !target.startsWith(DIST_DIR + sep)) return false
  let info = await stat(target).catch(() => undefined)
  if (info?.isDirectory()) {
    target = join(target, 'index.html')
    info = await stat(target).catch(() => undefined)
  }
  if (!info?.isFile()) return false

  const extension = extname(target).toLowerCase()
  const cacheControl = pathname.startsWith('/assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache'
  res.writeHead(200, {
    'content-type': MIME_TYPES[extension] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': cacheControl,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  if (req.method === 'HEAD') {
    res.end()
    return true
  }
  const stream = createReadStream(target)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
  return true
}

async function downloadArtifact(res: ServerResponse, artifactId: string, format: 'md' | 'docx' | 'html'): Promise<void> {
  const artifact = artifacts.get(artifactId)
  if (!artifact || artifact.student_id !== DEMO_STUDENT_ID) throw new HttpError(404, '产物不存在')
  // 页面类产物只有 HTML 原件，不存在 md/docx 版本。
  const actual = artifact.format === 'html' ? 'html' : format === 'docx' ? 'docx' : 'md'
  const exported = await artifacts.export(artifactId, actual)
  const target = resolve(exported.path)
  const homeRoot = resolve(appHome)
  if (!target.startsWith(homeRoot + sep) || basename(target) !== `${artifact.id}.${actual}`) {
    throw new HttpError(400, '导出路径不合法')
  }
  const bytes = await readFile(target)
  const safeTitle = artifact.title
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || `artifact-${artifact.id}`
  const filename = `${safeTitle}.${actual}`
  const asciiName = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_')
  res.writeHead(200, {
    'content-type': actual === 'md'
      ? 'text/markdown; charset=utf-8'
      : actual === 'html'
        ? 'text/html; charset=utf-8'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'content-length': bytes.length,
    'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(bytes)
}

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  if (!tokenMatches(req.headers.authorization)) {
    sendJson(res, 401, { error: '未授权：缺少或无效的访问令牌' })
    return
  }

  if (pathname === '/api/health') {
    if (req.method !== 'GET') {
      methodNotAllowed(res, 'GET')
      return
    }
    sendJson(res, 200, {
      ok: true,
      home: appHome,
      bindHost: HOST,
      authRequired: ACCESS_TOKEN.length > 0,
      capabilities: { localFiles: false, revealFiles: false, downloadArtifacts: 'browser' },
      news: { count: db.countNews(), newestFetchedAt: db.newestNewsFetchedAt() ?? '' },
      uptimeSeconds: Math.round(process.uptime()),
    })
    return
  }

  if (pathname === '/api/capabilities') {
    if (req.method !== 'GET') {
      methodNotAllowed(res, 'GET')
      return
    }
    sendJson(res, 200, {
      localFiles: false,
      revealFiles: false,
      downloadArtifacts: 'browser',
      authRequired: ACCESS_TOKEN.length > 0,
    })
    return
  }

  if (pathname.startsWith('/api/artifacts/') && pathname.endsWith('/download')) {
    if (req.method !== 'GET') {
      methodNotAllowed(res, 'GET')
      return
    }
    const match = /^\/api\/artifacts\/([^/]+)\/download$/.exec(pathname)
    if (!match) throw new HttpError(404, '未知下载地址')
    const format = new URL(req.url ?? '/', 'http://localhost').searchParams.get('format')
    await downloadArtifact(res, decodeURIComponent(match[1]!), format === 'docx' ? 'docx' : format === 'html' ? 'html' : 'md')
    return
  }

  if (pathname === '/api/invoke') {
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST')
      return
    }
    const body = await readJson(req)
    const method = typeof body.method === 'string' ? body.method : ''
    if (method.length === 0) throw new HttpError(400, '缺少 method')
    sendJson(res, 200, { result: await invoke(method, body.input) })
    return
  }

  if (pathname === '/api/chat') {
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST')
      return
    }
    const body = await readJson(req)
    const message = typeof body.message === 'string' ? body.message : ''
    if (message.trim().length === 0) throw new HttpError(400, '消息不能为空')
    const result = await withFriendlyError(() => agentRuntime.handleConversation({
      studentId: typeof body.studentId === 'string' && body.studentId.length > 0
        ? body.studentId
        : DEMO_STUDENT_ID,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
      message,
      scopeOverride: body.scopeOverride as never,
      chapterId: typeof body.chapterId === 'string' ? body.chapterId : undefined,
    }))
    sendJson(res, 200, { result })
    return
  }

  if (pathname === '/api/answer') {
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST')
      return
    }
    const body = await readJson(req)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const questionId = typeof body.questionId === 'string' ? body.questionId : ''
    if (sessionId.length === 0 || questionId.length === 0 || typeof body.answer !== 'string') {
      throw new HttpError(400, 'sessionId、questionId 与 answer 均为必填')
    }
    const result = await agentRuntime.answerQuestion({
      studentId: typeof body.studentId === 'string' && body.studentId.length > 0
        ? body.studentId
        : DEMO_STUDENT_ID,
      sessionId,
      questionId,
      answer: body.answer,
      artifactId: typeof body.artifactId === 'string' ? body.artifactId : undefined,
      chapterId: typeof body.chapterId === 'string' ? body.chapterId : undefined,
    })
    sendJson(res, 200, { result })
    return
  }

  if (pathname === '/api/answer-set') {
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST')
      return
    }
    const body = await readJson(req)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const artifactId = typeof body.artifactId === 'string' ? body.artifactId : ''
    if (sessionId.length === 0 || artifactId.length === 0) {
      throw new HttpError(400, 'sessionId 与 artifactId 均为必填')
    }
    const result = await agentRuntime.answerQuestionSet({
      studentId: typeof body.studentId === 'string' && body.studentId.length > 0
        ? body.studentId
        : DEMO_STUDENT_ID,
      sessionId,
      artifactId,
      answers: Array.isArray(body.answers) ? body.answers as Array<{ questionId: string; answer: string }> : [],
      chapterId: typeof body.chapterId === 'string' ? body.chapterId : undefined,
    })
    sendJson(res, 200, { result })
    return
  }

  if (pathname === '/api/settings') {
    if (req.method === 'GET') {
      sendJson(res, 200, { result: settings.readPublic() })
      return
    }
    if (req.method === 'POST') {
      const body = await readJson(req)
      sendJson(res, 200, {
        result: settings.write({
          apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
          model: typeof body.model === 'string' ? body.model : undefined,
          clearApiKey: body.clearApiKey === true,
        }),
      })
      return
    }
    methodNotAllowed(res, 'GET, POST')
    return
  }

  sendJson(res, 404, { error: `unknown api route: ${pathname}` })
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
  } catch {
    sendText(res, 400, 'Bad Request')
    return
  }

  if (pathname.startsWith('/api/')) {
    await handleApi(req, res, pathname)
    return
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method Not Allowed')
    return
  }

  if (await serveStatic(req, res, pathname)) return

  if (extname(pathname).length === 0) {
    if (await serveStatic(req, res, '/index.html')) return
  }

  const indexExists = await stat(join(DIST_DIR, 'index.html')).catch(() => undefined)
  if (!indexExists?.isFile()) {
    sendText(res, 503, '前端尚未构建：请先运行 pnpm --dir apps/web build')
    return
  }
  sendText(res, 404, 'Not Found')
}

async function main(): Promise<void> {
  if (!ACCESS_TOKEN && !IS_LOOPBACK) {
    console.error('[web] 拒绝启动：绑定非本机地址必须设置 LEARNING_AGENT_ACCESS_TOKEN。')
    console.error('[web] 公网部署请设置令牌，并通过 HTTPS 反向代理访问。')
    process.exit(1)
  }
  await initServices()
  startNewsAutomation()

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message })
        return
      }
      console.error('[web] request failed', error)
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })

  server.on('error', (error) => {
    console.error('[web] server error', error)
    process.exit(1)
  })

  server.listen(PORT, HOST, () => {
    console.log(`[web] listening on http://${HOST}:${PORT}`)
    console.log(`[web] home: ${appHome}`)
    console.log(`[web] static: ${DIST_DIR}`)
    console.log(`[web] access token: ${ACCESS_TOKEN ? 'required' : 'disabled'}`)
    console.log(`[web] bind scope: ${IS_LOOPBACK ? '本机回环' : '非本机（公网/容器）'}`)
    if (!IS_LOOPBACK) {
      console.log('[web] 公网访问必须通过 HTTPS 反向代理；令牌模式已启用。')
    }
  })

  const shutdown = (signal: string): void => {
    console.log(`[web] ${signal} received, shutting down`)
    clearInterval(newsTimer)
    const force = setTimeout(() => {
      server.closeAllConnections()
      process.exit(1)
    }, 5000)
    force.unref()
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

void main().catch((error: unknown) => {
  console.error('[web] failed to start', error)
  process.exit(1)
})
