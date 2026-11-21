import { ApiError } from '../errors.js'

/** Frozen §4.3: the type error for a numeric parameter is one sentence per field. */
const INTEGER_MESSAGE = (key: string): string => `${key} 必须是整数。`

export function fail(message: string, field: string): never {
  throw new ApiError(400, 'BAD_REQUEST', message, field)
}

export function requiredString(
  params: Record<string, unknown>,
  key: string,
  options: { max?: number; message: string },
): string {
  const value = params[key]
  if (typeof value !== 'string' || value.trim().length === 0) fail(options.message, key)
  const trimmed = value.trim()
  if (options.max !== undefined && trimmed.length > options.max) fail(options.message, key)
  return value
}

export function optionalString(
  params: Record<string, unknown>,
  key: string,
  options: { max?: number; message: string },
): string | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') fail(options.message, key)
  if (options.max !== undefined && value.length > options.max) fail(options.message, key)
  return value
}

/**
 * Numeric params split two failures apart because the contract does (§4.3):
 * a wrong type is `limit 必须是整数。` while an out-of-range integer is the
 * per-method range sentence. `field` is the bare key — §4.1's sample response
 * carries `"field": "limit"`, not `"params.limit"`.
 */
export function requiredNumber(
  params: Record<string, unknown>,
  key: string,
  options: { min: number; max: number; message: string },
): number {
  const value = params[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(INTEGER_MESSAGE(key), key)
  if (!Number.isInteger(value)) fail(INTEGER_MESSAGE(key), key)
  if (value < options.min || value > options.max) fail(options.message, key)
  return value
}

export function optionalNumber(
  params: Record<string, unknown>,
  key: string,
  options: { min: number; max: number; message: string },
): number | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  return requiredNumber(params, key, options)
}

export function oneOf<T extends string>(
  value: string,
  allowed: readonly T[],
  message: string,
  field: string,
): T {
  if (!(allowed as readonly string[]).includes(value)) fail(message, field)
  return value as T
}

export function stringArray(
  value: unknown,
  options: { maxItems: number; maxLength: number; message: string; field: string },
): string[] {
  if (!Array.isArray(value) || value.length === 0) fail(options.message, options.field)
  if (value.length > options.maxItems) fail(options.message, options.field)
  const output: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0 || item.length > options.maxLength) {
      fail(options.message, options.field)
    }
    output.push(item)
  }
  return output
}
