/**
 * Self-check for docs/contracts/openapi.yaml (AC-A-18).
 *
 * Asserts:
 *  - /api/v1/rpc method enum is exactly the 30 frozen methods, in frozen order;
 *  - the five dedicated channels each have their own path entry;
 *  - x-legacy-methods holds the 4 compatibility methods only (not in the enum);
 *  - components.schemas covers all 30 <Method>Result schemas;
 *  - chat/stream 200 response carries text/event-stream only.
 *
 * The frozen baseline below is the check's own reference (00-master §5/§6/§7);
 * it is not a second runtime method registry.
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const openapiFile = join(repoRoot, 'docs', 'contracts', 'openapi.yaml')

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

const CHANNEL_PATHS = [
  '/api/v1/chat/stream',
  '/api/v1/chat/cancel',
  '/api/v1/answer',
  '/api/v1/answer-set',
  '/api/v1/health',
]

const REQUIRED_PATHS = [
  '/health',
  '/metrics',
  '/api/v1/auth/login',
  '/api/v1/auth/logout',
  '/api/v1/auth/cas/callback',
  '/api/v1/auth/oauth/callback',
  '/api/v1/rpc',
  '/api/v1/chat/stream',
  '/api/v1/chat/cancel',
  '/api/v1/answer',
  '/api/v1/answer-set',
  '/api/v1/openapi.yaml',
]

function resultSchemaName(method) {
  const camel = method
    .split('.')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
  return `${camel}Result`
}

const failures = []
const pass = (message) => console.log(`PASS ${message}`)

if (!existsSync(openapiFile)) {
  failures.push(`契约文件不存在：${openapiFile}（先跑 pnpm --filter @yxs/server gen:openapi）`)
  report()
  process.exit(1)
}

let doc
try {
  doc = parse(readFileSync(openapiFile, 'utf8'))
  pass('openapi.yaml 可被 yaml 包解析')
} catch (error) {
  failures.push(`YAML 解析失败：${error.message}`)
  report()
  process.exit(1)
}

if (doc.openapi !== '3.0.3') failures.push(`openapi 版本应为 3.0.3，实际 ${String(doc.openapi)}`)
else pass('openapi 版本为 3.0.3')

const paths = doc.paths ?? {}

for (const path of REQUIRED_PATHS) {
  if (!paths[path]) failures.push(`缺少路径条目：${path}`)
}
if (REQUIRED_PATHS.every((path) => paths[path])) pass(`${REQUIRED_PATHS.length} 个冻结路径齐全`)

for (const path of CHANNEL_PATHS) {
  if (!paths[path]) failures.push(`缺少专用通道路径：${path}`)
}
if (CHANNEL_PATHS.every((path) => paths[path])) pass('5 个专用通道路径齐全')

const rpcPost = paths['/api/v1/rpc']?.post
const methodEnum = rpcPost?.requestBody?.content?.['application/json']?.schema?.properties?.method?.enum
if (!Array.isArray(methodEnum)) {
  failures.push('/api/v1/rpc 请求体缺少 method enum')
} else {
  if (methodEnum.length !== 30) failures.push(`method enum 数量应为 30，实际 ${methodEnum.length}`)
  const expected = FROZEN_METHODS.join(',')
  const actual = methodEnum.join(',')
  if (actual !== expected) {
    failures.push(`method enum 与冻结表不一致。\n  期望：${expected}\n  实际：${actual}`)
  }
  const leaked = LEGACY_METHODS.filter((name) => methodEnum.includes(name))
  if (leaked.length > 0) failures.push(`legacy 方法混入 enum：${leaked.join(', ')}`)
  if (methodEnum.length === 30 && actual === expected && leaked.length === 0) {
    pass('method enum 恰好 30 项，顺序与冻结表一致，无 legacy 混入')
  }
}

const legacy = doc['x-legacy-methods']
if (!Array.isArray(legacy)) {
  failures.push('顶层缺少 x-legacy-methods 数组')
} else {
  const names = legacy.map((item) => item?.name)
  if (names.length !== 4) failures.push(`x-legacy-methods 应为 4 项，实际 ${names.length}`)
  for (const expected of LEGACY_METHODS) {
    if (!names.includes(expected)) failures.push(`x-legacy-methods 缺少 ${expected}`)
  }
  for (const item of legacy) {
    for (const field of ['name', 'params', 'result', 'notes']) {
      if (!(field in item)) failures.push(`legacy 项 ${item?.name ?? '?'} 缺少字段 ${field}`)
    }
  }
  if (names.length === 4 && LEGACY_METHODS.every((name) => names.includes(name))) {
    pass('x-legacy-methods 恰好 4 个兼容方法')
  }
}

const schemas = doc.components?.schemas ?? {}
const missingSchemas = FROZEN_METHODS.map(resultSchemaName).filter((name) => !schemas[name])
if (missingSchemas.length > 0) {
  failures.push(`components.schemas 缺少 Result：${missingSchemas.join(', ')}`)
} else {
  pass('components.schemas 覆盖全部 30 个 *Result')
}

for (const name of Object.keys(schemas)) {
  const schema = schemas[name]
  if (schema.type === 'object' && !Array.isArray(schema.required)) {
    failures.push(`schema ${name} 缺少 required 声明`)
  }
}

const sseResponses = paths['/api/v1/chat/stream']?.post?.responses?.['200']?.content
if (!sseResponses) {
  failures.push('chat/stream 200 响应未声明 content')
} else {
  const kinds = Object.keys(sseResponses)
  if (kinds.length !== 1 || kinds[0] !== 'text/event-stream') {
    failures.push(`chat/stream 200 content 只能是 text/event-stream，实际：${kinds.join(', ')}`)
  } else {
    pass('chat/stream 200 仅声明 text/event-stream')
  }
}

function report() {
  if (failures.length > 0) {
    console.error(`\n自检失败 ${failures.length} 项：`)
    for (const failure of failures) console.error(`- ${failure}`)
    process.exitCode = 1
  } else {
    console.log('\n全部 OpenAPI 自检通过。')
  }
}

report()
