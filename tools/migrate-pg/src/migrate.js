// @yxs/migrate-pg · migrate.js
//
// SQLite learning.db 副本 → PostgreSQL 16 迁移入口（纯 ESM JavaScript，无编译步骤）。
// 口径来源：plans/server-client-split/D-pg-migration/02-contract.md、03-implementation.md、
// 04-acceptance.md；表结构唯一真相源是同目录 schema-map.js，本文件不复制第二份列清单。
//
// 边界：
//   - 源库只读打开；不写回源库；源路径只接受 <repo>/.scratch/run/D/ 下的副本（可用
//     --allow-source-outside-scratch 显式放行）；
//   - 缺省幂等路径：stage 临时表 + COPY … FROM STDIN + INSERT … ON CONFLICT DO UPDATE；
//     不 TRUNCATE、不清表；--rebuild 才按 DROP_ORDER 逆序 DROP 登记表后重建；
//   - 中文错误消息不带 [migrate] 前缀，阶段行才带前缀；PG 不可达如实退出 2，不伪造成功。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { loadPg } from './pg-driver.js'
import {
  TABLES,
  TABLE_BY_NAME,
  TABLE_NAMES,
  CREATE_ORDER,
  DROP_ORDER,
  buildDdl,
  diffAgainstSource,
  describeDrift,
  isDriftFree,
} from './schema-map.js'
import { valueForCopy } from './values.js'
import { Fatal, exitUsage, splitToken, takeValue, unknownArg } from './cli.js'
import {
  buildPgConfig,
  describeTarget,
  targetIdentity,
  guardWriteTarget,
  warnNonProvisionalTarget,
  assertConnectedTarget,
} from './target.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// src/ 到仓库根是三级；按本文件位置推导，不依赖当前工作目录。
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const SCRATCH_ROOT = path.join(REPO_ROOT, '.scratch', 'run', 'D')
const SOURCE_INDEX = path.join(REPO_ROOT, 'packages', 'db', 'src', 'index.ts')

const COPY_BATCH_ROWS = 5000

const USAGE = `用法：node tools/migrate-pg/src/migrate.js --source <sqlite 路径> [选项]

  --source, --sqlite <path>   SQLite 源库副本路径（必填）
  --pg-url <url>              PG 连接串；给出后覆盖全部 PG* 环境变量
  --dry-run                   只打印 schema 计划与每表行数，不建表、不写库
  --rebuild                   导入前按依赖逆序 DROP 本轮登记的 38 张表后重建
  --allow-source-outside-scratch
                              放行 .scratch/run/D/ 之外的源路径
  --force-target              目标库不是演练实例（库 yxs / 端口 55432）时仍执行写操作
  -h, --help                  打印本帮助

连接默认值：PGHOST=127.0.0.1 PGPORT=55432 PGDATABASE=yxs PGUSER=yxs（密码无默认）。
`

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"'
}

function parseArgs(argv) {
  const opts = {
    source: null,
    pgUrl: null,
    dryRun: false,
    rebuild: false,
    allowOutside: false,
    forceTarget: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const { name, inline } = splitToken(argv[i])
    switch (name) {
      case '--source':
      case '--sqlite': {
        const v = takeValue(argv, i, inline)
        if (v.value === null) exitUsage(`${name} 缺少取值：SQLite 源库路径。`)
        opts.source = v.value
        i = v.next
        break
      }
      case '--pg-url': {
        const v = takeValue(argv, i, inline)
        if (v.value === null) exitUsage('--pg-url 缺少取值：PG 连接串。')
        opts.pgUrl = v.value
        i = v.next
        break
      }
      case '--dry-run':
        opts.dryRun = true
        break
      case '--rebuild':
        opts.rebuild = true
        break
      case '--allow-source-outside-scratch':
        opts.allowOutside = true
        break
      case '--force-target':
        opts.forceTarget = true
        break
      case '-h':
      case '--help':
        opts.help = true
        break
      default:
        unknownArg('migrate.js', argv[i])
    }
  }
  return opts
}

function reasonOf(err) {
  const msg = err && err.message ? String(err.message) : String(err)
  return msg.split('\n')[0].trim()
}

function pkLabel(table, row) {
  if (table.pk.length === 1) return String(row[table.pk[0]])
  return table.pk.map((c) => `${c}=${row[c]}`).join(',')
}

