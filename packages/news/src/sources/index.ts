import { brandstar } from './brandstar.js'
import { linkshop } from './linkshop.js'
import { socialbeta } from './socialbeta.js'
import { wscn } from './wscn.js'
import type { NewsSource } from './types.js'

export const NEWS_SOURCES: readonly NewsSource[] = [socialbeta, linkshop, brandstar, wscn]

export type { NewsSource, RawArticle, RawListItem } from './types.js'
