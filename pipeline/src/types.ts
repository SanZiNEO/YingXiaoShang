export interface DocBlock {
  kind: 'paragraph' | 'list_item' | 'table' | 'table_row'
  text: string
  bold?: boolean
  blankBefore?: boolean
  rows?: string[][]
  cells?: string[]
}

export interface ParsedDocument {
  path: string
  format: 'docx' | 'doc' | 'pdf'
  blocks: DocBlock[]
  warnings: string[]
  convertedPath?: string
}

export class UnparsedDocumentError extends Error {
  readonly path: string

  constructor(path: string, message: string, options?: { cause?: unknown }) {
    super(`${message}: ${path}`, options)
    this.name = 'UnparsedDocumentError'
    this.path = path
  }
}

export interface OfficialKpRow {
  id?: string
  number: number
  name: string
  page?: number
  pageLabel: string
  sectionNumber: number
}

export interface BodySection {
  order: number
  name: string
  definition: string
  paragraphs: string[]
  keywords: string[]
  sectionNumber?: number
  matchedOfficialId?: string
  matchedOfficialName?: string
}
