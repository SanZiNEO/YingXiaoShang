import type { CSSProperties, ReactNode } from 'react'
import { COLORS } from './ui'

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g
  const parts = text.split(pattern)
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={key}>{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={key} style={{ background: '#f3f4f6', borderRadius: 4, padding: '1px 4px', fontSize: '0.92em' }}>
          {part.slice(1, -1)}
        </code>
      )
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
    if (link) {
      return (
        <a key={key} href={link[2]} target="_blank" rel="noreferrer" style={{ color: COLORS.accent }}>
          {link[1]}
        </a>
      )
    }
    return <span key={key}>{part}</span>
  })
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
}

export function MarkdownView({ text, compact = false }: { text: string; compact?: boolean }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let index = 0
  const baseStyle: CSSProperties = {
    fontSize: compact ? 12 : 13,
    lineHeight: 1.8,
    color: COLORS.text,
    overflowWrap: 'anywhere',
  }

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim().length === 0) {
      index += 1
      continue
    }
    if (line.trim().startsWith('```')) {
      const code: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith('```')) {
        code.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      blocks.push(
        <pre key={`code-${index}`} style={{ background: '#f6f8fa', border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 10, overflow: 'auto', fontSize: 12 }}>
          {code.join('\n')}
        </pre>,
      )
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1]!.length
      const size = level === 1 ? 20 : level === 2 ? 16 : 14
      blocks.push(
        <div key={`h-${index}`} style={{ fontSize: size, fontWeight: 700, margin: index === 0 ? '0 0 8px' : '16px 0 6px' }}>
          {renderInline(heading[2]!, `h-${index}`)}
        </div>,
      )
      index += 1
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = []
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? '')) {
        quote.push((lines[index] ?? '').replace(/^\s*>\s?/, ''))
        index += 1
      }
      blocks.push(
        <blockquote key={`q-${index}`} style={{ margin: '8px 0', padding: '6px 12px', borderLeft: `3px solid ${COLORS.accent}`, color: COLORS.muted, background: '#fafafa' }}>
          {renderInline(quote.join(' '), `q-${index}`)}
        </blockquote>,
      )
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = []
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index] ?? '')) {
        const cells = tableCells(lines[index] ?? '')
        if (!cells.every((cell) => /^:?-{2,}:?$/.test(cell))) rows.push(cells)
        index += 1
      }
      if (rows.length > 0) {
        const [header, ...body] = rows
        blocks.push(
          <div key={`table-${index}`} style={{ overflowX: 'auto', margin: '8px 0' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
              <thead>
                <tr>
                  {(header ?? []).map((cell, cellIndex) => (
                    <th key={cellIndex} style={{ border: `1px solid ${COLORS.border}`, padding: '6px 8px', background: '#f9fafb', textAlign: 'left' }}>
                      {renderInline(cell, `th-${cellIndex}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex} style={{ border: `1px solid ${COLORS.border}`, padding: '6px 8px' }}>
                        {renderInline(cell, `td-${rowIndex}-${cellIndex}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        )
      }
      continue
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^\s*[-*+]\s+/, ''))
        index += 1
      }
      blocks.push(
        <ul key={`ul-${index}`} style={{ margin: '6px 0', paddingLeft: 20 }}>
          {items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item, `li-${index}-${itemIndex}`)}</li>)}
        </ul>,
      )
      continue
    }
    if (/^\s*\d+[.、]\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*\d+[.、]\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^\s*\d+[.、]\s+/, ''))
        index += 1
      }
      blocks.push(
        <ol key={`ol-${index}`} style={{ margin: '6px 0', paddingLeft: 20 }}>
          {items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item, `oli-${index}-${itemIndex}`)}</li>)}
        </ol>,
      )
      continue
    }
    if (/^\s*---+\s*$/.test(line)) {
      blocks.push(<hr key={`hr-${index}`} style={{ border: 'none', borderTop: `1px solid ${COLORS.border}`, margin: '12px 0' }} />)
      index += 1
      continue
    }
    const paragraph: string[] = [line.trim()]
    index += 1
    while (index < lines.length) {
      const next = lines[index] ?? ''
      if (next.trim().length === 0
        || /^(#{1,4})\s+/.test(next)
        || /^\s*[-*+]\s+/.test(next)
        || /^\s*\d+[.、]\s+/.test(next)
        || /^\s*\|.*\|\s*$/.test(next)
        || /^\s*>\s?/.test(next)
        || next.trim().startsWith('```')) break
      paragraph.push(next.trim())
      index += 1
    }
    blocks.push(
      <p key={`p-${index}`} style={{ margin: '6px 0' }}>
        {renderInline(paragraph.join(' '), `p-${index}`)}
      </p>,
    )
  }

  return <div style={baseStyle}>{blocks}</div>
}
