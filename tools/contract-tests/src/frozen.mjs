/**
 * E 轮冻结表 —— 这一轮唯一的「事实来源」。
 *
 * 出处（逐条对着抄，不许自创同义值）：
 * - plans/server-client-split/00-master/01-frozen-contracts.md §4.2（14 个错误码 + 逐字中文消息）、§5（30 个业务方法）、§6（4 个 legacy）、§7（5 个专用通道）
 * - plans/server-client-split/E-contract-tests/02-contract.md §2.1（编号段）、§3（逐方法入参与断言）、§4（错误与消息逐字表）、§5（通道序列）
 *
 * 用法：cases/*.mjs 只读这张表生成用例；src/stub-target.mjs 用它做校验与返回；coverage 侧用 METHOD_NAMES 比对 OpenAPI 枚举。
 * 所以「30 个方法名」「逐字消息」在这份工具包里只有一处定义，不允许在别处再抄一份。
 *
 * 参数里的 `$articleId` 这类串是「符号占位」，由 src/fixtures.mjs 在运行期换成被测实例里的真实 ID；
 * 换不到（种子库为空 / 服务端没有这条记录）时，该用例按 02-contract §3.1 标 skipped 并写明原因，不编造 ID。
 */

/** 通用非法：params 传数组 / 字符串 / null → 400 BAD_REQUEST + 这条逐字消息（02-contract §3 表头）。 */
export const PARAMS_NOT_OBJECT = {
  code: 'BAD_REQUEST',
  http: 400,
  message: 'params 必须是对象。',
  field: 'params',
}

/** §4.2 冻结错误码表。BAD_REQUEST 的消息按字段变化，这里 message 为 null。 */
export const ERROR_CODES = {
  AUTH_REQUIRED: { http: 401, message: '请先登录。' },
  AUTH_INVALID: { http: 401, message: '登录已失效，请重新登录。' },
  AUTH_FAILED: { http: 401, message: '学号或口令不对，请检查后再试。' },
  FORBIDDEN: { http: 403, message: '这个资源不属于当前学号，换回自己的账号再试。' },
  NOT_FOUND: { http: 404, message: '没有找到这条记录，可能已被删除。' },
  UNKNOWN_METHOD: { http: 404, message: '没有这个方法：' },
  BAD_REQUEST: { http: 400, message: null },
  PAYLOAD_TOO_LARGE: { http: 413, message: '这次提交的内容太大了（上限 1 MB），分几次发。' },
  RATE_LIMITED: { http: 429, message: '请求太频繁，请等几秒再试。' },
  NOT_IMPLEMENTED: { http: 501, message: '这个功能还没做，先别用。' },
  UPSTREAM_FAILED: { http: 502, message: '上游服务没响应（新闻服务 / 模型），稍后重试。' },
  CANCELLED: { http: 499, message: '已停止这一轮（你点的停止）。这次没有保存结果，可以重新提问。' },
  TIMEOUT: { http: 504, message: '这一步等太久了，已经停下，可以直接重试。' },
  INTERNAL: { http: 500, message: '服务端出了点问题，已经记下来了，请稍后重试。' },
}

/** CAS/OAuth 预留端点专用文案（冻结 §3.5），与 §4.2 的通用 NOT_IMPLEMENTED 文案不是同一句。 */
export const CAS_NOT_IMPLEMENTED_MESSAGE = '统一身份认证还没接，请先用学号口令登录。'

/** 逐字消息碎片（02-contract §4.2 字段级表）。拼装只允许 `${field} 不能为空。` 这一处。 */
export const REQUIRED_SUFFIX = ' 不能为空。'
export const MESSAGE_LIMIT_INTEGER = 'limit 必须是整数。'
export const MESSAGE_LIMIT_1_200 = 'limit 必须是 1 到 200 的整数。'
export const MESSAGE_LIMIT_1_500 = 'limit 必须是 1 到 500 的整数。'
export const MESSAGE_SOURCES_ARRAY = 'sources 必须是非空字符串数组。'
export const MESSAGE_QUESTION_IDS_ARRAY = 'questionIds 必须是非空字符串数组。'
export const MESSAGE_CHECKPOINT_ENUM = 'checkpoint 必须是 pre 或 post。'
export const MESSAGE_STATUS_ENUM = 'status 必须是 draft、reviewed 或 rejected。'
export const MESSAGE_FORMAT_ENUM = 'format 必须是 md、docx 或 html。'
export const MESSAGE_ANSWER_SET_EMPTY = '这一卷还没有作答，先答一题再交。'
export const MESSAGE_ANSWER_FAILED = '这次作答没有记成成绩，可以直接重试。'

