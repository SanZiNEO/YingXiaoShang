#!/usr/bin/env node
// @yxs/migrate-pg · verify.js
// 只读校验：行数 100% 比对 → 每表按主键升序确定性抽样 → 逐字段比对 →
// news_articles 正文哈希复算。不写 SQLite、不写 PostgreSQL。
//
// 退出码（02-contract §2.5）：
//   0 一致；1 用法/参数错误；2 连接/结构/数据合法性错误；3 校验不一致。
//
// 取值归一与 migrate.js 共用 values.js：两侧口径必须一致，否则同一份合法数据会出现
// 「migrate 成功、verify 以环境错误退出」的自相矛盾结论。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { loadPg } from './pg-driver.js'
import { TABLES, TABLE_BY_NAME, TABLE_NAMES } from './schema-map.js'
import {
  jsonbTextForCopy,
  timestampMillisForCompare,
  booleanForCopy,
  jsonTextEqual,
} from './values.js'
import { Fatal, exitUsage, exitEnv, splitToken, takeValue, unknownArg } from './cli.js'
import { buildPgConfig, describeTarget, targetIdentity, warnNonProvisionalTarget } from './target.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// src/ 到仓库根是三级；按本文件位置推导，不依赖当前工作目录。
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const SCRATCH_DIR = path.join(REPO_ROOT, '.scratch', 'run', 'D')

const SAMPLE_DEFAULT = 20
const SAMPLE_MIN = 1
const SAMPLE_MAX = 1000
const VALUE_TRUNCATE = 200

const USAGE = `用法：node tools/migrate-pg/src/verify.js --source <sqlite 路径> [选项]

  --source, --sqlite <path>   SQLite 源库副本路径（必填）
  --pg-url <url>              PG 连接串；给出后覆盖全部 PG* 环境变量
  --sample <n>                每表抽样行数，1..1000（默认 ${SAMPLE_DEFAULT}）
  --allow-source-outside-scratch
                              放行 .scratch/run/D/ 之外的源路径
  -h, --help                  打印本帮助

连接默认值：PGHOST=127.0.0.1 PGPORT=55432 PGDATABASE=yxs PGUSER=yxs（密码无默认）。
`

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    source: null,
    pgUrl: null,
    sampleRaw: undefined,
    sample: SAMPLE_DEFAULT,
    allowOutside: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const { name, inline } = splitToken(argv[i])
    switch (name) {
      case '--source':
      case '--sqlite': {
        const v = takeValue(argv, i, inline)
        if (v.value === null) exitUsage(`${name} 缺少取值：SQLite 源库路径。`)
        args.source = v.value
        i = v.next
        break
      }
      case '--pg-url': {
        const v = takeValue(argv, i, inline)
        if (v.value === null) exitUsage('--pg-url 缺少取值：PG 连接串。')
        args.pgUrl = v.value
        i = v.next
        break
      }
      case '--sample': {
        const v = takeValue(argv, i, inline)
        if (v.value === null) exitUsage('--sample 缺少取值：1 到 1000 的整数。')
        args.sampleRaw = v.value
        i = v.next
        break
      }
      case '--allow-source-outside-scratch':
        args.allowOutside = true
        break
      case '-h':
      case '--help':
        args.help = true
        break
      default:
        unknownArg('verify.js', argv[i])
    }
  }
  return args
}

function isUnder(child, parent) {
  const rel = path.relative(parent, child)
  if (rel === '') return true
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false
  return true
}

// ---------------------------------------------------------------------------
// 取值格式化
// ---------------------------------------------------------------------------

// DIFF / HASH 行必须单行：取值里的换行与制表符若不转义，target= 会落到下一行，
// 让「第一处差异」这条证据失去可解析性。
function escapeOneLine(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
}

function fmtValue(value) {
  if (value === null || value === undefined) return 'NULL'
  let text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  text = escapeOneLine(text)
  if (text.length > VALUE_TRUNCATE) {
    text = text.slice(0, VALUE_TRUNCATE)
    // 截断点若落在转义序列中间（末尾留下奇数个反斜杠），去掉那个反斜杠，
    // 避免证据行出现半个转义让读者误判原值。
    let backslashes = 0
    for (let i = text.length - 1; i >= 0 && text[i] === '\\'; i--) backslashes += 1
    if (backslashes % 2 === 1) text = text.slice(0, -1)
    text += '…'
  }
  return text
}

