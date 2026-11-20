/**
 * mutation apply / revert 机制 —— 3 条临时变异规格的只读检查、回放与还原。
 *
 * 边界（01-scope §7、04-acceptance §5）：
 * - 被测文件（apps/server/**、docs/contracts/**）只在回放窗口内被「原字节备份 → 写入变异内容」，
 *   窗口结束前必须还原；还原后逐字节复核，并复查 `git status --porcelain <file>` 为空。
 * - 不使用 git checkout / stash / reset 还原；不删除 report 目录之外的任何文件。
 * - 规格是声明式的（mutations/*.mjs），diff 在运行时按行比对生成并落盘；
 *   本文件不硬编码任何「已杀死 / survived」结论，也不预置不存在的 .patch 文件。
 *
 * 被 run.mjs import 时只导出函数与 MUTATIONS 表，不执行 CLI 副作用；
 * 直接 `node src/patch.mjs --inspect|--run` 时才走进程参数分支。
 */

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import m1 from '../mutations/m1-drop-done.mjs'
import m2 from '../mutations/m2-loosen-limit.mjs'
import m3 from '../mutations/m3-enum-29.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TOOL_ROOT = path.resolve(HERE, '..')
const REPO_ROOT = path.resolve(TOOL_ROOT, '..', '..')

/** id → 规格文件名，对应 mutations/ 目录下的声明式模块。 */
const PATCH_FILES = {
  M1: 'm1-drop-done.mjs',
  M2: 'm2-loosen-limit.mjs',
  M3: 'm3-enum-29.mjs',
}

/** 三条规格，按 id 排序。 */
export const MUTATIONS = [m1, m2, m3].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

const LOG_LIMIT = 4000
const CONTEXT_LINES = 3

const relPosix = (p) => p.replace(/\\/g, '/')

function clipLog(text) {
  if (text == null) return ''
  return text.length > LOG_LIMIT ? `${text.slice(0, LOG_LIMIT)}\n…（日志已截断）` : text
}

/** 统计 needle 在 text 中出现的次数（重叠计数）。 */
function countOccurrences(text, needle) {
  if (!needle) return 0
  let count = 0
  let cursor = 0
  while ((cursor = text.indexOf(needle, cursor)) !== -1) {
    count += 1
    cursor += needle.length
  }
  return count
}

/**
 * 在规格的 edits 上解析锚点：anchor 优先，其后按 anchorAlternatives 顺序尝试；
 * 只接受全文恰好命中 1 次的候选。返回 [{ edit, anchor }]；任一 edit 无唯一命中返回 null。
 */
function resolveAnchors(text, spec) {
  const resolved = []
  for (const edit of spec.edits) {
    const candidates = [edit.anchor, ...(edit.anchorAlternatives || [])]
    let hit = null
    for (const candidate of candidates) {
      if (countOccurrences(text, candidate) === 1) {
        hit = candidate
        break
      }
    }
    if (hit === null) return { resolved: null, candidates }
    resolved.push({ edit, anchor: hit })
  }
  return { resolved, candidates: [] }
}

/** 跑一条命令，cwd 固定在 tools/contract-tests；只回传退出码与截断后的 stdout/stderr。 */
function runCommand(command, cwd) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, { cwd, shell: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ exitCode: -1, stdout: '', stderr: `spawn 失败：${err.message}` })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', (err) => resolve({ exitCode: -1, stdout, stderr: `spawn 失败：${err.message}` }))
    child.on('close', (code) => resolve({ exitCode: code == null ? -1 : code, stdout, stderr }))
  })
}

/** LCS 表，用于按行生成 unified diff。 */
function lcsTable(a, b) {
  const n = a.length
  const m = b.length
  const table = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      table[i][j] = a[i - 1] === b[j - 1]
        ? table[i - 1][j - 1] + 1
        : Math.max(table[i - 1][j], table[i][j - 1])
    }
  }
  return table
}