function csvField(v) {
  if (v === null || v === undefined) return ''
  return '"' + String(v).replace(/"/g, '""') + '"'
}

function buildCsv(table, rows) {
  const header = table.columns.map((c) => c.name).join(',')
  const body = rows.map((r) => r.map(csvField).join(',')).join('\n')
  return header + '\n' + body + '\n'
}

// §3.1 漂移核对：注册表与 packages/db/src/index.ts 逐项 diff；任一非空退出 2，不进入 DDL/装载。
// 源码路径按本文件所在目录推导，不依赖当前工作目录。
function checkSourceDrift() {
  let srcText
  try {
    srcText = fs.readFileSync(SOURCE_INDEX, 'utf8')
  } catch (err) {
    console.error(`无法读取源码结构核对文件：${reasonOf(err)}。`)
    process.exit(2)
  }
  const diff = diffAgainstSource(srcText)
  if (!isDriftFree(diff)) {
    console.error(`注册表与源码结构漂移（${describeDrift(diff).join('；')}）。`)
    process.exit(2)
  }
}

function printRss() {
  const rssMiB = (process.memoryUsage().rss / 1024 / 1024).toFixed(1)
  console.log(`[migrate] rss: ${rssMiB} MiB`)
}

// COPY … FROM STDIN：pg 8.23.1 的 client.query 接受带 submit 函数的查询对象；
// 在 handleCopyInResponse 里 sendCopyFromChunk / endCopyFrom，handleReadyForQuery 回调一次结束。
function copyFrom(client, sql, csvText) {
  return new Promise((resolve, reject) => {
    const q = {
      text: sql,
      callback: (err) => (err ? reject(err) : resolve()),
      submit(connection) {
        connection.query(sql)
      },
      handleCopyInResponse(connection) {
        connection.sendCopyFromChunk(Buffer.from(csvText, 'utf8'))
        connection.endCopyFrom()
      },
      handleCopyData() {},
      handleCommandComplete() {},
      handleReadyForQuery() {
        this.callback(null)
      },
      handleError(err) {
        this.callback(err)
      },
      handleRowDescription() {},
      handleDataRow() {},
      handleEmptyQuery() {},
      handlePortalSuspended() {},
    }
    client.query(q)
  })
}

function stageName(table) {
  return `_stage_${table.name}`
}

function stageDdl(table) {
  const cols = table.columns
    .map((c) => `${quoteIdent(c.name)} ${c.pg}`)
    .join(', ')
  return `CREATE TEMP TABLE ${quoteIdent(stageName(table))} (${cols}) ON COMMIT DROP`
}

function copySql(table) {
  const colList = table.columns.map((c) => quoteIdent(c.name)).join(', ')
  return `COPY ${quoteIdent(stageName(table))} (${colList}) FROM STDIN WITH (FORMAT csv, HEADER true)`
}

function insertSql(table) {
  const colList = table.columns.map((c) => quoteIdent(c.name)).join(', ')
  const conflictCols = table.pk.map(quoteIdent).join(', ')
  const nonPk = table.columns.filter((c) => !table.pk.includes(c.name))
  let conflict
  if (nonPk.length === 0) {
    conflict = `ON CONFLICT (${conflictCols}) DO NOTHING`
  } else {
    const set = nonPk
      .map((c) => `${quoteIdent(c.name)} = EXCLUDED.${quoteIdent(c.name)}`)
      .join(', ')
    conflict = `ON CONFLICT (${conflictCols}) DO UPDATE SET ${set}`
  }
  return `INSERT INTO ${table.name} (${colList}) SELECT ${colList} FROM ${quoteIdent(stageName(table))} ${conflict}`
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  if (opts.help) {
    process.stdout.write(USAGE)
    process.exit(0)
  }

  // t0：参数与源路径校验（退出 1）。
  if (!opts.source) {
    exitUsage('缺少必填参数 --source：SQLite 源库路径。')
  }
  const absSource = path.resolve(process.cwd(), opts.source)
  if (!fs.existsSync(absSource) || !fs.statSync(absSource).isFile()) {
    exitUsage(`找不到源数据库文件：${opts.source}。`)
  }
  if (!opts.allowOutside) {
    const rel = path.relative(SCRATCH_ROOT, absSource)
    const under = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
    if (!under) {
      exitUsage(`源路径位于受保护的真实数据目录，请改用 .scratch/run/D/ 下的副本：${opts.source}。`)
    }
  }

  // 目标库身份守卫：缺省路径按主键 upsert 会覆盖同名表的数据，--rebuild 还会 DROP 38 张表。
  // 两者都是写操作，必须在连库之前拦住指错库的情形；--dry-run 只打印计划，不写库。
  const writes = !opts.dryRun
  const targetId = targetIdentity(opts.pgUrl)
  if (writes) {
    guardWriteTarget(targetId, opts.forceTarget)
  } else {
    warnNonProvisionalTarget(targetId)
  }

  // t1：只读打开 SQLite；版本非 7 退出 2。
  let db
  try {
    db = new DatabaseSync(absSource, { readOnly: true })
  } catch (err) {
    console.error(`无法打开源数据库 ${opts.source}：${reasonOf(err)}。`)
    process.exit(2)
  }
  const versionRow = db.prepare('PRAGMA user_version').get()
  const version = versionRow ? versionRow.user_version : null
  if (version !== 7) {
    console.error(`源库 schema 版本为 ${version}，预期 7；请先在桌面端或 seed 流程跑齐本地迁移。`)
    process.exit(2)
  }

  // t2：逐表核对源库缺表（退出 2）。
  const existing = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
  )
  for (const name of TABLE_NAMES) {
    if (!existing.has(name)) {
      console.error(`源数据库缺少表 ${name}。`)
      process.exit(2)
    }
  }

  // §3.1：注册表与源码逐项漂移核对；不通过则退出 2，不进入 DDL/装载。
  checkSourceDrift()

  // 每表预计/实际行数（dry-run 与正式装载共用）。
  const rowCounts = new Map()
  let totalRows = 0
  for (const name of CREATE_ORDER) {
    const n = db.prepare(`SELECT count(*) AS n FROM ${quoteIdent(name)}`).get().n
    rowCounts.set(name, n)
    totalRows += n
  }

  console.log(`[migrate] source: ${opts.source} (schema version 7, ${TABLE_NAMES.length} tables)`)
  console.log(`[migrate] target: ${describeTarget(opts.pgUrl)}`)

  // t3：连接 PG；连接失败退出 2。
  const { default: pg } = await loadPg()
  const client = new pg.Client(buildPgConfig(opts.pgUrl))
  try {
    await client.connect()
  } catch (err) {
    console.error(`无法连接 PostgreSQL：${reasonOf(err)}。请检查 PGHOST、PGPORT、PGUSER、PGPASSWORD。`)
    process.exit(2)
  }

  // 连上之后复核真实库名：配置里的库名可能被 PGSERVICE/PGOPTIONS 改写。
  if (writes) {
    try {
      await assertConnectedTarget(client, targetId, opts.forceTarget)
    } catch (err) {
      await client.end().catch(() => {})
      throw err
    }
  }

  // --dry-run：只打印 schema 计划与每表预计行数，不建表、不写库、不发起写事务。
  if (opts.dryRun) {
    const indexCount = TABLES.reduce(
      (s, t) => s + t.indexes.length + t.uniques.filter((u) => !u.constraint).length,
      0,
    )
    console.log(`[migrate] schema: plan (${TABLE_NAMES.length} tables, ${indexCount} indexes)`)
    for (const name of CREATE_ORDER) {
      console.log(`[migrate] plan ${name} ${rowCounts.get(name)}`)
    }
    console.log(`[migrate] done: ${TABLE_NAMES.length} tables, ${totalRows} rows (dry-run)`)
    printRss()
    await client.end().catch(() => {})
    process.exit(0)
  }

  // t4：建 schema：全部 DDL 在一个事务内提交；--rebuild 先逆序 DROP 登记表。
  try {
    await client.query('BEGIN')
    if (opts.rebuild) {
      for (const name of DROP_ORDER) {
        await client.query(`DROP TABLE IF EXISTS ${quoteIdent(name)}`)
      }
    }
    for (const ddl of buildDdl()) {
      await client.query(ddl)
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    await client.end().catch(() => {})
    console.error(`创建 schema 失败：${reasonOf(err)}。`)
    process.exit(2)
  }
  console.log('[migrate] schema: ok')

  // t5：按拓扑序逐表装载；每表一个事务。行用 StatementSync.iterate() 流式读取，
  // 每 COPY_BATCH_ROWS 行拼一批 CSV 走真实 COPY 通道，不全表驻留内存。
  let loadedRows = 0
  for (const name of CREATE_ORDER) {
    const table = TABLE_BY_NAME[name]
    const count = rowCounts.get(name)
    if (count > 0) {
      const colList = table.columns.map((c) => quoteIdent(c.name)).join(', ')
      const stmt = db.prepare(`SELECT ${colList} FROM ${quoteIdent(name)}`)
      let buffer = []
      let started = false
      const flush = async () => {
        if (buffer.length === 0) return
        if (!started) {
          await client.query('BEGIN')
          await client.query(stageDdl(table))
          started = true
        }
        await copyFrom(client, copySql(table), buildCsv(table, buffer))
        buffer = []
      }
      try {
        for (const row of stmt.iterate()) {
          const pk = pkLabel(table, row)
          buffer.push(table.columns.map((c) => valueForCopy(table, c, row[c.name], pk)))
          if (buffer.length >= COPY_BATCH_ROWS) await flush()
        }
        await flush()
        if (started) {
          await client.query(insertSql(table))
          await client.query('COMMIT')
        }
      } catch (err) {
        if (started) await client.query('ROLLBACK').catch(() => {})
        await client.end().catch(() => {})
        if (err.localized) {
          console.error(err.message)
        } else {
          console.error(`装载表 ${name} 失败：${reasonOf(err)}。`)
        }
        process.exit(2)
      }
    }
    loadedRows += count
    console.log(`[migrate] copy ${name} ${count}`)
  }

  console.log(`[migrate] done: ${TABLE_NAMES.length} tables, ${loadedRows} rows`)
  printRss()
  await client.end().catch(() => {})
  process.exit(0)
}

main().catch((err) => {
  // Fatal 已带中文消息与退出码；再套一层前缀会出现「装载失败：…。。」这种重复标点。
  if (err instanceof Fatal) {
    console.error(err.message)
    process.exit(err.code)
  }
  console.error(`装载失败：${reasonOf(err)}。`)
  process.exit(2)
})