/** 单纯「params 非对象」的非法用例快捷写法。 */
const notObject = { shape: 'array', expect: PARAMS_NOT_OBJECT }

/** 消息长度的冻结上限（字符/码点），用于 fixtures 的边界值。 */
export const MESSAGE_MAX_CHARS = 8000

/**
 * 30 个业务方法（冻结 §5，顺序即编号 E-001..E-030 的合法用例顺序）。
 *
 * 每行字段：
 *   n            冻结表序号
 *   method       方法名（逐字）
 *   legal.params 合法入参（含 $ 符号占位）
 *   legal.expect 返回顶层断言：{ kind: 'array' | 'object', fields?: [], equals?: {} }
 *   illegal      非法用例：{ shape:'array' }（params 非对象）或 { params, expect }
 *   rules        stub 侧校验口径（required / limit / enum / nonEmptyStrings / nonEmptyStringArray）
 *   writes       是否写库（02-contract §3 写方法清单）
 *   ownership    是否做归属校验（冻结 §3.3）
 *   evidence     现状实现位置（冻结 §5 最后一列）
 */
export const METHODS = [
  {
    n: 1, method: 'student.current',
    legal: { params: {}, expect: { kind: 'object', fields: ['studentId', 'name', 'cohort'] } },
    illegal: notObject, rules: {}, writes: false, ownership: false,
    evidence: 'apps/desktop/src/main/index.ts:209-212',
  },
  {
    n: 2, method: 'chapters.list',
    legal: { params: {}, expect: { kind: 'array' } },
    illegal: notObject, rules: {}, writes: false, ownership: false,
    evidence: 'apps/desktop/src/main/index.ts:213-214',
  },
  {
    n: 3, method: 'kps.list',
    legal: { params: {}, expect: { kind: 'array' } },
    illegal: { params: { limit: '80' }, expect: { code: 'BAD_REQUEST', http: 400, message: MESSAGE_LIMIT_INTEGER, field: 'limit' } },
    rules: { limit: { min: 1, max: 500, typeMessage: MESSAGE_LIMIT_INTEGER, rangeMessage: MESSAGE_LIMIT_1_500 } },
    writes: false, ownership: false, evidence: 'apps/desktop/src/main/index.ts:215-224',
  },
  {
    n: 4, method: 'news.list',
    legal: { params: {}, expect: { kind: 'array' } },
    illegal: { params: { limit: 99999 }, expect: { code: 'BAD_REQUEST', http: 400, message: MESSAGE_LIMIT_1_200, field: 'limit' } },
    rules: { limit: { min: 1, max: 200, typeMessage: MESSAGE_LIMIT_INTEGER, rangeMessage: MESSAGE_LIMIT_1_200 } },
    writes: false, ownership: false, evidence: 'apps/desktop/src/main/index.ts:251-256',
  },
  {
    n: 5, method: 'news.status',
    legal: { params: {}, expect: { kind: 'object', fields: ['count', 'newestFetchedAt'] } },
    illegal: notObject, rules: {}, writes: false, ownership: false,
    evidence: 'apps/desktop/src/main/index.ts:257-261',
  },
  {
    n: 6, method: 'news.refresh',
    legal: { params: {}, expect: { kind: 'object', fields: ['results', 'queued', 'accepted', 'count', 'newestFetchedAt'] } },
    illegal: { params: { sources: '36kr' }, expect: { code: 'BAD_REQUEST', http: 400, message: MESSAGE_SOURCES_ARRAY, field: 'sources' } },
    rules: { nonEmptyStringArray: ['sources'] },
    writes: true, ownership: false, evidence: 'apps/desktop/src/main/index.ts:262-273',
  },
  {
    n: 7, method: 'news.get',
    legal: { params: { articleId: '$articleId' }, expect: { kind: 'object', fields: ['article', 'matches', 'ideology'] } },
    illegal: { params: {}, expect: { code: 'BAD_REQUEST', http: 400, message: `articleId${REQUIRED_SUFFIX}`, field: 'articleId' } },
    rules: { required: ['articleId'] }, writes: false, ownership: false,
    evidence: 'apps/desktop/src/main/index.ts:274-282',
  },
  {
    n: 8, method: 'news.match',
    legal: { params: { articleId: '$articleId' }, expect: { kind: 'object', fields: ['matches'] } },
    illegal: { params: {}, expect: { code: 'BAD_REQUEST', http: 400, message: `articleId${REQUIRED_SUFFIX}`, field: 'articleId' } },
    rules: { required: ['articleId'], limit: { param: 'topK', min: 1, max: 10, typeMessage: 'topK 必须是整数。', rangeMessage: 'topK 必须是 1 到 10 的整数。' } },
    writes: true, ownership: false, evidence: 'apps/desktop/src/main/index.ts:283-289',
  },
  {
    n: 9, method: 'questions.attempts',
    legal: { params: {}, expect: { kind: 'array' } },
    illegal: { params: { questionIds: 'q1' }, expect: { code: 'BAD_REQUEST', http: 400, message: MESSAGE_QUESTION_IDS_ARRAY, field: 'questionIds' } },
    rules: { nonEmptyStringArray: ['questionIds'] },
    writes: false, ownership: false, evidence: 'apps/desktop/src/main/index.ts:290-295',
  },
  {
    n: 10, method: 'profile.get',
    legal: { params: {}, expect: { kind: 'object' } },
    illegal: notObject, rules: {}, writes: false, ownership: false,
    evidence: 'apps/desktop/src/main/index.ts:296-297',
  },
  {
    n: 11, method: 'profile.growth',
    // growthSummary() 返回 GrowthSummaryItem[]，不是对象（packages/profile/src/index.ts:382）。
    legal: { params: {}, expect: { kind: 'array' } },
    illegal: notObject, rules: {}, writes: false, ownership: false,
    evidence: 'apps/desktop/src/main/index.ts:298-299',
  },
  {
    n: 12, method: 'profile.evidence',
    legal: { params: {}, expect: { kind: 'array' } },
    illegal: { params: { limit: 0 }, expect: { code: 'BAD_REQUEST', http: 400, message: MESSAGE_LIMIT_1_500, field: 'limit' } },
    rules: { limit: { min: 1, max: 500, typeMessage: MESSAGE_LIMIT_INTEGER, rangeMessage: MESSAGE_LIMIT_1_500 } },
    writes: false, ownership: false, evidence: 'apps/desktop/src/main/index.ts:300-305',
  },
  {
    n: 13, method: 'profile.snapshot',
    // recordSnapshot() 返回 GrowthSnapshot[]，不是对象（packages/profile/src/index.ts:331）。
    legal: { params: { chapterId: '$chapterId', checkpoint: 'pre' }, expect: { kind: 'array' } },
    illegal: { params: { checkpoint: 'pre' }, expect: { code: 'BAD_REQUEST', http: 400, message: `chapterId${REQUIRED_SUFFIX}`, field: 'chapterId' } },
    rules: { required: ['chapterId'], enum: { checkpoint: { values: ['pre', 'post'], message: MESSAGE_CHECKPOINT_ENUM } } },
    writes: true, ownership: false, evidence: 'apps/desktop/src/main/index.ts:306-311',
  },
  {
    n: 14, method: 'profile.review',
    legal: { params: { evidenceId: '$evidenceId', status: 'reviewed' }, expect: { kind: 'object', fields: ['ok'], equals: { ok: true } } },
    illegal: { params: { evidenceId: '$evidenceId', status: 'bad' }, expect: { code: 'BAD_REQUEST', http: 400, message: MESSAGE_STATUS_ENUM, field: 'status' } },
    rules: { required: ['evidenceId'], enum: { status: { values: ['draft', 'reviewed', 'rejected'], message: MESSAGE_STATUS_ENUM } } },
    writes: true, ownership: true, evidence: 'apps/desktop/src/main/index.ts:312-318',
  },
  {
    n: 15, method: 'artifacts.list',
    legal: { params: {}, expect: { kind: 'array' } },
    illegal: { params: { limit: 9999 }, expect: { code: 'BAD_REQUEST', http: 400, message: MESSAGE_LIMIT_1_200, field: 'limit' } },
    rules: { limit: { min: 1, max: 200, typeMessage: MESSAGE_LIMIT_INTEGER, rangeMessage: MESSAGE_LIMIT_1_200 } },
    writes: false, ownership: false, evidence: 'apps/desktop/src/main/index.ts:319-320',
  },
  {
    n: 16, method: 'artifacts.get',
    legal: { params: { artifactId: '$artifactId' }, expect: { kind: 'object' } },
    illegal: { params: {}, expect: { code: 'BAD_REQUEST', http: 400, message: `artifactId${REQUIRED_SUFFIX}`, field: 'artifactId' } },
    rules: { required: ['artifactId'] }, writes: false, ownership: true,
    evidence: 'apps/desktop/src/main/index.ts:321-322',
  },
  {
    n: 17, method: 'artifacts.export',
    legal: { params: { artifactId: '$artifactId' }, expect: { kind: 'object', fields: ['path'] } },
    illegal: { params: { artifactId: '$artifactId', format: 'pdf' }, expect: { code: 'BAD_REQUEST', http: 400, message: MESSAGE_FORMAT_ENUM, field: 'format' } },
    rules: { required: ['artifactId'], enum: { format: { values: ['md', 'docx', 'html'], message: MESSAGE_FORMAT_ENUM } } },
    writes: true, ownership: true, evidence: 'apps/desktop/src/main/index.ts:323-324',
  },
  {
    n: 18, method: 'memory.facts',
    legal: { params: {}, expect: { kind: 'array' } },
    illegal: notObject, rules: {}, writes: false, ownership: false,
    evidence: 'apps/desktop/src/main/index.ts:325-326',
  },
  {
    n: 19, method: 'memory.episodes',
    legal: { params: {}, expect: { kind: 'array' } },
    illegal: { params: { limit: '50' }, expect: { code: 'BAD_REQUEST', http: 400, message: MESSAGE_LIMIT_INTEGER, field: 'limit' } },
    rules: { limit: { min: 1, max: 500, typeMessage: MESSAGE_LIMIT_INTEGER, rangeMessage: MESSAGE_LIMIT_1_500 } },
    writes: false, ownership: false, evidence: 'apps/desktop/src/main/index.ts:327-328',
  },
  {
    n: 20, method: 'memory.summary',
    legal: { params: {}, expect: { kind: 'object' } },
    illegal: notObject, rules: {}, writes: false, ownership: false,
    evidence: 'apps/desktop/src/main/index.ts:329-330',
  },
  {
    n: 21, method: 'memory.upsert',
    legal: { params: { key: 'e-contract', value: '样例' }, expect: { kind: 'object' } },
    illegal: { params: { value: '样例' }, expect: { code: 'BAD_REQUEST', http: 400, message: `key${REQUIRED_SUFFIX}`, field: 'key' } },
    rules: { required: ['key'], nonEmptyStrings: ['value'] },
    writes: true, ownership: false, evidence: 'apps/desktop/src/main/index.ts:331-340',
  },
  {
    n: 22, method: 'memory.delete',
    legal: { params: { factId: '$factId' }, expect: { kind: 'object', fields: ['ok'], equals: { ok: true } } },
    illegal: { params: {}, expect: { code: 'BAD_REQUEST', http: 400, message: `factId${REQUIRED_SUFFIX}`, field: 'factId' } },
    rules: { required: ['factId'] }, writes: true, ownership: true,
    evidence: 'apps/desktop/src/main/index.ts:341-343',
  },
  {
    n: 23, method: 'chat.sessions',
    legal: { params: {}, expect: { kind: 'array' } },
    illegal: notObject, rules: {}, writes: false, ownership: false,
    evidence: 'apps/desktop/src/main/index.ts:344-345',
  },
  {
    n: 24, method: 'chat.messages',
    legal: { params: { sessionId: '$sessionId' }, expect: { kind: 'array' } },
    illegal: { params: {}, expect: { code: 'BAD_REQUEST', http: 400, message: `sessionId${REQUIRED_SUFFIX}`, field: 'sessionId' } },
    rules: { required: ['sessionId'] }, writes: false, ownership: true,
    evidence: 'apps/desktop/src/main/index.ts:346-347',
  },
  {
    n: 25, method: 'agent.snapshot',
    legal: { params: {}, expect: { kind: 'object' } },
    illegal: notObject, rules: {}, writes: false, ownership: false,
    evidence: 'apps/desktop/src/main/index.ts:348-353',
  },
  {
    n: 26, method: 'agent.suggestions',
    legal: { params: {}, expect: { kind: 'object' } },
    illegal: notObject, rules: {}, writes: false, ownership: false,
    evidence: 'apps/desktop/src/main/index.ts:354-358',
  },
  {
    n: 27, method: 'agent.turns',
    legal: { params: { sessionId: '$sessionId' }, expect: { kind: 'array' } },
    illegal: { params: {}, expect: { code: 'BAD_REQUEST', http: 400, message: `sessionId${REQUIRED_SUFFIX}`, field: 'sessionId' } },
    rules: { required: ['sessionId'] }, writes: false, ownership: true,
    evidence: 'apps/desktop/src/main/index.ts:359-360',
  },
  {
    n: 28, method: 'agent.ledger',
    legal: { params: {}, expect: { kind: 'object', fields: ['items', 'counts'] } },
    illegal: notObject, rules: {}, writes: false, ownership: false,
    evidence: 'apps/desktop/src/main/index.ts:361-362',
  },
  {
    n: 29, method: 'agent.retry',
    legal: { params: { sourceId: '$sourceId' }, expect: { kind: 'object', fields: ['items', 'counts'] } },
    illegal: { params: {}, expect: { code: 'BAD_REQUEST', http: 400, message: `sourceId${REQUIRED_SUFFIX}`, field: 'sourceId' } },
    rules: { required: ['sourceId'] }, writes: true, ownership: false,
    evidence: 'apps/desktop/src/main/index.ts:363-365',
  },
  {
    n: 30, method: 'agent.sessions',
    legal: { params: {}, expect: { kind: 'array' } },
    illegal: notObject, rules: {}, writes: false, ownership: false,
    evidence: 'apps/desktop/src/main/index.ts:366-369',
  },
]

