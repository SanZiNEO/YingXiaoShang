/**
 * Contract implemented by every news source adapter.
 *
 * `list()` returns lightweight list entries; `fetchDetail()` turns one entry
 * into the raw fields the normalizer needs. Adapters never touch the database.
 */
export interface NewsSource {
  readonly id: string
  list(signal?: AbortSignal): Promise<RawListItem[]>
  fetchDetail(item: RawListItem, signal?: AbortSignal): Promise<RawArticle>
}

export interface RawListItem {
  /** Stable per-source identifier; the normalized id is `${source}-${sourceId}`. */
  sourceId: string
  url: string
  title?: string
  author?: string
  publishedAt?: string
  summary?: string
  /**
   * Optional already-known article payload. WSCN uses this as the fallback
   * when its detail API is unavailable.
   */
  fallback?: RawArticle
}

export interface RawArticle {
  sourceId: string
  url: string
  title: string
  author?: string
  publishedAt?: string
  summary?: string
  /** Plain text; the normalizer trims it and applies the 300-character floor. */
  content: string
  /** Original article HTML, kept only for optional debug dumps. */
  contentHtml?: string
}
