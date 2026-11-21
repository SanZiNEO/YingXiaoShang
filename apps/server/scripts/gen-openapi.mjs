/**
 * Generate docs/contracts/openapi.yaml from the compiled registry metadata.
 *
 * The method names and resultSchema names come from METHODS in
 * src/rpc/registry.ts (the single source of truth); this script must not keep
 * its own method list. Run with: pnpm --filter @yxs/server gen:openapi
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tsImport } from 'tsx/esm/api'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const openapiPath = join(repoRoot, 'docs', 'contracts', 'openapi.yaml')

const openapiUrl = pathToFileURL(join(here, '..', 'src', 'rpc', 'openapi.ts')).href
const mod = await tsImport(openapiUrl, { parentURL: import.meta.url })

const text = mod.renderOpenApi()
mkdirSync(dirname(openapiPath), { recursive: true })
writeFileSync(openapiPath, text, 'utf8')
console.log(`wrote ${openapiPath} (${Buffer.byteLength(text, 'utf8')} bytes)`)