/**
 * 4 个 legacy 只读方法（冻结 §6）。不计入 30 方法覆盖统计，各 1 条合法用例（E-061..E-064）。
 */
export const LEGACY_METHODS = [
  {
    id: 'E-061', method: 'getKp', legal: { kpId: '$kpId' },
    expect: { kind: 'object' }, rules: { required: ['kpId'] },
    evidence: 'apps/desktop/src/main/index.ts:225-226',
  },
  {
    id: 'E-062', method: 'getBlock', legal: { blockId: '$blockId' },
    expect: { kind: 'object', fields: ['block'] }, rules: { required: ['blockId'] },
    evidence: 'apps/desktop/src/main/index.ts:227-235',
  },
  {
    id: 'E-063', method: 'getResource', legal: { resourceId: '$resourceId' },
    expect: { kind: 'object', fields: ['guide'] }, rules: { required: ['resourceId'] },
    evidence: 'apps/desktop/src/main/index.ts:236-248',
  },
  {
    id: 'E-064', method: 'listIdeology', legal: {},
    expect: { kind: 'array' }, rules: {},
    evidence: 'apps/desktop/src/main/index.ts:249-250',
  },
]

/**
 * 5 个专用通道的路径（冻结 §7 / E-02 §5 / §7 E-078 核对对象）。
 * 注意 `/api/v1/health` 与无前缀 `/health` 同属 health 通道，E-078 只核对带前缀的独立 path 条目。
 */