/** 自己按行比对生成 unified diff 文本，不依赖 git diff 二进制。 */
function unifiedDiff(file, oldText, newText) {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const table = lcsTable(oldLines, newLines)

  const ops = []
  let i = oldLines.length
  let j = newLines.length
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ t: 'eq', line: oldLines[i - 1] })
      i -= 1
      j -= 1
    } else if (j > 0 && (i === 0 || table[i][j - 1] >= table[i - 1][j])) {
      ops.push({ t: 'add', line: newLines[j - 1] })
      j -= 1
    } else {
      ops.push({ t: 'del', line: oldLines[i - 1] })
      i -= 1
    }
  }
  ops.reverse()

  const inHunk = new Array(ops.length).fill(false)
  for (let k = 0; k < ops.length; k += 1) {
    if (ops[k].t === 'eq') continue
    const from = Math.max(0, k - CONTEXT_LINES)
    const to = Math.min(ops.length - 1, k + CONTEXT_LINES)
    for (let c = from; c <= to; c += 1) inHunk[c] = true
  }

  const out = [`--- a/${file}`, `+++ b/${file}`]
  let oldNo = 1
  let newNo = 1
  let segment = null

  const flush = () => {
    out.push(`@@ -${segment.oldStart},${segment.oldCount} +${segment.newStart},${segment.newCount} @@`)
    out.push(...segment.lines)
    segment = null
  }

  for (let k = 0; k < ops.length; k += 1) {
    const op = ops[k]
    if (!inHunk[k]) {
      if (op.t === 'eq') { oldNo += 1; newNo += 1 } else if (op.t === 'del') { oldNo += 1 } else { newNo += 1 }
      continue
    }
    if (segment === null) {
      segment = { oldStart: oldNo, newStart: newNo, oldCount: 0, newCount: 0, lines: [] }
    }
    if (op.t === 'eq') {
      segment.lines.push(` ${op.line}`)
      oldNo += 1
      newNo += 1
      segment.oldCount += 1
      segment.newCount += 1
    } else if (op.t === 'del') {
      segment.lines.push(`-${op.line}`)
      oldNo += 1
      segment.oldCount += 1
    } else {
      segment.lines.push(`+${op.line}`)
      newNo += 1
      segment.newCount += 1
    }
    if (k === ops.length - 1 || !inHunk[k + 1]) flush()
  }

  return `${out.join('\n')}\n`
}

async function pathExists(abs) {
  try {
    await fs.access(abs)
    return true
  } catch {
    return false
  }
}

function baseResult(spec, extra) {
  return {
    id: spec.id,
    patch: `mutations/${PATCH_FILES[spec.id]}`,
    targetFile: spec.file,
    targetCase: spec.targetCase,
    applied: false,
    reverted: true,
    gitStatus: '',
    ...extra,
  }
}

/** 单文件 git status --porcelain 原文（空串 = 干净）。路径spec 到单文件，不用宽目录；保留 XY 状态列前导空格。 */
async function gitPorcelain(repoRoot, relFile) {
  const rel = relPosix(relFile)
  const git = await runCommand(`git status --porcelain -- ${rel}`, repoRoot)
  return git.stdout
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line !== '')
    .join(' | ')
}

/**
 * 只读检查：准入条件两条同时成立才记 runnable ——
 * 1) 目标文件存在；2) 该文件的单文件 git 状态干净（`git status --porcelain -- <文件>` 为空）。
 * - 文件不存在 → not-run：A 轮未交付；
 * - 文件存在但状态非空（`??` 未跟踪 / ` M` 已修改 / `D` 删除等）→ not-run：其它轮次改动中，不允许 apply。
 */
export async function inspectAll({ repoRoot }) {
  const results = []
  for (const spec of MUTATIONS) {
    const abs = path.join(repoRoot, spec.file)
    if (!(await pathExists(abs))) {
      results.push(baseResult(spec, {
        status: 'not-run',
        reason: `目标文件不存在：${spec.file}（A 轮未交付）`,
        missingPaths: [spec.file],
        gitStatus: '',
      }))
      continue
    }
    const gitStatus = await gitPorcelain(repoRoot, spec.file)
    if (gitStatus !== '') {
      results.push(baseResult(spec, {
        status: 'not-run',
        reason: `目标文件被其它轮次改动中（git status: ${gitStatus}）`,
        missingPaths: [],
        gitStatus,
      }))
    } else {
      results.push(baseResult(spec, {
        status: 'runnable',
        reason: '',
        missingPaths: [],
        gitStatus,
      }))
    }
  }
  return results
}

