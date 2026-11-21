import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const N = 16384
const R = 8
const P = 1
const KEY_LENGTH = 64
const SALT_BYTES = 16
const MAX_MEM = 64 * 1024 * 1024
const PREFIX = 'scrypt'

function encode(buffer: Buffer): string {
  return buffer.toString('base64url')
}

function decode(value: string): Buffer {
  return Buffer.from(value, 'base64url')
}

/** `scrypt$N$r$p$salt$hash`, both base64url. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES)
  const hash = scryptSync(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEM,
  })
  return [PREFIX, N, R, P, encode(salt), encode(hash)].join('$')
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== PREFIX) return false
  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (![n, r, p].every((value) => Number.isInteger(value) && value > 0)) return false
  // Never let a tampered row drive unbounded memory.
  if (n > 32768 || r > 16 || p > 4) return false
  let salt: Buffer
  let expected: Buffer
  try {
    salt = decode(parts[4] ?? '')
    expected = decode(parts[5] ?? '')
  } catch {
    return false
  }
  if (salt.length < 8 || expected.length !== KEY_LENGTH) return false
  const actual = scryptSync(password.normalize('NFKC'), salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: MAX_MEM,
  })
  return timingSafeEqual(actual, expected)
}
