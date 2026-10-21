import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Development uses the repo-local demo database; packaged builds use the OS home.
process.env.LEARNING_AGENT_HOME ||= resolve('../../.learning-agent')

/**
 * Bundled dependencies that report their own version do
 * `createRequire(import.meta.url)('../package.json')`. Once inlined into
 * `out/main/index.js` that path points at `out/package.json`, so emit it.
 */
function emitMainPackageJson() {
  return {
    name: 'emit-main-package-json',
    closeBundle() {
      const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
      mkdirSync(resolve('out'), { recursive: true })
      writeFileSync(resolve('out', 'package.json'), `${JSON.stringify({ version }, null, 2)}\n`)
    },
  }
}

/**
 * Everything the main process needs is bundled, so the packaged app carries no
 * `node_modules` at all (pnpm's peer-suffixed instances cannot be collected
 * reliably by a packager). `electron` is provided by the runtime; `playwright`
 * stays external on purpose — it is loaded lazily and must fail gracefully on a
 * machine that has no browsers, which a bundled copy could not do.
 */
const EXTERNAL = ['electron', 'playwright', 'playwright-core']

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external: EXTERNAL,
        output: { format: 'es' },
      },
    },
    plugins: [emitMainPackageJson()],
  },
  preload: {
    build: {
      rollupOptions: {
        external: ['electron'],
      },
    },
  },
  renderer: {
    plugins: [react()],
  },
})