export { fmtValue }

function pkKey(table, row) {
  return JSON.stringify(
    table.pk.map((col) => (row[col] === null || row[col] === undefined ? null : String(row[col]))),
  )
}

function pkLabel(table, row) {
  return table.pk.map((col) => `${col}=${fmtValue(row[col])}`).join(',')
}

function normalizeText(value) {
  return value === null || value === undefined ? null : String(value)
}

// ---------------------------------------------------------------------------
// 字段比对（返回 true 表示一致；非法取值直接退出 2）
// ---------------------------------------------------------------------------

function compareText(src, pg) {
  return normalizeText(src) === normalizeText(pg)
}

function compareBigint(src, pg) {
  if (src === null || src === undefined) return pg === null || pg === undefined
  if (pg === null || pg === undefined) return false
  try {
    return BigInt(String(src)) === BigInt(String(pg))
  } catch {
    return false
  }
}

function compareDouble(src, pg) {
  if (src === null || src === undefined) return pg === null || pg === undefined
  if (pg === null || pg === undefined) return false
  const a = Number(src)
  const b = Number(pg)
  if (Number.isNaN(a) || Number.isNaN(b)) return false
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))
}

// jsonb：源侧走与 migrate 完全相同的归一（空串 → 该列默认 JSON），目标侧是 PG 的
// `col::text`（jsonb 的规范文本）。比对用保留数字字面量的精确解析，不经 JS 浮点，
// 因此 19 位雪花 id 被改写时能真正报出来。
function compareJsonb(table, col, src, pg, srcRow) {
  const pk = pkLabel(table, srcRow)
  let a
  try {
    a = jsonbTextForCopy(table, col, src, pk)
  } catch (err) {
    exitEnv(err.message)
  }
  const b = pg === null || pg === undefined ? null : String(pg)
  if (a === null || b === null) return a === null && b === null
  try {
    return jsonTextEqual(a, b)
  } catch (err) {
    exitEnv(`表 ${table.name} 的列 ${col.name} 的 JSON 无法解析（主键 ${pk}）：${err.message}。`)
  }
}

function compareTimestamp(table, col, src, pg, srcRow) {
  const pk = pkLabel(table, srcRow)
  let a
  let b
  try {
    a = timestampMillisForCompare(table, col, src, pk)
    b = pg === null || pg === undefined ? null : timestampMillisForCompare(table, col, pg, pk)
  } catch (err) {
    exitEnv(err.message)
  }
  return a === b
}

function compareBoolean(table, col, src, pg, srcRow) {
  const pk = pkLabel(table, srcRow)
  let a
  try {
    a = src === null || src === undefined ? null : booleanForCopy(table, col, src, pk) === 'true'
  } catch (err) {
    exitEnv(err.message)
  }
  const b = pg === null || pg === undefined ? null : Boolean(pg)
  return a === b
}