/**
 * 还原后复查：原字节逐字节一致，且单文件 git status 与 apply 前快照一致。
 * 还原只靠 apply 前保存的原字节备份写回；不使用 git checkout / stash / reset。
 */
async function verifyRevert(repoRoot, abs, original, preStatus) {
  let back
  try {
    back = await fs.readFile(abs)
  } catch (err) {
    return { ok: false, reason: `还原后读回文件失败：${err.message}` }
  }
  if (!back.equals(original)) {
    return { ok: false, reason: '还原后文件字节与原字节不一致' }
  }
  const postStatus = await gitPorcelain(repoRoot, abs)
  if (postStatus !== preStatus) {
    return { ok: false, reason: `还原后 git 状态与 apply 前不一致：apply 前「${preStatus}」，还原后「${postStatus}」` }
  }
  return { ok: true, reason: '' }
}

/**
 * 回放单条 mutation：备份原字节 → 写入变异内容 → 落盘运行时 diff → 跑 targetCommand → 还原并复核。
 * 任一步失败不强行继续；finally 内保证已还原，还原不了记 revert-failed。
 */
async function runOne({ spec, repoRoot, reportDir }) {
  const abs = path.join(repoRoot, spec.file)
  let original = null
  let applied = false
  let preStatus = ''
  let result

  try {
    if (!(await pathExists(abs))) {
      return baseResult(spec, {
        status: 'not-run',
        reason: `目标文件不存在：${spec.file}（A 轮未交付）`,
        missingPaths: [spec.file],
        gitStatus: '',
      })
    }

    preStatus = await gitPorcelain(repoRoot, spec.file)
    if (preStatus !== '') {
      return baseResult(spec, {
        status: 'not-run',
        reason: `目标文件被其它轮次改动中（git status: ${preStatus}）`,
        missingPaths: [],
        gitStatus: preStatus,
      })
    }

    original = await fs.readFile(abs)
    const text = original.toString('utf8')
    const { resolved, candidates } = resolveAnchors(text, spec)
    if (resolved === null) {
      return baseResult(spec, {
        status: 'anchor-miss',
        reason: `锚点定位失败：${spec.file} 中未找到唯一匹配的候选片段（候选：${candidates.join(' | ')}）`,
        missingPaths: [],
      })
    }

    let mutated = text
    for (const { edit, anchor } of resolved) {
      mutated = mutated.replace(anchor, edit.replace)
    }

    await fs.writeFile(abs, mutated, 'utf8')
    applied = true

    await fs.mkdir(path.join(reportDir, 'mutations'), { recursive: true })
    const diffPath = path.join(reportDir, 'mutations', `${spec.id}.diff`)
    await fs.writeFile(diffPath, unifiedDiff(spec.file, text, mutated), 'utf8')

    const run = await runCommand(spec.targetCommand, TOOL_ROOT)

    let status
    let reason
    if (run.exitCode === 1) {
      status = 'killed'
      reason = `目标用例变红（命令退出码 1）：${spec.targetCase}`
    } else if (run.exitCode === 0) {
      status = 'survived'
      reason = `目标用例仍为绿色（命令退出码 0），mutation 未被 ${spec.targetCase} 捕获`
    } else {
      status = 'survived'
      reason = `目标命令退出码 ${run.exitCode}（非断言失败口径），未形成变红证据，按 survived 保守记录；stderr 摘要：${clipLog(run.stderr)}`
    }

    result = baseResult(spec, {
      applied: true,
      reverted: true,
      status,
      reason,
      missingPaths: [],
      gitStatus: preStatus,
      targetCommand: spec.targetCommand,
      exitCode: run.exitCode,
      stdout: clipLog(run.stdout),
      stderr: clipLog(run.stderr),
      diffPath: relPosix(path.relative(repoRoot, diffPath)),
    })
  } catch (err) {
    result = baseResult(spec, {
      applied,
      reverted: true,
      status: 'revert-failed',
      reason: `执行异常：${err && err.message ? err.message : String(err)}`,
      missingPaths: [],
    })
  } finally {
    if (original && applied) {
      let revertReason = null
      try {
        await fs.writeFile(abs, original)
        const check = await verifyRevert(repoRoot, abs, original, preStatus)
        if (!check.ok) revertReason = check.reason
      } catch (err) {
        revertReason = `还原异常：${err.message}`
      }
      if (revertReason) {
        result = {
          ...result,
          applied: true,
          reverted: false,
          status: 'revert-failed',
          reason: revertReason,
        }
      }
    }
  }
  return result
}

