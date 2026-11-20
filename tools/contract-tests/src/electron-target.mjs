/**
 * Electron 目标 —— 复用 tools/automated-testing 的 driver，把同一套契约用例打到本地 Electron。
 *
 * 启动约束（03-implementation §3.4、01-scope §3 第 6-7 条、04-acceptance AC-12）：
 *   - 本文件绝不自己起 Electron，也不直接 `import _electron` 或 `import '@playwright/test'`；
 *     唯一启动入口是 tools/automated-testing/src/driver/electron-driver.ts 导出的 `launchElectron`。
 *   - driver 是 .ts，经 tools/automated-testing 已装的 tsx 动态载入：用 createRequire 指向该包
 *     package.json，`resolve('tsx/esm/api')` 拿到 tsImport，再 `tsImport(driver file URL, import.meta.url)`。
 *   - 关闭一律走 driver 句柄的 `close()`，复用其进程树清理与端口释放逻辑；本文件不 kill 不明进程。
 *
 * 桥接口径：所有调用都在 `handle.page.evaluate` 里对 `window.learning.<fn>(...)` 发起
 * （fn: invoke / chat / cancel / answer / answerSet / health，见 apps/desktop/src/preload/index.ts:3-43）。
 *
 * 事件流口径（为什么 stream 的帧是「合成」的，而不是逐帧采集）：
 *   桌面端 IPC `learning:chat` 是一次性 `ipcRenderer.invoke`，返回整轮 TurnResponse；
 *   增量进度只经 `learning:chat-event` 推送给界面（preload 的 onChatEvent），它不是 SSE，
 *   桌面端也没有事件流通道。因此 CollectedStream 的 session / text / done 帧由这一次桥接返回值合成：
 *     session ← requestId / sessionId；
 *     text    ← TurnResponse.text 按中文句读切 1-3 段；
 *     done    ← 终态全量字段（turnId/sessionId/text/artifacts/citations/warnings）。
 *   这与 http 目标逐帧解析 SSE 的采集路径不同，但下游断言面对的是同一份 CollectedStream 形状。
 *
 * 差异如实暴露（01-scope §4）：桌面端是宽容实现。桥接 reject 时不伪造 BAD_REQUEST / NOT_FOUND /
 * FORBIDDEN / UNKNOWN_METHOD，统一记 `CLIENT_REJECTED` + httpStatus 0；health 快照缺字段就按缺字段
 * 返回，不补假值；取不到的 discovery 键不放进 discovery（依赖它的用例自动 skipped）。
 */

import net from 'node:net'
import { createRequire } from 'node:module'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { TargetUnreachable } from './target-interface.mjs'
import { newRequestId } from './fixtures.mjs'

/** 空闲端口：net.createServer().listen(0) 让操作系统分配，取到后立刻关闭（同 driver ports.ts:3 思路）。 */
function allocatePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('未能从操作系统分配到端口')))
        return
      }
      const port = address.port
      server.close(() => resolvePort(port))
    })
  })
}

/** 短随机 id：隔离目录名一眼能区分本轮实例，不要求密码学强度。 */
function shortId() {
  return Math.random().toString(36).slice(2, 8)
}

/** 身份构造守卫：桌面端没有 token 概念，也只有本机一个学生；这类探针在 electron 上不适用，如实拒答。 */
function identityGuard(opts = {}) {
  if (opts.auth === false) {
    return { code: 'CLIENT_REJECTED', message: 'electron 目标没有 token 概念，AUTH_REQUIRED 探针不适用' }
  }
  if (opts.auth === 'invalid') {
    return { code: 'CLIENT_REJECTED', message: 'electron 目标没有 token 概念，AUTH_INVALID 探针不适用' }
  }
  if (opts.asStudent === 'B') {
    return {
      code: 'CLIENT_REJECTED',
      message: 'electron 桥接只有本机一个学生，构造不出第二个身份来验证 403 越权（01-scope §4 差异表）',
    }
  }
  return null
}

/** reject 信封：httpStatus 0 占位，不映射成 HTTP 契约里的 400/401/403/404。 */
function rejectEnvelope(error, requestId, elapsedMs) {
  const message = error instanceof Error ? error.message : String(error ?? '未知错误')
  return {
    ok: false,
    error: { code: 'CLIENT_REJECTED', message },
    requestId,
    elapsedMs,
    httpStatus: 0,
  }
}

