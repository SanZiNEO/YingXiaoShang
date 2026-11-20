import { execFile } from 'node:child_process'
import { access, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import WordExtractor from 'word-extractor'
import { parseDocx } from './docx.ts'
import { cleanText, sha1Short } from './text.ts'
import type { DocBlock, ParsedDocument } from './types.ts'
import { UnparsedDocumentError } from './types.ts'

const execFileAsync = promisify(execFile)

/**
 * Word 的安装路径随版本与安装方式变化，不能写死。按优先级探测：
 * 1. 环境变量 `WINWORD_PATH`（显式指定）；
 * 2. 常见安装位置（Office 16/15、Program Files 与 Program Files (x86)）；
 * 3. PATH 里的 `WINWORD.EXE`。
 * 全部失败才报「Word COM unavailable」，消息里列出尝试过的位置。
 */
async function findWinword(): Promise<string | undefined> {
  const candidates: string[] = []
  const explicit = process.env.WINWORD_PATH?.trim()
  if (explicit) candidates.push(explicit)
  for (const base of ['C:/Program Files/Microsoft Office/root/Office16', 'C:/Program Files/Microsoft Office/Office16',
    'C:/Program Files (x86)/Microsoft Office/root/Office16', 'C:/Program Files (x86)/Microsoft Office/Office16',
    'C:/Program Files/Microsoft Office/root/Office15', 'C:/Program Files (x86)/Microsoft Office/Office15']) {
    candidates.push(`${base}/WINWORD.EXE`)
  }
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // 该候选不存在，继续下一个。
    }
  }
  try {
    const { stdout } = await execFileAsync('where', ['WINWORD.EXE'], { windowsHide: true })
    const first = stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0)
    if (first) return first
  } catch {
    // where 找不到就当作没装。
  }
  return undefined
}

export async function parseDoc(path: string): Promise<ParsedDocument> {
  const warnings: string[] = []
  let body = ''

  try {
    const document = await new WordExtractor().extract(path)
    body = document.getBody()
  } catch (error) {
    warnings.push(
      `word-extractor failed (${error instanceof Error ? error.message : String(error)}); trying Word COM`,
    )
  }

  if (!body.trim()) {
    const convertedPath = await convertDocWithWord(path)
    try {
      const converted = await parseDocx(convertedPath)
      return {
        ...converted,
        path,
        format: 'doc',
        warnings: [
          ...warnings,
          ...converted.warnings,
          `converted with Word COM: ${convertedPath}`,
        ],
        convertedPath,
      }
    } catch (error) {
      throw new UnparsedDocumentError(path, 'Word COM conversion produced an unreadable document', {
        cause: error,
      })
    }
  }

  return {
    path,
    format: 'doc',
    blocks: textToBlocks(body),
    warnings,
  }
}

function textToBlocks(body: string): DocBlock[] {
  const blocks: DocBlock[] = []
  let previousWasBlank = true
  for (const rawLine of body.replace(/\f/g, '\n').split(/\r?\n/)) {
    const line = rawLine.replace(/\u00a0/g, ' ').replace(/\r/g, '').trim()
    if (!line) {
      previousWasBlank = true
      continue
    }
    if (line.includes('\t')) {
      const cells = line.split('\t').map((cell) => cleanText(cell))
      if (cells.filter((cell) => cell.length > 0).length >= 3) {
        blocks.push({ kind: 'table_row', text: cells.join(' | '), cells, blankBefore: previousWasBlank })
        previousWasBlank = false
        continue
      }
    }
    blocks.push({
      kind: 'paragraph',
      text: cleanText(line.replace(/\t/g, ' ')),
      bold: false,
      blankBefore: previousWasBlank,
    })
    previousWasBlank = false
  }
  return blocks
}

async function convertDocWithWord(path: string): Promise<string> {
  const winword = await findWinword()
  if (!winword) {
    throw new UnparsedDocumentError(
      path,
      'Word COM unavailable; WINWORD.EXE 未找到。设置 WINWORD_PATH 环境变量指向 winword.exe，或把 Office 装到默认位置。',
    )
  }

  const outDir = join(tmpdir(), 'learning-agent-doc-convert')
  await mkdir(outDir, { recursive: true })
  const outPath = join(outDir, `${sha1Short(path, 16)}.docx`)

  const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$word = New-Object -ComObject Word.Application',
    '$word.Visible = $false',
    '$word.DisplayAlerts = 0',
    'try {',
    `  $doc = $word.Documents.Open(${psQuote(path)}, $false, $true)`,
    `  $doc.SaveAs2(${psQuote(outPath)}, 16)`,
    '  $doc.Close($false)',
    '} finally {',
    '  $word.Quit()',
    '}',
  ].join('\n')

  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 120_000,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    })
    const info = await stat(outPath)
    if (!info.isFile() || info.size === 0) {
      throw new Error(`converted file is empty: ${outPath}`)
    }
    return outPath
  } catch (error) {
    throw new UnparsedDocumentError(path, 'Word COM conversion failed', { cause: error })
  }
}