function compareColumn(table, col, srcRow, pgRow) {
  const src = srcRow[col.name]
  const pg = pgRow[col.name]
  switch (col.pg) {
    case 'text':
      return compareText(src, pg)
    case 'bigint':
      return compareBigint(src, pg)
    case 'double precision':
      return compareDouble(src, pg)
    case 'jsonb':
      return compareJsonb(table, col, src, pg, srcRow)
    case 'timestamptz':
      return compareTimestamp(table, col, src, pg, srcRow)
    case 'boolean':
      return compareBoolean(table, col, src, pg, srcRow)
    default:
      return compareText(src, pg)
  }
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

function quoted(column) {
  return `"${column}"`
}

// jsonb 必须以文本取回：node-pg 会把 jsonb 解析成 JS 值，19 位整数在那一刻就变成双精度
// 浮点，比对再精确也查不出改写。`::text` 拿的是 PG 的规范输出，数字原样保留。
function selectList(table) {
  return table.columns
    .map((c) => (c.pg === 'jsonb' ? `${quoted(c.name)}::text AS ${quoted(c.name)}` : quoted(c.name)))
    .join(', ')
}

// 抽样必须两侧同序，否则「前 n 行」不是同一批行。SQLite 缺省 BINARY、PG 缺省随库
// collation（可能是 en_US.UTF-8），两侧显式钉到字节序才能保证同一集合。
function sourceRows(db, table, limit) {
  const order = table.pk.map((pkCol) => `${quoted(pkCol)} COLLATE BINARY`).join(', ')
  return db
    .prepare(`SELECT ${selectList(table)} FROM ${quoted(table.name)} ORDER BY ${order} LIMIT ${limit}`)
    .all()
}

async function pgRows(client, table, limit) {
  const order = table.pk.map((pkCol) => `${quoted(pkCol)} COLLATE "C"`).join(', ')
  const res = await client.query(
    `SELECT ${selectList(table)} FROM ${quoted(table.name)} ORDER BY ${order} LIMIT ${limit}`,
  )
  return res.rows
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    process.stdout.write(USAGE)
    return
  }

  // 源库路径校验（先于 --sample，避免 --source 缺值时被 sample 校验抢先报错）
  if (args.source === null || args.source === undefined || args.source === '') {
    exitUsage('缺少必填参数 --source：SQLite 源库路径。')
  }
  const absSource = path.resolve(process.cwd(), args.source)
  if (!fs.existsSync(absSource)) {
    exitUsage(`找不到源数据库文件：${args.source}。`)
  }
  if (!args.allowOutside && !isUnder(absSource, SCRATCH_DIR)) {
    exitUsage(`源路径位于受保护的真实数据目录，请改用 .scratch/run/D/ 下的副本：${args.source}。`)
  }

  // --sample 校验（1..1000 整数）
  if (args.sampleRaw !== undefined) {
    const raw = String(args.sampleRaw)
    const sampleValue = Number(raw)
    if (!/^\d+$/.test(raw) || !Number.isInteger(sampleValue) || sampleValue < SAMPLE_MIN || sampleValue > SAMPLE_MAX) {
      exitUsage('--sample 必须是 1 到 1000 的整数。')
    }
    args.sample = sampleValue
  }

  const targetId = targetIdentity(args.pgUrl)
  warnNonProvisionalTarget(targetId)
  console.log(`[verify] target: ${describeTarget(args.pgUrl)}`)

  let db = null
  let client = null

  try {
    db = new DatabaseSync(absSource, { readOnly: true })

    const versionRow = db.prepare('PRAGMA user_version').get()
    const version = versionRow ? Number(Object.values(versionRow)[0]) : 0
    if (version !== 7) {
      exitEnv(`源库 schema 版本为 ${version}，预期 7；请先在桌面端或 seed 流程跑齐本地迁移。`)
    }

    const srcTableRows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    const srcTables = new Set(srcTableRows.map((r) => r.name))
    for (const name of TABLE_NAMES) {
      if (!srcTables.has(name)) exitEnv(`源数据库缺少表 ${name}。`)
    }

    try {
      const { default: pg } = await loadPg()
      client = new pg.Client(buildPgConfig(args.pgUrl))
      await client.connect()
    } catch (err) {
      exitEnv(`无法连接 PostgreSQL：${err.message}。请检查 PGHOST、PGPORT、PGUSER、PGPASSWORD。`)
    }

    const pgTableRes = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    )
    const pgTables = new Set(pgTableRes.rows.map((r) => r.table_name))
    for (const name of TABLE_NAMES) {
      if (!pgTables.has(name)) exitEnv(`目标数据库缺少表 ${name}。`)
    }
    const extraTables = [...pgTables].filter((n) => !TABLE_BY_NAME[n])
    if (extraTables.length) {
      exitEnv(`目标数据库存在登记表之外的表：${extraTables.join(', ')}。`)
    }

    // t1 行数全量比对（汇总不中断）
    const srcCounts = new Map()
    let rowMismatch = null
    for (const name of TABLE_NAMES) {
      const srcN = Number(db.prepare(`SELECT count(*) AS n FROM ${quoted(name)}`).get().n)
      const pgN = Number((await client.query(`SELECT count(*) AS n FROM ${quoted(name)}`)).rows[0].n)
      srcCounts.set(name, srcN)
      console.log(`[verify] rows ${name} src=${srcN} pg=${pgN}`)
      if (srcN !== pgN && !rowMismatch) {
        rowMismatch = { name, srcN, pgN }
      }
    }
    if (rowMismatch) {
      console.error(`行数不一致：表 ${rowMismatch.name} 源 ${rowMismatch.srcN} 行，目标 ${rowMismatch.pgN} 行。`)
      process.exitCode = 3
      return
    }

    // t2 抽样：主键升序确定性取前 n 行；表内行数 ≤ 抽样数时全表比对
    for (const name of TABLE_NAMES) {
      const table = TABLE_BY_NAME[name]
      const total = srcCounts.get(name)
      const limit = Math.min(args.sample, total)
      console.log(`[verify] sample ${name} ${limit} rows`)
      if (limit === 0) continue

      const srcRows = sourceRows(db, table, limit)
      const pgRowList = await pgRows(client, table, limit)
      const srcMap = new Map(srcRows.map((row) => [pkKey(table, row), row]))
      const pgMap = new Map(pgRowList.map((row) => [pkKey(table, row), row]))

      // 主键集合差集：源有目标无
      for (const [key, srcRow] of srcMap) {
        if (!pgMap.has(key)) {
          const column = table.pk[0]
          console.log(
            `[verify] DIFF table=${name} pk=${pkLabel(table, srcRow)} column=${column} source=${fmtValue(srcRow[column])} target=NULL`,
          )
          process.exitCode = 3
          return
        }
      }
      // 主键集合差集：目标有源无
      for (const [key, pgRow] of pgMap) {
        if (!srcMap.has(key)) {
          const column = table.pk[0]
          console.log(
            `[verify] DIFF table=${name} pk=${pkLabel(table, pgRow)} column=${column} source=NULL target=${fmtValue(pgRow[column])}`,
          )
          process.exitCode = 3
          return
        }
      }

      for (const [key, srcRow] of srcMap) {
        const pgRow = pgMap.get(key)

        // 通用字段比对；news_articles.content_hash 走 HASH 分支，不参与通用列比对
        for (const col of table.columns) {
          if (name === 'news_articles' && col.name === 'content_hash') continue
          if (!compareColumn(table, col, srcRow, pgRow)) {
            console.log(
              `[verify] DIFF table=${name} pk=${pkLabel(table, srcRow)} column=${col.name} source=${fmtValue(srcRow[col.name])} target=${fmtValue(pgRow[col.name])}`,
            )
            process.exitCode = 3
            return
          }
        }

        // news_articles：先正文（已在上方 content 列比对），后哈希复算。
        // HASH 行必须带上 PG 侧存储的哈希：只报 source 与 recomputed 时，两者相同却判
        // 不一致的情形无法定位到底是哪一侧的值被改了。
        if (name === 'news_articles') {
          const srcHash = srcRow.content_hash === null || srcRow.content_hash === undefined
            ? null
            : String(srcRow.content_hash)
          const pgHash = pgRow.content_hash === null || pgRow.content_hash === undefined
            ? null
            : String(pgRow.content_hash)
          const pgContent = pgRow.content === null || pgRow.content === undefined ? null : String(pgRow.content)
          const recomputed = pgContent === null
            ? null
            : crypto.createHash('sha256').update(pgContent, 'utf8').digest('hex')
          if (srcHash !== pgHash || recomputed !== pgHash) {
            console.log(
              `[verify] HASH article=${srcRow.id} source=${srcHash === null ? 'NULL' : srcHash} target=${pgHash === null ? 'NULL' : pgHash} recomputed=${recomputed === null ? 'NULL' : recomputed}`,
            )
            process.exitCode = 3
            return
          }
        }
      }
    }

    console.log(`[verify] ok: ${TABLES.length} tables, rows match, sample and hash check passed`)
    process.exitCode = 0
    return
  } finally {
    if (client) await client.end().catch(() => {})
    if (db) db.close()
  }
}

// 只在作为 CLI 直接执行时跑主流程；被验收脚本 import 时不连库、不退出。
const IS_ENTRY =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (IS_ENTRY) {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err) => {
      if (err instanceof Fatal) {
        console.error(err.message)
        process.exit(err.code)
      }
      console.error(`校验失败：${err.message}。`)
      process.exit(2)
    })
}
