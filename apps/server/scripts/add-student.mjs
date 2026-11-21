/**
 * Create or update a test student in auth.db (AC-A-02 setup).
 *
 * Usage:
 *   node scripts/add-student.mjs --id 20230001 --name 张三 --cohort 2023 --password abc12345
 *
 * The password is hashed with scrypt before storage (src/auth/passwords.ts);
 * no plaintext password is persisted. The auth db path comes from
 * YXS_AUTH_DB_PATH, otherwise <LEARNING_AGENT_HOME>/data/auth.db.
 */

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tsImport } from 'tsx/esm/api'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg?.startsWith('--')) {
      out[arg.slice(2)] = argv[i + 1]
      i += 1
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const studentId = args.id
const name = args.name ?? ''
const cohort = args.cohort ?? ''
const password = args.password

if (!studentId || !/^[A-Za-z0-9]{4,20}$/.test(studentId)) {
  console.error('缺少合法的 --id（4..20 位字母数字）')
  process.exit(2)
}
if (!password) {
  console.error('缺少 --password')
  process.exit(2)
}

const home = process.env.LEARNING_AGENT_HOME ?? join(repoRoot, '.learning-agent')
const authDbPath = process.env.YXS_AUTH_DB_PATH ?? join(home, 'data', 'auth.db')
mkdirSync(dirname(authDbPath), { recursive: true })

const storeUrl = pathToFileURL(join(here, '..', 'src', 'auth', 'store.ts')).href
const { AuthStore } = await tsImport(storeUrl, {
  parentURL: import.meta.url,
})

const store = new AuthStore(authDbPath)
try {
  const student = store.upsertStudent({ studentId, password, name, cohort })
  console.log(JSON.stringify({ ok: true, studentId: student.student_id, name: student.name, cohort: student.cohort, authDbPath }))
} finally {
  store.close()
}
