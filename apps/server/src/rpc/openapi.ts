/**
 * OpenAPI 3.0.3 renderer for the server contract.
 *
 * The method names and their resultSchema names are read from the single
 * source of truth: `METHODS` in `../rpc/registry.js`. This module must not
 * keep a second hand-written method list (03-implementation §3.2, §3.10).
 * Result entity fragments come from `./schemas.js`.
 *
 * `renderOpenApi()` returns the complete YAML text; `GET /api/v1/openapi.yaml`
 * serves the generated `docs/contracts/openapi.yaml` verbatim.
 */

import { stringify } from 'yaml'
import { METHODS } from './registry.js'
import { SCHEMAS } from './schemas.js'

/** Static documentation for the four Electron-era compatibility methods. */
const LEGACY_META: Record<string, { params: Record<string, string>; result: string; notes: string }> = {
  getKp: {
    params: { kpId: 'string' },
    result: 'KnowledgePoint | null',
    notes: '引用溯源：按知识点 id 读取单个知识点。只读，不计入 30 方法清单。',
  },
  getBlock: {
    params: { blockId: 'string' },
    result: '{ block: ContentBlock, chapter?: Chapter, section?: Section }',
    notes: '引用溯源：源文跳转，附章节与小节上下文。只读，不计入 30 方法清单。',
  },
  getResource: {
    params: { resourceId: 'string（兼容 sourceId）' },
    result: '{ guide: object, chapter?: Chapter }',
    notes: '资源引用溯源。只读，不计入 30 方法清单。',
  },
  listIdeology: {
    params: {},
    result: 'IdeologyPoint[]',
    notes: '思政点列表页。只读，不计入 30 方法清单。',
  },
}

const JSON_CONTENT = (schema: Record<string, unknown>): Record<string, unknown> => ({
  'application/json': { schema },
})

const ERROR_RESPONSES: Record<string, Record<string, unknown>> = {
  '400': { description: '参数校验失败（BAD_REQUEST）', content: JSON_CONTENT({ $ref: '#/components/schemas/ErrorBody' }) },
  '401': { description: '未登录或登录已失效（AUTH_REQUIRED / AUTH_INVALID / AUTH_FAILED）', content: JSON_CONTENT({ $ref: '#/components/schemas/ErrorBody' }) },
  '403': { description: '资源不属于当前学号（FORBIDDEN）', content: JSON_CONTENT({ $ref: '#/components/schemas/ErrorBody' }) },
  '404': { description: '记录或方法不存在（NOT_FOUND / UNKNOWN_METHOD）', content: JSON_CONTENT({ $ref: '#/components/schemas/ErrorBody' }) },
  '413': { description: '请求体超过 1 MiB（PAYLOAD_TOO_LARGE）', content: JSON_CONTENT({ $ref: '#/components/schemas/ErrorBody' }) },
  '429': { description: '触发限流（RATE_LIMITED）', content: JSON_CONTENT({ $ref: '#/components/schemas/ErrorBody' }) },
  '500': { description: '服务端内部错误（INTERNAL）', content: JSON_CONTENT({ $ref: '#/components/schemas/ErrorBody' }) },
  '501': { description: '预留能力尚未实现（NOT_IMPLEMENTED）', content: JSON_CONTENT({ $ref: '#/components/schemas/ErrorBody' }) },
  '502': { description: '上游依赖失败（UPSTREAM_FAILED）', content: JSON_CONTENT({ $ref: '#/components/schemas/ErrorBody' }) },
  '504': { description: '上游超时（TIMEOUT）', content: JSON_CONTENT({ $ref: '#/components/schemas/ErrorBody' }) },
}

function okResponse(description: string, schema: Record<string, unknown>): Record<string, unknown> {
  return { description, content: JSON_CONTENT(schema) }
}

function envelope(resultSchema: string): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: true,
    required: ['ok', 'result', 'requestId', 'elapsedMs'],
    properties: {
      ok: { type: 'boolean' },
      result: { $ref: `#/components/schemas/${resultSchema}` },
      requestId: { type: 'string', example: 'req_9f2a1b3c4d5e' },
      elapsedMs: { type: 'integer' },
    },
  }
}

