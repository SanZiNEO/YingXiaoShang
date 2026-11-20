import type { MethodSpec } from './types.js'
import {
  artifactMethods,
  chatMethods,
  contentMethods,
  legacyMethods,
  memoryMethods,
  profileMethods,
  studentMethods,
} from './handlers/index.js'

/**
 * The single source of truth for the RPC method surface.
 *
 * The first 30 entries follow the frozen contract order (00-master §5); the
 * four trailing entries are Electron-era read-only compatibility methods
 * marked `legacy: true` (00-master §6).
 */
export const METHODS: MethodSpec[] = [
  ...studentMethods,
  ...contentMethods,
  ...profileMethods,
  ...artifactMethods,
  ...memoryMethods,
  ...chatMethods,
  ...legacyMethods,
]