export const CHANNEL_PATHS = [
  '/api/v1/chat/stream',
  '/api/v1/chat/cancel',
  '/api/v1/answer',
  '/api/v1/answer-set',
  '/api/v1/health',
]

/** SSE 事件白名单（冻结 §7.1，配对 packages/agent/src/team.ts:17-35 + 传输层 done/error）。 */
export const SSE_EVENT_NAMES = ['session', 'round', 'text', 'tool', 'tool-end', 'done', 'error']
export const SSE_TERMINAL_EVENTS = ['done', 'error']

/** `done` 帧必含字段（冻结 §7.1 / packages/agent/src/index.ts:52-67；`trace?` 可缺）。 */
export const SSE_DONE_FIELDS = ['requestId', 'turnId', 'sessionId', 'text', 'artifacts', 'citations', 'warnings']

/** answer 通道返回必含字段（冻结 §7.3）。 */
export const ANSWER_RESULT_FIELDS = ['turnId', 'text', 'feedback', 'evidence', 'ledger', 'warnings', 'status']
/** answer-set 通道返回必含字段（冻结 §7.4）。 */
export const ANSWER_SET_RESULT_FIELDS = ['turnId', 'text', 'results', 'ledger', 'warnings', 'status']
/** health 返回必含字段（冻结 §7.5）。 */
export const HEALTH_RESULT_FIELDS = [
  'ok', 'warnings', 'notices', 'chapters', 'knowledgePoints', 'newsArticles', 'appHome', 'version', 'uptimeMs',
]