export function renderOpenApi(): string {
  const mainMethods = METHODS.filter((item) => !item.legacy)
  const legacyMethods = METHODS.filter((item) => item.legacy)

  const methodEnum = mainMethods.map((item) => item.name)

  const rpcResultSchema = mainMethods[0]?.resultSchema ?? 'StudentCurrentResult'

  const legacyMethodsDoc = legacyMethods.map((item) => {
    const meta = LEGACY_META[item.name] ?? { params: {}, result: 'object', notes: '' }
    return { name: item.name, params: meta.params, result: meta.result, notes: meta.notes }
  })

  const doc: Record<string, unknown> = {
    openapi: '3.0.3',
    info: {
      title: '营小商服务端',
      version: '0.1.0',
      description: '营小商学习助手服务端：30 个 RPC 业务方法、5 个专用通道与 4 个只读兼容方法。',
    },
    servers: [{ url: 'http://127.0.0.1:8080' }],
    security: [{ bearerAuth: [] }],
    paths: {
      '/health': {
        get: {
          summary: '存活与数据自检（无前缀，容器探活使用）',
          security: [],
          responses: {
            '200': okResponse('健康检查结果', { $ref: '#/components/schemas/HealthResult' }),
            '503': { description: '数据库打不开或数据缺失', content: JSON_CONTENT({ $ref: '#/components/schemas/ErrorBody' }) },
          },
        },
      },
      '/metrics': {
        get: {
          summary: 'Prometheus 指标文本',
          security: [],
          responses: {
            '200': {
              description: 'text/plain; version=0.0.4',
              content: { 'text/plain': { schema: { type: 'string' } } },
            },
          },
        },
      },
      '/api/v1/health': {
        get: {
          summary: '存活与数据自检（带 API 前缀）',
          security: [],
          responses: {
            '200': okResponse('健康检查结果', { $ref: '#/components/schemas/HealthResult' }),
            '503': { description: '数据库打不开或数据缺失', content: JSON_CONTENT({ $ref: '#/components/schemas/ErrorBody' }) },
          },
        },
      },
      '/api/v1/auth/login': {
        post: {
          summary: '学号 + 口令登录',
          security: [],
          requestBody: {
            required: true,
            content: JSON_CONTENT({
              type: 'object',
              additionalProperties: true,
              required: ['studentId', 'password'],
              properties: {
                studentId: { type: 'string', example: '20230001' },
                password: { type: 'string', format: 'password' },
              },
            }),
          },
          responses: {
            '200': okResponse('登录成功', envelope('LoginResult')),
            ...ERROR_RESPONSES,
          },
        },
      },
      '/api/v1/auth/logout': {
        post: {
          summary: '注销当前 token',
          responses: {
            '200': okResponse('已注销', {
              type: 'object',
              additionalProperties: true,
              required: ['ok'],
              properties: { ok: { type: 'boolean' } },
            }),
            ...ERROR_RESPONSES,
          },
        },
      },
      '/api/v1/auth/cas/callback': {
        get: {
          summary: 'CAS 统一身份认证回调（预留，本阶段 501）',
          security: [],
          responses: { '501': ERROR_RESPONSES['501'] },
        },
        post: {
          summary: 'CAS 统一身份认证回调（预留，本阶段 501）',
          security: [],
          responses: { '501': ERROR_RESPONSES['501'] },
        },
      },
      '/api/v1/auth/oauth/callback': {
        get: {
          summary: 'OAuth2 回调（预留，本阶段 501）',
          security: [],
          responses: { '501': ERROR_RESPONSES['501'] },
        },
        post: {
          summary: 'OAuth2 回调（预留，本阶段 501）',
          security: [],
          responses: { '501': ERROR_RESPONSES['501'] },
        },
      },
      '/api/v1/rpc': {
        post: {
          summary: 'RPC 单端点分发（30 个业务方法）',
          requestBody: {
            required: true,
            content: JSON_CONTENT({
              type: 'object',
              additionalProperties: true,
              required: ['method'],
              properties: {
                method: { type: 'string', enum: methodEnum },
                params: { type: 'object', additionalProperties: true },
                requestId: { type: 'string', pattern: '^req_[a-z0-9]{1,24}$' },
              },
            }),
          },
          responses: {
            '200': okResponse('调用成功（result 形状随 method 而定）', envelope(rpcResultSchema)),
            ...ERROR_RESPONSES,
          },
        },
      },
      '/api/v1/chat/stream': {
        post: {
          summary: '对话 SSE 流式通道',
          description: '事件顺序：session → (round | text | tool | tool-end)* → done；异常只发 error 后关闭。',
          requestBody: {
            required: true,
            content: JSON_CONTENT({
              type: 'object',
              additionalProperties: true,
              required: ['message'],
              properties: {
                sessionId: { type: 'string' },
                message: { type: 'string', maxLength: 8000 },
                chapterId: { type: 'string' },
                scopeOverride: { type: 'object', additionalProperties: true },
                requestId: { type: 'string', pattern: '^req_[a-z0-9]{1,24}$' },
              },
            }),
          },
          responses: {
            '200': {
              description: 'text/event-stream 帧序列',
              content: { 'text/event-stream': { schema: { type: 'string', format: 'binary' } } },
            },
            ...ERROR_RESPONSES,
          },
        },
      },
      '/api/v1/chat/cancel': {
        post: {
          summary: '取消在途轮次',
          requestBody: {
            required: true,
            content: JSON_CONTENT({
              type: 'object',
              additionalProperties: true,
              required: ['requestId'],
              properties: { requestId: { type: 'string', pattern: '^req_[a-z0-9]{1,24}$' } },
            }),
          },
          responses: {
            '200': okResponse('取消指令已投递（cancelled=false 表示无在途轮次）', {
              type: 'object',
              additionalProperties: true,
              required: ['cancelled'],
              properties: { cancelled: { type: 'boolean' } },
            }),
            ...ERROR_RESPONSES,
          },
        },
      },
      '/api/v1/answer': {
        post: {
          summary: '单题作答',
          requestBody: {
            required: true,
            content: JSON_CONTENT({
              type: 'object',
              additionalProperties: true,
              required: ['sessionId', 'questionId', 'answer'],
              properties: {
                sessionId: { type: 'string' },
                questionId: { type: 'string' },
                answer: { type: 'string' },
                artifactId: { type: 'string' },
                chapterId: { type: 'string' },
              },
            }),
          },
          responses: {
            '200': okResponse('作答结果', envelope('AnswerOutput')),
            ...ERROR_RESPONSES,
          },
        },
      },
      '/api/v1/answer-set': {
        post: {
          summary: '交卷（整份题目集）',
          requestBody: {
            required: true,
            content: JSON_CONTENT({
              type: 'object',
              additionalProperties: true,
              required: ['sessionId', 'artifactId', 'answers'],
              properties: {
                sessionId: { type: 'string' },
                artifactId: { type: 'string' },
                chapterId: { type: 'string' },
                answers: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: true,
                    required: ['questionId', 'answer'],
                    properties: {
                      questionId: { type: 'string' },
                      answer: { type: 'string' },
                    },
                  },
                },
              },
            }),
          },
          responses: {
            '200': okResponse('交卷结果', envelope('AnswerSetOutput')),
            ...ERROR_RESPONSES,
          },
        },
      },
      '/api/v1/openapi.yaml': {
        get: {
          summary: '返回本契约文件原文',
          security: [],
          responses: {
            '200': {
              description: 'OpenAPI YAML 文本',
              content: { 'application/yaml': { schema: { type: 'string' } } },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'opaque' },
      },
      schemas: SCHEMAS,
    },
    'x-legacy-methods': legacyMethodsDoc,
  }

  return stringify(doc, { lineWidth: 140 })
}
