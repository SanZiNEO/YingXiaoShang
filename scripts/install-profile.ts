import { cp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', 'learning-agent')
const packagesDir = join(repoRoot, 'packages')

await mkdir(profileDir, { recursive: true })
await cp(join(repoRoot, 'profiles', 'learning-agent', 'cordis.patch.yml'), join(profileDir, 'cordis.patch.yml'))

const entries = await readdir(packagesDir, { withFileTypes: true })
const learningPackages = entries
  .filter((entry) => entry.isDirectory() && existsSync(join(packagesDir, entry.name, 'package.json')))
  .map((entry) => entry.name)

const dependencies: Record<string, string> = {
  '@deepseek-ai/dsh-base': '0.2.1-rc.2',
  '@deepseek-ai/dsh-web-app': '0.2.1-rc.2',
}
for (const name of learningPackages) {
  dependencies[`@learning-agent/${name}`] = `link:${join(packagesDir, name)}`
}

const profilePackage = {
  name: '@learning-agent/profile-learning',
  private: true,
  type: 'module',
  dependencies,
  dsh: {
    profile: {
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@learning-agent/bundle'],
    },
  },
}

await writeFile(join(profileDir, 'package.json'), `${JSON.stringify(profilePackage, null, 2)}\n`, 'utf8')
console.log(`wrote ${join(profileDir, 'package.json')}`)

const result = spawnSync('pnpm', ['install', '--no-frozen-lockfile', '--config.strict-dep-builds=false'], {
  cwd: profileDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if (result.status !== 0) {
  console.error('pnpm install failed in the learning profile')
  process.exit(result.status ?? 1)
}

console.log('')
console.log('Profile installed. Start it with:')
console.log('  pnpm run dev:web')
