declare module 'word-extractor' {
  export interface WordDocument {
    getBody(): string
    getFootnotes(): string
    getHeaders(): string
    getTextboxes(): string
  }

  export default class WordExtractor {
    extract(path: string): Promise<WordDocument>
  }
}
