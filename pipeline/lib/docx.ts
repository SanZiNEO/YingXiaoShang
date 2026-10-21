import { load } from 'cheerio'
import mammoth from 'mammoth'
import { cleanText, oneLine } from './text.ts'
import type { DocBlock, ParsedDocument } from './types.ts'

export async function parseDocx(path: string): Promise<ParsedDocument> {
  const result = await mammoth.convertToHtml({ path })
  const warnings = result.messages
    .filter((message) => message.type === 'warning' || message.type === 'error')
    .map((message) => `mammoth: ${message.message}`)
  return {
    path,
    format: 'docx',
    blocks: htmlToBlocks(result.value),
    warnings,
  }
}

function htmlToBlocks(html: string): DocBlock[] {
  const $ = load(html)
  const blocks: DocBlock[] = []

  $('body')
    .find('p, li, table')
    .toArray()
    .forEach((element) => {
      const tag = element.tagName
      if (tag === 'table') {
        const rows = $(element)
          .find('tr')
          .toArray()
          .map((row) =>
            $(row)
              .find('td, th')
              .toArray()
              .map((cell) => oneLine($(cell).text())),
          )
          .filter((row) => row.some((cell) => cell.length > 0))
        if (rows.length > 0) {
          blocks.push({
            kind: 'table',
            text: rows.map((row) => row.join(' | ')).join('\n'),
            rows,
          })
        }
        return
      }

      if ($(element).parents('table').length > 0) return
      if (tag === 'p' && $(element).parents('li').length > 0) return

      const text = cleanText(
        tag === 'li'
          ? $(element).clone().find('ol, ul, table').remove().end().text()
          : $(element).text(),
      )
      if (!text) return
      blocks.push({
        kind: tag === 'li' ? 'list_item' : 'paragraph',
        text,
        bold: $(element).find('strong, b').length > 0,
        blankBefore: true,
      })
    })

  if (blocks.length === 0) {
    const text = cleanText($.root().text())
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed) blocks.push({ kind: 'paragraph', text: trimmed, bold: false })
    }
  }

  return blocks
}
