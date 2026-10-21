import type { Context } from '@deepseek-ai/cordis'
import type {
  ArtifactDraft,
  CaseMatch,
  EvidenceLevel,
  ReviewStatus,
  Citation,
  NewsAnalysisContent,
  NewsArticle,
  Question,
  QuestionSetContent,
  QuestionType,
  SubagentResult,
  TurnStep,
} from '@learning-agent/shared'
import type {} from '@learning-agent/db'
import type {} from '@learning-agent/news'
import type {} from '@learning-agent/questions'
import type {} from '@learning-agent/artifacts'
import type {} from '@learning-agent/matcher'
import { locateQuote, sentencesOf } from './case-library.js'
import { selectRelevantNews } from './news-select.js'
import { chapterTitle, extractCount, extractTypes } from './text.js'
import type { StepContext } from './subagents.js'

type TagRole = 'core' | 'example' | 'mention'

interface MatchCandidateLike {
  kpId: string
  kpName?: string
  tagRole: TagRole
  roleLabel?: string
  confidence: number
  evidenceSpan: string
  method: CaseMatch['method']
  reviewStatus: ReviewStatus
  evidenceLevel: EvidenceLevel
  rationale?: string
}

type AnalysisMatch = NewsAnalysisContent['matches'][number]

type AnalysisContent = Omit<NewsAnalysisContent, 'matches'> & {
  matches: AnalysisMatch[]
  warnings?: string[]
}

const REVIEWED_STATUSES: Record<string, true> = {
  reviewed: true,
  adjudicated: true,
  published: true,
}

const ROLE_LABELS: Record<string, string> = {
  core: '核心',
  example: '例证',
  mention: '提及',
}

interface AnalysisBundle {
  article: NewsArticle
  content: AnalysisContent
  artifact: ArtifactDraft
  citations: Citation[]
  matches: AnalysisMatch[]
  readyCandidates: MatchCandidateLike[]
}

function dedupeBy<T>(key: (item: T) => string, items: T[]): T[] {
  const seen = new Map<string, true>()
  const output: T[] = []
  for (const item of items) {
    const id = key(item)
    if (seen.has(id)) continue
    seen.set(id, true)
    output.push(item)
  }
  return output
}

function questionLine(question: Question, index: number): string {
  const options = question.options.length > 0
    ? `\n${question.options.map((option, optionIndex) => `   ${String.fromCharCode(65 + optionIndex)}. ${option}`).join('\n')}`
    : ''
  return `${index + 1}. [${question.type}] ${question.stem}${options}`
}

function analysisMarkdown(
  article: NewsArticle,
  matches: AnalysisMatch[],
  chapter: string,
  ideology: AnalysisContent['ideology'],
): string {
  const summary = article.summary || sentencesOf(article.content)[0] || ''
  return [
    `# 新闻分析 · ${article.title}`,
    '',
    `来源：${article.source}${article.published_at ? `｜${article.published_at.slice(0, 10)}` : ''}`,
    article.url ? `链接：${article.url}` : '',
    '',
    '## 新闻摘要',
    summary,
    '',
    matches.length > 0 ? `## ${chapter || '当前章节'}知识点候选` : '## 知识点候选',
    ...matches.map((match) => [
      `### ${match.name}`,
      `定义：${match.definition}`,
      `原文证据：${match.evidence}`,
      `匹配：${match.roleLabel ?? ROLE_LABELS[match.role] ?? '提及'} · ${match.candidate ? '自动候选（未人审）' : '已审核候选'}`,
    ].join('\n')),
    ...(matches.length === 0 ? ['没有检索到可追溯的知识点候选，本卡不强行匹配。'] : []),
    '',
    '## 课程思政',
    ...(ideology.length > 0
      ? ideology.map((item) => `- ${item.name}：${item.evidence}`)
      : ['本篇没有可追溯的思政匹配。']),
    '',
    '## 使用提示',
    matches.some((match) => match.candidate)
      ? '匹配结果是自动候选，只用于召回，不是教学结论；引用句已回原文核对。'
      : '匹配来自已审核候选；引用句已回原文核对。',
  ].filter((line) => line.length > 0).join('\n')
}