/** 把一轮正文按中文句读切成 1-3 段；切不出来就整段返回，不编造正文。 */
function splitTurnText(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const sentences = text.match(/[^。！？!?…]+[。！？!?…]*|\s+/g) ?? [text]
  const cleaned = sentences.map((item) => item.trim()).filter(Boolean)
  if (cleaned.length === 0) return [text]
  if (cleaned.length <= 3) return cleaned
  const size = Math.ceil(cleaned.length / 3)
  const chunks = []
  for (let index = 0; index < cleaned.length; index += size) {
    chunks.push(cleaned.slice(index, index + size).join(''))
  }
  return chunks.slice(0, 3)
}

/** 从列表/台账首条记录里取 ID，兼容 camel / snake / 台账 sourceId 等字段名；取不到返回 null。 */
function pickId(record, aliases) {
  if (record === null || typeof record !== 'object') return null
  for (const alias of aliases) {
    const value = record[alias]
    if (typeof value === 'string' && value.length > 0) return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

export class ElectronTarget {
  constructor({ home, repoRoot, pkgRoot }) {
    this.kind = 'electron'
    this.home = home
    this.repoRoot = repoRoot
    this.pkgRoot = pkgRoot
    this.handle = null
    this.discovery = {}
    this.userDataDir = null
    this.userDataDirRel = null
    this.newsPort = null
    this.launchMs = null
    this.mainPid = null
    this.launchHealth = null
    this.closeReport = null
    this.driver = null
    // describe 快照：run.mjs 先取 describe() 再 close()，这里保留同一引用，
    // close() 后把 CloseReport 字段补进同一对象，报告环境段才能看到退出码/强制/端口释放。
    this.describeSnapshot = null
  }

  /** 经 tsx 动态载入 driver（.ts）；不在模块顶层 import，避免 E 包静态依赖 playwright。 */
  async loadDriver() {
    if (this.driver) return this.driver
    const testingRequire = createRequire(join(this.repoRoot, 'tools', 'automated-testing', 'package.json'))
    const tsxApiPath = testingRequire.resolve('tsx/esm/api')
    const tsxApi = await import(pathToFileURL(tsxApiPath).href)
    const driverUrl = pathToFileURL(
      join(this.repoRoot, 'tools', 'automated-testing', 'src', 'driver', 'electron-driver.ts'),
    ).href
    this.driver = await tsxApi.tsImport(driverUrl, import.meta.url)
    return this.driver
  }

  async connect() {
    const startedAt = Date.now()
    this.newsPort = await allocatePort()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    this.userDataDir = join(this.repoRoot, '.scratch', 'run', 'E', `electron-userdata-${stamp}-${shortId()}`)
    this.userDataDirRel = relative(this.repoRoot, this.userDataDir).split(sep).join('/')

    let launchElectron
    try {
      const driver = await this.loadDriver()
      launchElectron = driver.launchElectron
    } catch (error) {
      throw new TargetUnreachable(`Electron 拉不起来：driver 载入失败（${error?.name ?? 'Error'}）：${error?.message ?? String(error)}`)
    }

    try {
      this.handle = await launchElectron({
        kind: 'out',
        home: this.home,
        userDataDir: this.userDataDir,
        newsPort: this.newsPort,
        launchTimeoutMs: 60000,
      })
    } catch (error) {
      throw new TargetUnreachable(`Electron 拉不起来：${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`)
    }

    this.launchMs = Date.now() - startedAt
    this.mainPid = this.handle.mainPid ?? null
    this.launchHealth = this.handle.health ?? null
    this.describeSnapshot = this.buildDescribe()
    await this.discover()
  }

  /** 桥接只读调用；失败不抛，返回 null，让对应 discovery 键留空（02-contract §3.1 不编造 ID）。 */
  async firstRecord(method, params) {
    const records = await this.allRecords(method, params)
    return records[0] ?? null
  }

  /** 全部记录（数组或 {items} 信封），失败回空数组：只读探测取不到就留空，不抛。 */
  async allRecords(method, params) {
    try {
      const result = await this.bridge('invoke', [method, params ?? {}])
      if (Array.isArray(result)) return result
      if (result && Array.isArray(result.items)) return result.items
      return []
    } catch {
      return []
    }
  }

  async discover() {
    const [chapter, article, session, artifact, fact, evidence, attempt, ledger] = await Promise.all([
      this.firstRecord('chapters.list', {}),
      this.firstRecord('news.list', { limit: 1 }),
      this.firstRecord('chat.sessions', {}),
      this.firstRecord('artifacts.list', {}),
      this.firstRecord('memory.facts', {}),
      this.firstRecord('profile.evidence', {}),
      this.firstRecord('questions.attempts', {}),
      this.firstRecord('agent.ledger', {}),
    ])
    const mapping = {
      chapterId: pickId(chapter, ['id', 'chapterId']),
      articleId: pickId(article, ['id', 'articleId']),
      sessionId: pickId(session, ['id', 'sessionId']),
      artifactId: pickId(artifact, ['id', 'artifactId']),
      factId: pickId(fact, ['id', 'factId']),
      evidenceId: pickId(evidence, ['id', 'evidenceId']),
      // 作答行按 openapi 的 QuestionAttempt 是 snake_case；桌面桥接历史上有过 camelCase，两个都认。
      questionId: pickId(attempt, ['question_id', 'questionId', 'id']),
      // 台账条目是 SummaryLedger（source_id），不是 id。
      sourceId: pickId(ledger, ['source_id', 'sourceId', 'id']),
    }
    for (const [key, value] of Object.entries(mapping)) {
      if (value) this.discovery[key] = value
    }
    // E-074 需要两个不同题目：桥接没有题目集列表，只能从多题作答里凑；凑不到就由用例显式 skip。
    const attempts = await this.allRecords('questions.attempts', {})
    const questionIds = attempts
      .map((row) => pickId(row, ['question_id', 'questionId']))
      .filter((id) => typeof id === 'string' && id.length > 0)
    if (questionIds.length > 0) this.discovery.questionIds = [...new Set(questionIds)]
  }

  /** 页内桥接：evaluate 里取 window.learning[fn] 并 apply；跨进程序列化由 Playwright 负责。 */
  async bridge(fn, args) {
    if (!this.handle) throw new Error('Electron 目标尚未 connect()')
    return await this.handle.page.evaluate(async (call) => {
      const api = window.learning
      if (!api) throw new Error('window.learning 不存在：preload 未注入')
      const member = api[call.fn]
      if (typeof member !== 'function') throw new Error(`window.learning.${call.fn} 不是函数`)
      return await member.apply(api, call.args)
    }, { fn, args })
  }

  async rpc(method, params = {}, opts = {}) {
    const requestId = opts.requestId ?? newRequestId()
    const guard = identityGuard(opts)
    if (guard) {
      return { ...rejectEnvelope(new Error(guard.message), requestId, 0), error: { code: guard.code, message: guard.message } }
    }
    const startedAt = Date.now()
    try {
      const result = await this.bridge('invoke', [method, params ?? {}])
      return {
        ok: true,
        result,
        requestId,
        elapsedMs: Date.now() - startedAt,
        httpStatus: 200,
      }
    } catch (error) {
      return rejectEnvelope(error, requestId, Date.now() - startedAt)
    }
  }

  /**
   * 流：一次性拿到 TurnResponse 后合成 session/text/done 帧（文件头注释已说明为何不是 SSE 采集）。
   * 每合成一帧就回调 hooks.onFrame；失败时只发一个 error 帧并 closed=true。
   */
  async stream(input = {}, hooks = {}) {
    const requestId = input.requestId ?? newRequestId()
    const events = []
    const rawFrames = []
    const startedAt = Date.now()
    let firstTokenMs = -1
    let doneCount = 0
    let errorCount = 0

    const emit = (event, data) => {
      const frame = {
        id: events.length + 1,
        event,
        data,
        raw: `id: ${events.length + 1}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n`,
      }
      events.push(frame)
      rawFrames.push(frame.raw)
      if (event === 'text' && firstTokenMs < 0) firstTokenMs = Date.now() - startedAt
      hooks.onFrame?.(frame)
    }

    let turn
    try {
      turn = await this.bridge('chat', [{ ...input, requestId }])
    } catch (error) {
      errorCount = 1
      emit('error', { requestId, code: 'CLIENT_REJECTED', message: error instanceof Error ? error.message : String(error) })
      return { events, rawFrames, doneCount, errorCount, firstTokenMs: -1, closed: true }
    }

    const sessionId = typeof turn?.sessionId === 'string' ? turn.sessionId : ''
    const text = typeof turn?.text === 'string' ? turn.text : ''
    const segments = splitTurnText(text)

    emit('session', { requestId, sessionId })
    for (const segment of segments) {
      emit('text', { requestId, agent: 'lead', text: segment })
    }
    emit('done', {
      requestId,
      turnId: turn?.turnId ?? '',
      sessionId,
      text,
      artifacts: Array.isArray(turn?.artifacts) ? turn.artifacts : [],
      citations: Array.isArray(turn?.citations) ? turn.citations : [],
      warnings: Array.isArray(turn?.warnings) ? turn.warnings : [],
    })
    doneCount = 1

    return { events, rawFrames, doneCount, errorCount, firstTokenMs: firstTokenMs < 0 ? -1 : firstTokenMs, closed: true }
  }

  async cancel(requestId) {
    try {
      const result = await this.bridge('cancel', [requestId])
      const cancelled = result?.cancelled === true
      return { httpStatus: 200, body: { ok: true, result: { cancelled }, requestId } }
    } catch (error) {
      return {
        httpStatus: 0,
        body: { ok: false, error: { code: 'CLIENT_REJECTED', message: error instanceof Error ? error.message : String(error) }, requestId },
      }
    }
  }

  async answer(input, opts = {}) {
    const requestId = opts.requestId ?? newRequestId()
    const guard = identityGuard(opts)
    if (guard) {
      return { ...rejectEnvelope(new Error(guard.message), requestId, 0), error: { code: guard.code, message: guard.message } }
    }
    const startedAt = Date.now()
    try {
      const result = await this.bridge('answer', [input])
      return { ok: true, result, requestId, elapsedMs: Date.now() - startedAt, httpStatus: 200 }
    } catch (error) {
      return rejectEnvelope(error, requestId, Date.now() - startedAt)
    }
  }

  async answerSet(input, opts = {}) {
    const requestId = opts.requestId ?? newRequestId()
    const guard = identityGuard(opts)
    if (guard) {
      return { ...rejectEnvelope(new Error(guard.message), requestId, 0), error: { code: guard.code, message: guard.message } }
    }
    const startedAt = Date.now()
    try {
      const result = await this.bridge('answerSet', [input])
      return { ok: true, result, requestId, elapsedMs: Date.now() - startedAt, httpStatus: 200 }
    } catch (error) {
      return rejectEnvelope(error, requestId, Date.now() - startedAt)
    }
  }

  async health(opts = {}) {
    const requestId = opts.requestId ?? newRequestId()
    try {
      const snapshot = await this.bridge('health', [])
      // 快照原样透传加 requestId；桌面端缺 warnings/notices/appHome 就按缺字段返回，不补假值。
      const result = snapshot && typeof snapshot === 'object' ? { ...snapshot, requestId } : { requestId }
      return { httpStatus: 200, body: { ok: true, requestId, result } }
    } catch (error) {
      return {
        httpStatus: 0,
        body: { ok: false, error: { code: 'CLIENT_REJECTED', message: error instanceof Error ? error.message : String(error) }, requestId },
      }
    }
  }

  buildDescribe() {
    const health = this.handle?.health ?? this.launchHealth ?? null
    const warnings = Array.isArray(health?.warnings) ? health.warnings.length : null
    const notices = Array.isArray(health?.notices) ? health.notices.length : null
    return {
      kind: 'electron',
      executable: 'apps/desktop/out',
      userDataDir: this.userDataDirRel,
      mainPid: this.handle?.mainPid ?? this.mainPid,
      health: { ok: health?.ok ?? null, warnings, notices },
      launchMs: this.launchMs,
    }
  }

  describe() {
    return this.describeSnapshot ?? this.buildDescribe()
  }

  async close() {
    if (!this.handle) return
    try {
      this.closeReport = await this.handle.close()
      if (this.describeSnapshot) {
        this.describeSnapshot.close = {
          exitCode: this.closeReport.exitCode,
          forced: this.closeReport.forced,
          portFree: this.closeReport.portFree,
        }
      }
    } finally {
      this.handle = null
    }
  }
}

/** 便捷工厂：签名与 stub/http 目标一致，run.mjs 只传 home / repoRoot / pkgRoot。 */
export function createElectronTarget(options = {}) {
  return new ElectronTarget(options)
}
