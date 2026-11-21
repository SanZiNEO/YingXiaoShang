/**
 * Method probe: call every frozen RPC method (30) plus the four legacy
 * compatibility methods with legal inputs, and check the required top-level
 * fields (AC-A-08, AC-A-09).
 *
 * Fixtures are resolved per method: list RPCs supply real ids; write-adjacent
 * probes (memory.delete) first create a throwaway fact. When an id cannot be
 * resolved from the local home, the method is recorded as a missing fixture
 * instead of being called with a synthetic bad id.
 *
 * Output: one JSONL record per method `{method, status, ok, missing, reason, fields}`.
 * Usage: node scripts/probe-methods.mjs
 *        YXS_BASE_URL=... YXS_SMOKE_STUDENT=... YXS_SMOKE_PASSWORD=...
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const base = (process.env.YXS_BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '')
const studentId = process.env.YXS_SMOKE_STUDENT ?? '20230001'
const password = process.env.YXS_SMOKE_PASSWORD ?? 'abc12345'

const FROZEN_METHODS = [
  'student.current',
  'chapters.list',
  'kps.list',
  'news.list',
  'news.status',
  'news.refresh',
  'news.get',
  'news.match',
  'questions.attempts',
  'profile.get',
  'profile.growth',
  'profile.evidence',
  'profile.snapshot',
  'profile.review',
  'artifacts.list',
  'artifacts.get',
  'artifacts.export',
  'memory.facts',
  'memory.episodes',
  'memory.summary',
  'memory.upsert',
  'memory.delete',
  'chat.sessions',
  'chat.messages',
  'agent.snapshot',
  'agent.suggestions',
  'agent.turns',
  'agent.ledger',
  'agent.retry',
  'agent.sessions',
]

const LEGACY_METHODS = ['getKp', 'getBlock', 'getResource', 'listIdeology']

const REQUIRED = {
  'student.current': ['studentId', 'name', 'cohort'],
  'chapters.list': '@array',
  'kps.list': '@array',
  'news.list': '@array',
  'news.status': ['count', 'newestFetchedAt'],
  'news.refresh': ['results', 'queued', 'accepted', 'count', 'newestFetchedAt'],
  'news.get': ['article', 'matches', 'ideology'],
  'news.match': ['matches'],
  'questions.attempts': '@array',
  'profile.get': ['profile', 'competencies'],
  'profile.growth': '@array',
  'profile.evidence': '@array',
  'profile.snapshot': ['id', 'chapter_id', 'checkpoint'],
  'profile.review': ['ok'],
  'artifacts.list': '@array',
  'artifacts.get': ['id', 'student_id', 'type', 'title', 'path'],
  'artifacts.export': ['path'],
  'memory.facts': '@array',
  'memory.episodes': '@array',
  'memory.summary': ['headline', 'facts', 'episodes'],
  'memory.upsert': ['id', 'kind', 'key', 'value'],
  'memory.delete': ['ok'],
  'chat.sessions': '@array',
  'chat.messages': '@array',
  'agent.snapshot': ['student_id', 'phase'],
  'agent.suggestions': ['title', 'items'],
  'agent.turns': '@array',
  'agent.ledger': ['items', 'counts'],
  'agent.retry': ['items', 'counts'],
  'agent.sessions': '@array',
  getKp: ['id', 'name'],
  getBlock: ['block'],
  getResource: ['guide'],
  listIdeology: '@array',
}

async function httpRequest(path, { method = 'GET', token, body } = {}) {
  const headers = { 'content-type': 'application/json; charset=utf-8' }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  try {
    json = text.length > 0 ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: response.status, json }
}

function localDbPath() {
  const explicit = process.env.YXS_DB_PATH
  if (explicit && existsSync(explicit)) return explicit
  const home = process.env.LEARNING_AGENT_HOME ?? join(repoRoot, '.learning-agent')
  const inHome = join(home, 'data', 'learning.db')
  if (existsSync(inHome)) return inHome
  const sample = join(repoRoot, '.scratch', 'sample-home', 'data', 'learning.db')
  if (existsSync(sample)) return sample
  return undefined
}

function queryLocalDb(sql, params = []) {
  const dbPath = localDbPath()
  if (!dbPath) return undefined
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const row = db.prepare(sql).get(...params)
    return row
  } catch {
    return undefined
  } finally {
    db?.close()
  }
}

function makeContext(token) {
  const cache = {}
  const rpc = async (method, params = {}) => {
    const result = await httpRequest('/api/v1/rpc', {
      method: 'POST',
      token,
      body: { method, params, requestId: `req_probe${Date.now().toString(36)}` },
    })
    if (result.status !== 200 || result.json?.ok !== true) {
      throw new Error(result.json?.error?.message ?? `HTTP ${result.status}`)
    }
    return result.json.result
  }
  const firstId = async (cacheKey, method, params, field = 'id') => {
    if (cache[cacheKey] !== undefined) return cache[cacheKey]
    const rows = await rpc(method, params)
    const value = Array.isArray(rows) ? rows[0]?.[field] : undefined
    cache[cacheKey] = value ?? null
    return cache[cacheKey] || undefined
  }
  return {
    rpc,
    newsId: () => firstId('news', 'news.list', { limit: 1 }),
    artifactId: () => firstId('artifact', 'artifacts.list', { limit: 1 }),
    sessionId: () => firstId('session', 'chat.sessions', {}),
    evidenceId: () => firstId('evidence', 'profile.evidence', { limit: 20 }),
    chapterId: () => firstId('chapter', 'chapters.list', {}),
    kpId: () => firstId('kp', 'kps.list', { limit: 1 }),
    ledgerSourceId: async () => {
      if (cache.ledger) return cache.ledger
      const ledger = await rpc('agent.ledger')
      cache.ledger = ledger?.items?.[0]?.source_id ?? null
      return cache.ledger || undefined
    },
    tempFactId: async () => {
      const fact = await rpc('memory.upsert', { key: `probe_${Date.now()}`, value: '探针记忆', kind: 'goal' })
      return fact?.id
    },
    blockId: () => queryLocalDb('SELECT id FROM content_blocks LIMIT 1')?.id,
    resourceId: () => {
      const row = queryLocalDb("SELECT key FROM plugin_state WHERE plugin_id = 'resource' AND key LIKE 'guide/%' LIMIT 1")
      if (!row?.key) return undefined
      return String(row.key).replace(/^guide\//, '')
    },
  }
}

async function resolveFixtures(method, ctx) {
  switch (method) {
    case 'news.get':
      return { articleId: await ctx.newsId() }
    case 'news.match':
      return { articleId: await ctx.newsId(), topK: 3 }
    case 'artifacts.get':
      return { artifactId: await ctx.artifactId() }
    case 'artifacts.export':
      return { artifactId: await ctx.artifactId(), format: 'md' }
    case 'chat.messages':
      return { sessionId: await ctx.sessionId() }
    case 'agent.turns':
      return { sessionId: await ctx.sessionId(), limit: 20 }
    case 'profile.review':
      return { evidenceId: await ctx.evidenceId(), status: 'draft', note: 'probe' }
    case 'profile.snapshot':
      return { chapterId: await ctx.chapterId(), checkpoint: 'post' }
    case 'memory.delete':
      return { factId: await ctx.tempFactId() }
    case 'memory.upsert':
      return { key: `probe_${Date.now()}`, value: '探针记忆', kind: 'goal' }
    case 'agent.retry':
      return { sourceId: await ctx.ledgerSourceId() }
    case 'news.refresh':
      // `sources` is optional; omitting it means "refresh the default sources".
      return {}
    case 'kps.list':
      return { limit: 10 }
    case 'news.list':
      return { limit: 10 }
    case 'profile.evidence':
      return { limit: 20 }
    case 'memory.episodes':
      return { limit: 20 }
    case 'artifacts.list':
      return { limit: 20 }
    case 'getKp':
      return { kpId: await ctx.kpId() }
    case 'getBlock':
      return { blockId: await ctx.blockId() }
    case 'getResource':
      return { resourceId: await ctx.resourceId() }
    default:
      return {}
  }
}

function checkFields(result, required) {
  if (required === '@array') return Array.isArray(result) ? [] : ['<array>']
  if (result === null || typeof result !== 'object') return ['<object>']
  // Some methods return a row list (profile.snapshot → GrowthSnapshot[]): the
  // required fields belong to the row, so check the first element.
  const row = Array.isArray(result) ? result[0] : result
  if (row === undefined) return required.slice(0, 1)
  return required.filter((field) => row[field] === undefined)
}

function record(entry) {
  console.log(JSON.stringify(entry))
}

async function main() {
  // The server rate-limits logins to 5 per IP per minute (contract §3.2). A
  // probe run that follows other login-spending checks must wait the window out
  // instead of reporting a false failure.
  let login = await httpRequest('/api/v1/auth/login', {
    method: 'POST',
    body: { studentId, password },
  })
  if (login.status === 429) {
    await new Promise((resolve) => setTimeout(resolve, 62000))
    login = await httpRequest('/api/v1/auth/login', {
      method: 'POST',
      body: { studentId, password },
    })
  }
  if (login.status !== 200 || login.json?.ok !== true) {
    record({ method: '<login>', status: login.status, ok: false, reason: login.json?.error?.message ?? `HTTP ${login.status}` })
    process.exit(1)
  }
  const token = login.json.result.token
  const ctx = makeContext(token)

  let failures = 0
  for (const method of [...FROZEN_METHODS, ...LEGACY_METHODS]) {
    let params
    try {
      params = await resolveFixtures(method, ctx)
    } catch (error) {
      record({ method, status: 0, ok: false, missing: 'fixture', reason: `夹具解析失败：${error.message}` })
      failures += 1
      continue
    }
    const missingFixture = Object.values(params).some((value) => value === undefined)
    if (missingFixture) {
      record({ method, status: 0, ok: false, missing: 'fixture', params, reason: '缺少可解析的真实 id' })
      failures += 1
      continue
    }
    try {
      const response = await httpRequest('/api/v1/rpc', {
        method: 'POST',
        token,
        body: { method, params, requestId: `req_probe${Date.now().toString(36)}` },
      })
      const ok = response.status === 200 && response.json?.ok === true
      const missing = ok ? checkFields(response.json.result, REQUIRED[method]) : []
      if (!ok || missing.length > 0) failures += 1
      record({
        method,
        status: response.status,
        ok: ok && missing.length === 0,
        missing: missing.length > 0 ? missing : undefined,
        reason: ok ? undefined : response.json?.error?.message ?? `HTTP ${response.status}`,
        params,
      })
    } catch (error) {
      failures += 1
      record({ method, status: 0, ok: false, reason: error.message, params })
    }
  }

  if (failures > 0) {
    console.error(`探针结束：${failures} 个方法未通过`)
    process.exit(1)
  }
  console.error(`探针结束：${FROZEN_METHODS.length + LEGACY_METHODS.length} 个方法全部通过`)
}

main().catch((error) => {
  console.error(`探针致命错误：${error.message}`)
  process.exit(1)
})