function recentArticle(ctx: Context, context: StepContext, lastArticleId: string): NewsArticle | undefined {
  if (lastArticleId) {
    const article = ctx.learningDb.getNews(lastArticleId)
    if (article) return article
  }
  const recentText = (context.recentMessages ?? []).map((item) => item.content).join('\n')
  if (recentText.length === 0) return undefined
  const articles = ctx.learningDb.listNews({ limit: 50 })
  return articles.find((article) => recentText.includes(article.title))
    ?? articles.find((article) => article.url.length > 0 && recentText.includes(article.url))
}

function storedCandidates(ctx: Context, article: NewsArticle, chapterId: string): MatchCandidateLike[] {
  return ctx.learningDb.getMatches(article.id)
    .filter((stored) => {
      if (!chapterId) return true
      return ctx.learningDb.getKp(stored.kp_id)?.chapter_id === chapterId
    })
    .map((stored) => {
      const kp = ctx.learningDb.getKp(stored.kp_id)
      return {
        kpId: stored.kp_id,
        kpName: kp?.name ?? stored.kp_id,
        tagRole: stored.tag_role,
        confidence: stored.confidence,
        evidenceSpan: stored.evidence_span,
        method: stored.method,
        rationale: stored.rationale,
        reviewStatus: stored.review_status ?? 'draft',
        evidenceLevel: stored.evidence_level ?? 'auto',
      }
    })
}

async function loadCandidates(
  ctx: Context,
  article: NewsArticle,
  warnings: string[],
  chapterId: string,
): Promise<MatchCandidateLike[]> {
  let raw: MatchCandidateLike[]
  try {
    raw = await ctx.matcher.candidates(article.id, { topK: 5, chapterId: chapterId || undefined })
    if (raw.length === 0) raw = storedCandidates(ctx, article, chapterId)
  } catch (error) {
    warnings.push(`匹配候选生成失败：${error instanceof Error ? error.message : String(error)}`)
    raw = storedCandidates(ctx, article, chapterId)
  }

  const seen = new Set<string>()
  const output: MatchCandidateLike[] = []
  for (const candidate of raw) {
    if (/mock/i.test(candidate.rationale ?? '')) {
      warnings.push('已丢弃 mock 匹配候选。')
      continue
    }
    if (candidate.reviewStatus === 'rejected') continue
    const located = locateQuote(article.content, candidate.evidenceSpan)
    if (!located) {
      warnings.push(`候选「${candidate.kpName ?? '知识点'}」的引用句无法在新闻原文定位，已丢弃。`)
      continue
    }
    const kp = ctx.learningDb.getKp(candidate.kpId)
    if (!kp) {
      warnings.push('有一个候选知识点已不存在，已丢弃。')
      continue
    }
    const key = `${candidate.kpId}:${located.quote}`
    if (seen.has(key)) continue
    seen.add(key)
    output.push({
      ...candidate,
      kpName: candidate.kpName ?? kp.name,
      evidenceSpan: located.quote,
      reviewStatus: candidate.reviewStatus ?? 'draft',
      evidenceLevel: candidate.evidenceLevel ?? 'auto',
    })
  }
  if (output.length === 0) {
    warnings.push('没有检索到可追溯的知识点候选；未用固定知识点强行匹配。')
  }
  return output
}

function teachingReady(candidate: MatchCandidateLike): boolean {
  return REVIEWED_STATUSES[candidate.reviewStatus ?? ''] === true
    && (candidate.evidenceLevel === 'verified' || candidate.evidenceLevel === 'gold')
}

export class NewsLabAgent {
  constructor(private readonly ctx: Context) {}