/**
 * 5 个合法用例编号与通道映射（E-070..E-076）——编号在 02-contract §2.1 与 §5 冻结。
 * 用例实现见 cases/channels.mjs。
 */
export const CHANNEL_CASES = [
  { id: 'E-070', name: 'chat-stream-order', channel: '/api/v1/chat/stream' },
  { id: 'E-071', name: 'chat-stream-cancel', channel: '/api/v1/chat/cancel' },
  { id: 'E-072', name: 'chat-cancel-unknown', channel: '/api/v1/chat/cancel' },
  { id: 'E-073', name: 'answer-readback', channel: '/api/v1/answer' },
  { id: 'E-074', name: 'answer-set-readback', channel: '/api/v1/answer-set' },
  { id: 'E-075', name: 'answer-set-empty', channel: '/api/v1/answer-set' },
  { id: 'E-076', name: 'health-no-auth', channel: '/api/v1/health' },
]

/** 5 类非法专属用例（E-065..E-069），02-contract §4.3 冻结。 */
export const ILLEGAL_CLASS_CASES = [
  {
    id: 'E-065', category: 'missing-field', method: 'news.get',
    params: {}, expect: { code: 'BAD_REQUEST', http: 400, message: `articleId${REQUIRED_SUFFIX}`, field: 'articleId' },
  },
  {
    id: 'E-066', category: 'wrong-type', method: 'kps.list',
    params: { limit: '80' }, expect: { code: 'BAD_REQUEST', http: 400, message: MESSAGE_LIMIT_INTEGER, field: 'limit' },
  },
  {
    id: 'E-067', category: 'not-found', method: 'news.get',
    params: { articleId: '$missingArticleId' },
    expect: { code: 'NOT_FOUND', http: 404, message: ERROR_CODES.NOT_FOUND.message, field: null },
  },
  {
    id: 'E-068', category: 'forbidden', method: 'chat.messages',
    params: { sessionId: '$sessionId' }, asStudent: 'B',
    expect: { code: 'FORBIDDEN', http: 403, message: ERROR_CODES.FORBIDDEN.message, field: null },
  },
  {
    id: 'E-069', category: 'unknown-method', method: 'learning.__nonexistent__', params: {},
    expect: {
      code: 'UNKNOWN_METHOD', http: 404,
      message: `没有这个方法：learning.__nonexistent__`, field: null,
    },
  },
]

