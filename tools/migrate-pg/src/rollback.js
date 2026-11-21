// @yxs/migrate-pg · rollback.js
//
// 默认 dry-run：只打印 schema-map.js 本轮登记、且 PG public schema 中实际存在的表，
// 按依赖逆序（DROP_ORDER）列出，不执行任何 DROP；--apply 才在单个事务内逆序
// DROP TABLE，任一失败整体回滚。
//
// 边界（02-contract §2.4 / §5.3，03-implementation §4.3）：
//   - 清理范围仅限 schema-map.js 登记表名集合；绝不 DROP 登记集合之外的表；
//   - 禁止 DROP DATABASE、禁止 TRUNCATE 任何共享库；
//   - 中文错误消息不带 [rollback] 前缀，阶段行才带前缀。
//   - --apply 是写操作：目标库必须通过身份守卫（库 yxs / 端口 55432），否则默认拒绝。

import { loadPg } from './pg-driver.js'
import { TABLE_NAMES, DROP_ORDER } from './schema-map.js'
import { Fatal, exitUsage, splitToken, takeValue, unknownArg } from './cli.js'
import {
  buildPgConfig,
  describeTarget,
  targetIdentity,
  guardWriteTarget,
  warnNonProvisionalTarget,
  assertConnectedTarget,
} from './target.js'

const REGISTERED = new Set(TABLE_NAMES)

const USAGE = `用法：node tools/migrate-pg/src/rollback.js [选项]

  --dry-run                  只打印待删清单（默认行为）
  --apply                    在单事务内逆序 DROP 本轮登记的 38 张表
  --pg-url <url>             PG 连接串；给出后覆盖全部 PG* 环境变量
  --force-target             目标库不是演练实例（库 yxs / 端口 55432）时仍执行 --apply
  -h, --help                 打印本帮助

连接默认值：PGHOST=127.0.0.1 PGPORT=55432 PGDATABASE=yxs PGUSER=yxs（密码无默认）。
`

function parseArgs(argv) {
  const opts = { pgUrl: null, dryRunGiven: false, apply: false, forceTarget: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const { name, inline } = splitToken(argv[i])
    switch (name) {
      case '--pg-url': {
        const v = takeValue(argv, i, inline)
        if (v.value === null) exitUsage('--pg-url 缺少取值：PG 连接串。')
        opts.pgUrl = v.value
        i = v.next
        break
      }
      case '--dry-run':
        opts.dryRunGiven = true
        break
      case '--apply':
        opts.apply = true
        break
      case '--force-target':
        opts.forceTarget = true
        break
      case '-h':
      case '--help':
        opts.help = true
        break
      default:
        unknownArg('rollback.js', argv[i])
    }
  }
  return opts
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"'
}

// 枚举 PG public schema 中实际存在、且属于本轮登记表的表；顺序沿用 DROP_ORDER
// （父表在子表之后删除）。登记集合之外的表一律不进入清单。
async function listExistingRegisteredTables(client) {
  const res = await client.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'`,
  )
  const existing = new Set(res.rows.map((r) => r.table_name))
  return DROP_ORDER.filter((name) => REGISTERED.has(name) && existing.has(name))
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  if (opts.help) {
    process.stdout.write(USAGE)
    return
  }

  // t0：--apply 与 --dry-run 同给 → 退出 1。
  if (opts.apply && opts.dryRunGiven) {
    exitUsage('--apply 与 --dry-run 不能同时使用。')
  }

  const targetId = targetIdentity(opts.pgUrl)
  if (opts.apply) {
    guardWriteTarget(targetId, opts.forceTarget)
  } else {
    warnNonProvisionalTarget(targetId)
  }
  console.log(`[rollback] target: ${describeTarget(opts.pgUrl)}`)

  let client
  try {
    const { default: pg } = await loadPg()
    client = new pg.Client(buildPgConfig(opts.pgUrl))
    await client.connect()
  } catch (err) {
    console.error(`无法连接 PostgreSQL：${err.message}。请检查 PGHOST、PGPORT、PGUSER、PGPASSWORD。`)
    process.exit(2)
  }

  // 连上之后复核真实库名：配置里的库名可能被 PGSERVICE/PGOPTIONS 改写。
  if (opts.apply) {
    try {
      await assertConnectedTarget(client, targetId, opts.forceTarget)
    } catch (err) {
      await client.end().catch(() => {})
      throw err
    }
  }

  let targets
  try {
    targets = await listExistingRegisteredTables(client)
  } catch (err) {
    await client.end().catch(() => {})
    console.error(`无法读取目标库表清单：${err.message}。`)
    process.exit(2)
  }

  // t3：--apply，单事务内逆序 DROP；任一失败整体回滚，退出 2。
  if (opts.apply) {
    try {
      await client.query('BEGIN')
      for (const name of targets) {
        await client.query(`DROP TABLE IF EXISTS ${quoteIdent(name)}`)
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      await client.end().catch(() => {})
      console.error(`回滚事务失败，未删除任何表：${err.message}。`)
      process.exit(2)
    }
    await client.end().catch(() => {})

    console.log(`[rollback] apply：已在单事务内删除以下 ${targets.length} 张本轮登记的表：`)
    targets.forEach((name, idx) => {
      console.log(`  ${idx + 1}. ${name}`)
    })
    if (targets.length === 0) {
      console.log('[rollback] 本轮登记表在目标库中均不存在，无需删除。')
    }
    process.exit(0)
  }

  // t2：dry-run（默认），只打印清单，不执行任何 DROP。
  console.log('[rollback] dry-run（未删除任何数据）')
  console.log(`[rollback] 将按依赖逆序删除以下 ${targets.length} 张本轮登记的表：`)
  targets.forEach((name, idx) => {
    console.log(`  ${idx + 1}. ${name}`)
  })
  console.log('[rollback] 确认执行请加 --apply。')
  console.log('未执行删除：rollback 默认 dry-run；确认后加 --apply。')

  await client.end().catch(() => {})
  process.exit(0)
}

main().catch((err) => {
  if (err instanceof Fatal) {
    console.error(err.message)
    process.exit(err.code)
  }
  console.error(`回滚失败：${err.message}。`)
  process.exit(2)
})
