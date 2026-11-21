import { readFile } from 'node:fs/promises'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

export interface PdfResult {
  text: string
  warnings: string[]
}

export async function parsePdf(path: string): Promise<PdfResult> {
  const data = new Uint8Array(await readFile(path))
  const loadingTask = getDocument({
    data,
    useSystemFonts: true,
    disableFontFace: true,
  })
  const document = await loadingTask.promise
  const warnings: string[] = []
  const pages: string[] = []

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      const parts: string[] = []
      for (const item of content.items) {
        if ('str' in item && typeof item.str === 'string') {
          parts.push(item.str)
          if ('hasEOL' in item && item.hasEOL) parts.push('\n')
          else parts.push(' ')
        }
      }
      const pageText = cleanPdfText(parts.join(''))
      if (pageText) pages.push(pageText)
    }
  } finally {
    await document.destroy()
  }

  const text = pages.join('\n\n').trim()
  if (!text) {
    warnings.push('PDF contains no extractable text (image-only); framework_text left empty')
  }
  return { text, warnings }
}

function cleanPdfText(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1')
    .replace(/([\u4e00-\u9fff])\s+(?=[，。；：、！？（）《》“”‘’])/g, '$1')
    .replace(/([，。；：、！？（）《》“”‘’])\s+(?=[\u4e00-\u9fff])/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}
