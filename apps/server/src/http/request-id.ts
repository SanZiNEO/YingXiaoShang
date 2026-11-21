import { randomBytes } from 'node:crypto'

/**
 * Frozen §2.1: a client-supplied `requestId` is adopted only when it matches
 * this shape; anything else is silently replaced instead of failing the call.
 */
export const REQUEST_ID_PATTERN = /^req_[a-z0-9]{1,24}$/

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
/** Frozen §4.1: `req_` plus 12 base36 characters. */
const SUFFIX_LENGTH = 12
/** 252 = 36 × 7; bytes at or above it are dropped so `% 36` stays unbiased. */
const UNBIASED_LIMIT = 252

/**
 * Generates the server-side id. Always exactly 12 suffix characters, so it
 * always satisfies `REQUEST_ID_PATTERN` — a `base64url` slice used to produce
 * shorter (and occasionally empty) suffixes because `-`/`_` were stripped.
 */
export function newRequestId(): string {
  let suffix = ''
  while (suffix.length < SUFFIX_LENGTH) {
    for (const byte of randomBytes(SUFFIX_LENGTH)) {
      if (byte >= UNBIASED_LIMIT) continue
      suffix += ALPHABET[byte % ALPHABET.length]
      if (suffix.length === SUFFIX_LENGTH) break
    }
  }
  return `req_${suffix}`
}