/**
 * 回放全部（或 --only 选中的）mutation。
 * @param {string} repoRoot 仓库根绝对路径
 * @param {string} [reportDir] diff 落盘目录；默认 tools/contract-tests/report
 * @param {string[]|null} only 只回放指定 id 列表
 */
export async function runMutations({ repoRoot, reportDir, only = null }) {
  const wanted = only && only.length > 0 ? new Set(only) : null
  const reportAbs = reportDir ? path.resolve(reportDir) : path.join(TOOL_ROOT, 'report')
  const results = []
  for (const spec of MUTATIONS) {
    if (wanted && !wanted.has(spec.id)) continue
    results.push(await runOne({ spec, repoRoot, reportDir: reportAbs }))
  }
  return results
}

/**
 * run.mjs 汇总 report.json 用的只读快照：未跑过时 applied 如实为 false，status 记 not-run。
 * not-run 原因分两类并原样保留：文件不存在（A 轮未交付）/ 文件存在但状态不干净（其它轮次改动中）。
 */
export async function summarizeForReport({ repoRoot }) {
  const inspected = await inspectAll({ repoRoot })
  return inspected.map((x) => ({
    id: x.id,
    patch: x.patch,
    applied: false,
    reverted: true,
    targetCase: x.targetCase,
    status: x.status === 'runnable' ? 'not-run' : x.status,
    reason: x.status === 'runnable' ? '本轮尚未回放（未执行 apply）' : x.reason,
    gitStatus: x.gitStatus,
  }))
}

function parseCliArgs(argv) {
  const opts = { inspect: false, run: false, only: [], report: null }
  for (let k = 0; k < argv.length; k += 1) {
    const arg = argv[k]
    if (arg === '--inspect') opts.inspect = true
    else if (arg === '--run') opts.run = true
    else if (arg === '--only' || arg === '--case') opts.only.push(argv[(k += 1)])
    else if (arg === '--report') opts.report = argv[(k += 1)]
  }
  return opts
}

function printReport(results) {
  const count = (status) => results.filter((r) => r.status === status).length
  console.log(
    `# mutation 快照：${results.length} 条（not-run ${count('not-run')} / anchor-miss ${count('anchor-miss')} / killed ${count('killed')} / survived ${count('survived')} / revert-failed ${count('revert-failed')}）`,
  )
  console.log(JSON.stringify(results, null, 2))
}

async function main(argv) {
  const opts = parseCliArgs(argv)
  let results
  if (opts.inspect) {
    results = await inspectAll({ repoRoot: REPO_ROOT })
  } else if (opts.run) {
    results = await runMutations({ repoRoot: REPO_ROOT, reportDir: opts.report, only: opts.only })
  } else {
    console.error('用法：node src/patch.mjs --inspect | --run [--only M1] [--report <dir>]')
    process.exit(3)
    return
  }
  printReport(results)
  const failed = results.some((r) => r.status === 'survived' || r.status === 'revert-failed')
  process.exit(failed ? 1 : 0)
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  await main(process.argv.slice(2))
}
