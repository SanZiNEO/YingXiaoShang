import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'

const result = await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-workspace',
  ],
  logLevel: 'warning',
})

const code = result.outputFiles[0].text
const wrapped = `window.__ModuleLoader__.load({
  id: "@learning-agent/ui",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
${code}
    return module.exports;
  }
});
`
await writeFile('lib/client.js', wrapped, 'utf8')
console.log(`wrote lib/client.js (${wrapped.length} bytes)`)

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: false,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  logLevel: 'warning',
})
console.log('wrote lib/index.js')
