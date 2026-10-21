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
const WINWORD_PATH = 'C:/Program Files/Microsoft Office/root/Office16/WINWORD.EXE'

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
  try {
    await access(WINWORD_PATH)
  } catch {
    throw new UnparsedDocumentError(path, `Word COM unavailable; WINWORD.EXE not found at ${WINWORD_PATH}`)
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