/** 30 个方法名（按冻结 §5 顺序），coverage 侧核对 OpenAPI 枚举用。 */
export const METHOD_NAMES = METHODS.map((row) => row.method)

/** legacy 方法名（冻结 §6），coverage 侧核对 x-legacy-methods 用。 */
export const LEGACY_NAMES = LEGACY_METHODS.map((row) => row.method)

/**
 * 方法名的 `<Method>Result` schema 命名（点转驼峰）：`news.list` → `NewsListResult`（冻结 §8）。
 * @param {string} method
 */
export function resultSchemaName(method) {
  const pascal = String(method)
    .split('.')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
  return `${pascal}Result`
}

/** 30 个方法名对应的 Result schema 清单（E-080 期望集合）。 */
export const RESULT_SCHEMA_NAMES = METHOD_NAMES.map((name) => resultSchemaName(name))

/**
 * 逐字段消息构造：`<field> 不能为空。`（02-contract §4.2 唯一允许的拼装方式）。
 * @param {string} field
 */
export function requiredMessage(field) {
  return `${field}${REQUIRED_SUFFIX}`
}

/** 未知方法消息：`没有这个方法：<method>`（冻结 §4.2 与 E-02 §4.3）。 */
export function unknownMethodMessage(method) {
  return `${ERROR_CODES.UNKNOWN_METHOD.message}${method}`
}
