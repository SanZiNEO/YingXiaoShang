// @yxs/migrate-pg · target.js
//
// 目标库身份守卫。三个入口过去只按 PGHOST/PGPORT/PGDATABASE 连接，没有任何「这是不是
// D 轮演练库」的判断：`PGPORT=5432 PGDATABASE=prod` 时 `migrate --rebuild` 会照章执行
// `DROP TABLE IF EXISTS` 38 张同名表，`rollback --apply` 会直接删表。库名相同就足以毁掉
// 一个真实业务库，因此写操作必须先证明目标是演练实例。
//
// 身份判据（02-contract §10.2 冻结值）：库名 `yxs`、宿主端口 `55432`。两者都符合才算
// 演练目标。判据本身可用环境变量覆盖，方便在别的机器上钉住自己的专用实例而不改代码：
//   YXS_PG_EXPECT_DATABASE / YXS_PG_EXPECT_PORT
//
// 写操作（缺省 upsert、`migrate --rebuild`、`rollback --apply`）在目标不匹配时默认拒绝
// （退出 1），只有显式 --force-target 才继续。只读操作（migrate --dry-run、verify、
// rollback dry-run）只打印一行警告，不阻断。

import { exitUsage } from './cli.js'

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 55432
export const DEFAULT_DATABASE = 'yxs'
export const DEFAULT_USER = 'yxs'

// --pg-url 省略端口时的 libpq 默认值；与本工具的演练端口 55432 是两回事。
const PG_URL_DEFAULT_PORT = 5432

// 连接参数读取顺序：--pg-url > 环境变量 > 契约默认值（密码无默认）。
export function buildPgConfig(pgUrl) {
  if (pgUrl) return { connectionString: pgUrl }
  return {
    host: process.env.PGHOST || DEFAULT_HOST,
    port: Number(process.env.PGPORT) || DEFAULT_PORT,
    database: process.env.PGDATABASE || DEFAULT_DATABASE,
    user: process.env.PGUSER || DEFAULT_USER,
    password: process.env.PGPASSWORD || undefined,
  }
}

// 从连接配置还原出「实际会连到哪里」，供日志与守卫共用。密码绝不进入返回值。
// --pg-url 缺省端口/库名时按 libpq 语义补：端口 5432、库名等于用户名。若这里也退回
// 本工具的 55432/yxs 默认值，一个省略端口的连接串会被误判成演练目标，守卫就失效了。
export function targetIdentity(pgUrl) {
  if (pgUrl) {
    let u
    try {
      u = new URL(pgUrl)
    } catch {
      exitUsage('--pg-url 不是合法的连接串。')
    }
    const user = decodeURIComponent(u.username || '') || process.env.PGUSER || DEFAULT_USER
    const database = decodeURIComponent((u.pathname || '/').replace(/^\//, '')) || user
    return {
      host: u.hostname || DEFAULT_HOST,
      port: Number(u.port) || PG_URL_DEFAULT_PORT,
      database,
      user,
    }
  }
  return {
    host: process.env.PGHOST || DEFAULT_HOST,
    port: Number(process.env.PGPORT) || DEFAULT_PORT,
    database: process.env.PGDATABASE || DEFAULT_DATABASE,
    user: process.env.PGUSER || DEFAULT_USER,
  }
}

// 日志用连接串：密码任何情况下替换为 ***。
export function describeTarget(pgUrl) {
  const id = targetIdentity(pgUrl)
  return `postgres://${id.user}@${id.host}:${id.port}/${id.database}`
}

function expectedIdentity() {
  const database = process.env.YXS_PG_EXPECT_DATABASE || DEFAULT_DATABASE
  const rawPort = process.env.YXS_PG_EXPECT_PORT
  const port = rawPort ? Number(rawPort) : DEFAULT_PORT
  return { database, port }
}

// 目标与演练实例是否一致；返回不匹配的原因（空数组表示一致）。
export function identityProblems(id) {
  const expected = expectedIdentity()
  const problems = []
  if (id.database !== expected.database) {
    problems.push(`库名 ${id.database}（预期 ${expected.database}）`)
  }
  if (id.port !== expected.port) {
    problems.push(`端口 ${id.port}（预期 ${expected.port}）`)
  }
  return problems
}

// 写操作前的守卫。不匹配且未给 --force-target 时退出 1，不建立连接、不执行任何 SQL。
export function guardWriteTarget(id, force) {
  const problems = identityProblems(id)
  if (problems.length === 0) return
  if (force) {
    console.error(
      `[guard] 目标库与演练实例不一致（${problems.join('；')}），已按 --force-target 继续；写操作后果自负。`,
    )
    return
  }
  exitUsage(
    `拒绝在非演练目标上执行写操作：${problems.join('；')}。` +
      '确认目标无误后加 --force-target 显式放行。',
  )
}

// 只读操作：不匹配只警告，不阻断（verify、rollback dry-run 都是只读；migrate --dry-run 只打印计划）。
export function warnNonProvisionalTarget(id) {
  const problems = identityProblems(id)
  if (problems.length === 0) return
  console.error(`[guard] 注意：目标库与演练实例不一致（${problems.join('；')}），本次未执行写操作。`)
}

// 连上之后的二次确认：配置里写的库名可能被 PGSERVICE/PGOPTIONS 之类改写，只有
// current_database() 反映真实落点。写操作前必须核对。
// 端口不在服务端核对：docker 把宿主 55432 映射到容器 5432，inet_server_port() 返回的是
// 容器内端口，拿它比对宿主端口会误伤正常部署。端口判据只在客户端侧（identityProblems）。
export async function assertConnectedTarget(client, id, force) {
  const res = await client.query('SELECT current_database() AS db')
  const row = res.rows[0] || {}
  const actualDatabase = row.db === null || row.db === undefined ? id.database : String(row.db)
  const actual = { ...id, database: actualDatabase }
  if (actualDatabase === id.database) return actual
  const detail = `实际库名 ${actualDatabase} 与配置的 ${id.database} 不符`
  if (force) {
    console.error(`[guard] ${detail}，已按 --force-target 继续。`)
    return actual
  }
  exitUsage(`拒绝在非演练目标上执行写操作：${detail}。确认目标无误后加 --force-target 显式放行。`)
}