  async run(step: TurnStep, context: StepContext): Promise<SubagentResult> {
    const started = Date.now()
    const input = step.input
    const url = typeof input.url === 'string' ? input.url.trim() : ''
    const query = typeof input.query === 'string' && input.query.trim().length > 0
      ? input.query.trim()
      : context.message
    const withQuestions = input.withQuestions === true
    const lastArticleId = typeof input.lastArticleId === 'string' ? input.lastArticleId.trim() : ''
    const chapterId = typeof input.chapterId === 'string' && input.chapterId.length > 0
      ? input.chapterId
      : context.chapterId
    const warnings: string[] = []
    const wantsLatest = /最新(?:的)?(?:消息|新闻)|根据最新|当前最新/.test(query)
    const wantsThis = /这条新闻|这篇报道|当前新闻|刚才那条|刚才的新闻/.test(query)
    const source = input.source === 'local' || input.source === 'search' || input.source === 'url'
      ? input.source
      : undefined
    const wantsSearch = /搜一下|查一下|搜索|找.*(?:新闻|案例)/.test(query)
    let targets: NewsArticle[] = []
    let searched = 0

    if (url) {
      try {
        targets = [await this.ctx.news.crawlAndIngest(url)]
      } catch (error) {
        warnings.push(`新闻抓取失败：${error instanceof Error ? error.message : String(error)}`)
        return {
          stepId: step.id,
          agent: 'news_lab',
          status: 'failed',
          schema: 'NewsLab@1',
          content: {
            summary: `这条链接没有抓取成功，所以我没有生成分析，也没有改用别的文章。${warnings[0]}`,
            warnings,
          },
          citations: [],
          evidenceCandidates: [],
          warnings,
          usage: { ms: Date.now() - started, tokens: 0 },
        }
      }
    } else if (wantsThis || wantsLatest) {
      const recent = recentArticle(this.ctx, context, lastArticleId)
      if (recent) {
        targets = [recent]
      } else {
        const newest = this.ctx.learningDb.listNews({ limit: 1 })[0]
        if (newest) {
          targets = [newest]
          if (wantsThis) {
            warnings.push(`当前会话尚未指定新闻，本轮使用本地新闻库最新的《${newest.title}》；如果你指的是另一篇，请发链接。`)
          }
        }
      }
      if (targets.length === 0) {
        warnings.push('当前会话和本地新闻库都没有可用文章，请提供新闻链接。')
        return {
          stepId: step.id,
          agent: 'news_lab',
          status: 'needs_input',
          schema: 'NewsLab@1',
          content: {
            summary: warnings[0],
            warnings,
          },
          citations: [],
          evidenceCandidates: [],
          warnings,
          usage: { ms: Date.now() - started, tokens: 0 },
        }
      }
    } else if (source === 'search' || (source === undefined && wantsSearch)) {
      try {
        const result = await this.ctx.news.searchAndIngest(query, 3)
        searched = result.articles.length
        warnings.push(...result.errors.slice(0, 3))
        targets = result.articles
      } catch (error) {
        warnings.push(`新闻搜索失败：${error instanceof Error ? error.message : String(error)}`)
        return {
          stepId: step.id,
          agent: 'news_lab',
          status: 'failed',
          schema: 'NewsLab@1',
          content: {
            summary: `新闻搜索没有成功，所以我没有生成分析，也没有改用别的文章。${warnings[0]}`,
            warnings,
          },
          citations: [],
          evidenceCandidates: [],
          warnings,
          usage: { ms: Date.now() - started, tokens: 0 },
        }
      }
      if (targets.length === 0) {
        warnings.push('搜索没有返回可用文章；没有改用无关文章。')
        return {
          stepId: step.id,
          agent: 'news_lab',
          status: 'failed',
          schema: 'NewsLab@1',
          content: {
            summary: warnings[warnings.length - 1],
            warnings,
          },
          citations: [],
          evidenceCandidates: [],
          warnings,
          usage: { ms: Date.now() - started, tokens: 0 },
        }
      }
    } else {
      // Local-library path: the student wants the news we already have used as
      // teaching material, ranked by the current chapter's vocabulary.
      const selection = selectRelevantNews(this.ctx.learningDb, {
        query,
        chapterId,
        limit: Math.min(3, Math.max(1, Number(input.count ?? 3))),
      })
      if (selection.fallback && selection.articles.length > 0) {
        warnings.push(`本地新闻库没有与问题直接相关的新闻，本轮使用最新一篇《${selection.articles[0]!.title}》；要按关键词检索请说“搜一下”。`)
      }
      targets = selection.articles
      if (targets.length === 0) {
        return {
          stepId: step.id,
          agent: 'news_lab',
          status: 'needs_input',
          schema: 'NewsLab@1',
          content: {
            summary: '本地新闻库没有可用文章，请发新闻链接或说“搜一下”。',
            warnings,
          },
          citations: [],
          evidenceCandidates: [],
          warnings,
          usage: { ms: Date.now() - started, tokens: 0 },
        }
      }
    }

    const analyses: AnalysisBundle[] = []
    for (const target of targets) {
      analyses.push(await this.analyzeOne(target, chapterId, warnings))
    }
    const first = analyses[0]!
    const chapter = chapterTitle(this.ctx.learningDb.listChapters(), chapterId)
    const artifactDrafts: ArtifactDraft[] = analyses.map((item) => item.artifact)
    const citations = dedupeBy(
      (citation) => `${citation.sourceType}:${citation.sourceId}:${citation.quote}`,
      analyses.flatMap((item) => item.citations),
    )
    let questions: Question[] = []
    let questionNote = ''

    if (withQuestions) {
      // One question set for the whole turn, built from the first analysis that
      // has teaching-ready candidates; auto candidates must never seed items.
      const target = analyses.find((item) => item.readyCandidates.length > 0)
      if (!target) {
        questionNote = '新闻匹配没有已审核且证据等级为 verified/gold 的知识点，已跳过出题；自动候选不能直接用于出题。'
        warnings.push(questionNote)
      } else {
        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 25_000)
          try {
            questions = await this.ctx.questionSmith.generate({
              sourceType: 'news',
              sourceId: target.article.id,
              kpIds: target.readyCandidates.map((candidate) => candidate.kpId),
              types: extractTypes(context.message) as QuestionType[],
              difficulty: 2,
              count: Math.min(30, extractCount(context.message, 3)),
            }, controller.signal)
          } finally {
            clearTimeout(timer)
          }
          const requested = Math.min(30, extractCount(context.message, 3))
          if (questions.length < requested) {
            questionNote = `你要求 ${requested} 道，新闻情境题实际生成 ${questions.length} 道，还差 ${requested - questions.length} 道。`
            warnings.push(questionNote)
          }
          if (questions.length === 0) {
            questionNote = '新闻情境题没有生成可用题目；分析和候选仍保留。'
            warnings.push(questionNote)
          } else {
            const questionContent: QuestionSetContent = {
              intro: questionNote || `来源：新闻《${target.article.title.slice(0, 30)}》｜${target.readyCandidates.map((candidate) => candidate.kpName ?? candidate.kpId).join('、')}；共 ${questions.length} 道。`,
              questions: questions.map((question) => ({
                id: question.id,
                type: question.type,
                stem: question.stem,
                options: question.options,
                answer: question.answer,
                explanation: question.explanation,
                kpIds: question.kp_ids,
                difficulty: question.difficulty,
              })),
            }
            artifactDrafts.push({
              type: 'question_set',
              title: `题目集 · ${chapter || target.article.title.slice(0, 16)}`,
              schemaVersion: 'QuestionSet@1',
              contentJson: questionContent,
              markdownFallback: await this.ctx.artifacts.renderTemplate('question_set', {
                intro: questionContent.intro,
                questions: questions.map(questionLine).join('\n\n'),
              }),
              sourceRefs: [target.article.id, ...target.readyCandidates.map((candidate) => candidate.kpId)],
              evidenceIds: [],
            })
          }
        } catch (error) {
          questionNote = `新闻情境题生成失败：${error instanceof Error ? error.message : String(error)}`
          warnings.push(questionNote)
        }
      }
    }

    if (analyses.length > 1) {
      warnings.push(`本轮另分析了：${analyses.slice(1).map((item) => `《${item.article.title}》`).join('、')}`)
    }
    const mergedWarnings = dedupeBy((warning) => warning, warnings)
    const questionIds = questions.map((question) => question.id)
    const anyMatches = analyses.some((item) => item.matches.length > 0)
    const autoCandidates = analyses.some((item) => item.matches.some((match) => match.candidate))
    const summary = [
      `已使用 ${analyses.length} 篇本地新闻：《${first.article.title.slice(0, 40)}》${searched > 0 ? `（搜索入库 ${searched} 条）` : ''}`,
      anyMatches
        ? `匹配到 ${analyses.reduce((sum, item) => sum + item.matches.length, 0)} 个知识点候选${autoCandidates ? '（其中含未人审自动候选）' : ''}`
        : '没有可追溯的知识点候选',
      questions.length > 0 ? `生成 ${questions.length} 道新闻情境题` : '',
      questionNote,
    ].filter((line) => line.length > 0).join('；') + '。'

    return {
      stepId: step.id,
      agent: 'news_lab',
      status: anyMatches && (!withQuestions || questionIds.length > 0) ? 'ok' : 'partial',
      schema: 'NewsLab@1',
      content: {
        summary,
        checkQuestion: '这条新闻里，哪一句最可能推翻你的判断？',
        articleId: first.article.id,
        articleTitle: first.article.title,
        articleUrl: first.article.url,
        articleExcerpt: first.article.content.slice(0, 5_000),
        questionIds,
        warnings: mergedWarnings,
      },
      citations,
      evidenceCandidates: [],
      artifactDrafts,
      warnings: mergedWarnings,
      usage: { ms: Date.now() - started, tokens: 0 },
    }
  }

  /**
   * Build one article's analysis card: candidates, verbatim citations, the
   * matched knowledge points, and the traceable ideology matches. Question
   * generation stays in `run` so several articles share one question set.
   */
  private async analyzeOne(
    article: NewsArticle,
    chapterId: string,
    warnings: string[],
  ): Promise<AnalysisBundle> {
    const candidates = await loadCandidates(this.ctx, article, warnings, chapterId)
    const readyCandidates = candidates.filter(teachingReady)
    const chapter = chapterTitle(this.ctx.learningDb.listChapters(), chapterId)
    const summarySentence = article.summary || sentencesOf(article.content)[0] || ''
    const citations: Citation[] = []
    const seenCitation = new Set<string>()
    const addCitation = (citation: Citation): void => {
      const key = `${citation.sourceType}:${citation.sourceId}:${citation.quote}`
      if (seenCitation.has(key)) return
      seenCitation.add(key)
      citations.push(citation)
    }
    const articleQuote = sentencesOf(article.content)[0] ?? ''
    const locatedArticleQuote = articleQuote ? locateQuote(article.content, articleQuote) : undefined
    if (locatedArticleQuote) {
      addCitation({
        sourceType: 'news',
        sourceId: article.id,
        quote: locatedArticleQuote.quote,
        locator: {
          title: article.title,
          source: article.source,
          publishedAt: article.published_at,
          url: article.url,
        },
      })
    }

    const matches: AnalysisMatch[] = []
    for (const candidate of candidates) {
      const kp = this.ctx.learningDb.getKp(candidate.kpId)
      if (!kp) continue
      addCitation({
        sourceType: 'kp',
        sourceId: kp.id,
        quote: kp.definition,
        locator: { name: kp.name, chapterId: kp.chapter_id },
      })
      const ready = teachingReady(candidate)
      matches.push({
        kpId: kp.id,
        name: kp.name,
        role: candidate.tagRole,
        confidence: candidate.confidence,
        evidence: candidate.evidenceSpan,
        definition: kp.definition,
        // No template prose: the case mapping and dialogue belong to a human
        // reviewer or the model, not to a hardcoded sentence generator.
        caseMapping: '',
        dialogue: [],
        candidate: !ready,
        reviewStatus: candidate.reviewStatus,
        evidenceLevel: candidate.evidenceLevel,
        roleLabel: candidate.roleLabel ?? ROLE_LABELS[candidate.tagRole] ?? '提及',
        method: candidate.method,
      })
    }
    if (matches.some((match) => match.candidate)) {
      warnings.push('匹配结果包含自动候选（未人审），只作召回线索，不是教学结论。')
    }

    // Ideology matches come from the stored rows, and only when the quoted span
    // is still verbatim in the article; anything else would be an invented quote.
    const ideologyPoints = new Map(this.ctx.learningDb.listIdeology().map((point) => [point.id, point]))
    const ideology = this.ctx.learningDb.getIdeologyMatches(article.id)
      .filter((match) => match.review_status !== 'rejected'
        && locateQuote(article.content, match.evidence_span) !== undefined)
      .map((match) => ({
        name: ideologyPoints.get(match.ideology_id)?.name ?? match.ideology_id,
        evidence: match.evidence_span,
        rationale: match.rationale,
      }))

    const contentJson: AnalysisContent = {
      article: {
        title: article.title,
        source: article.source,
        publishedAt: article.published_at,
        url: article.url,
        summary: summarySentence,
      },
      matches,
      ideology,
      usageNote: matches.length === 0
        ? '没有检索到可追溯的知识点候选，不强行匹配；本卡只保留新闻摘要与原文。'
        : matches.some((match) => match.candidate)
          ? '匹配为自动候选（未人审），只用于召回，不是教学结论；引用句已回原文核对。'
          : '匹配来自已审核候选；引用句已回原文核对。',
      warnings,
    }
    const artifact: ArtifactDraft = {
      type: 'case_analysis',
      title: `新闻分析 · ${article.title.slice(0, 24)}`,
      schemaVersion: 'NewsAnalysis@1',
      contentJson,
      markdownFallback: analysisMarkdown(article, matches, chapter, ideology),
      sourceRefs: [article.id, ...matches.map((match) => match.kpId)],
      evidenceIds: [],
    }
    return { article, content: contentJson, artifact, citations, matches, readyCandidates }
  }
}
