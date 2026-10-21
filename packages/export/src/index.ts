import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'

export interface DocBlock {
  heading?: string
  text?: string
  list?: string[]
  table?: { headers: string[]; rows: string[][] }
  pageBreak?: boolean
}

function paragraphsFor(block: DocBlock): Array<Paragraph | Table> {
  const output: Array<Paragraph | Table> = []
  if (block.heading) {
    output.push(new Paragraph({ text: block.heading, heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 } }))
  }
  if (block.text) {
    output.push(new Paragraph({ children: [new TextRun(block.text)], spacing: { after: 120 } }))
  }
  for (const item of block.list ?? []) {
    output.push(new Paragraph({ text: item, bullet: { level: 0 }, spacing: { after: 60 } }))
  }
  if (block.table) {
    output.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({
            children: block.table.headers.map(
              (header) =>
                new TableCell({
                  children: [new Paragraph({ children: [new TextRun({ text: header, bold: true })] })],
                }),
            ),
          }),
          ...block.table.rows.map(
            (row) =>
              new TableRow({
                children: row.map(
                  (cell) => new TableCell({ children: [new Paragraph({ text: cell })] }),
                ),
              }),
          ),
        ],
      }),
    )
  }
  if (block.pageBreak) output.push(new Paragraph({ pageBreakBefore: true }))
  return output
}

export async function writeDocx(path: string, title: string, blocks: DocBlock[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const document = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: title, heading: HeadingLevel.TITLE, spacing: { after: 240 } }),
          ...blocks.flatMap(paragraphsFor),
        ],
      },
    ],
  })
  await writeFile(path, await Packer.toBuffer(document))
}

export async function writeMarkdown(path: string, title: string, blocks: DocBlock[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const lines: string[] = [`# ${title}`, '']
  for (const block of blocks) {
    if (block.heading) lines.push(`## ${block.heading}`, '')
    if (block.text) lines.push(block.text, '')
    for (const item of block.list ?? []) lines.push(`- ${item}`)
    if (block.list && block.list.length > 0) lines.push('')
    if (block.table) {
      lines.push(`| ${block.table.headers.join(' | ')} |`)
      lines.push(`| ${block.table.headers.map(() => '---').join(' | ')} |`)
      for (const row of block.table.rows) lines.push(`| ${row.join(' | ')} |`)
      lines.push('')
    }
  }
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
}
