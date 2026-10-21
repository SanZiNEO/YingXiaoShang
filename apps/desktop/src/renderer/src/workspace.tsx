import { useEffect, useRef, useState } from 'react'
import type { Artifact, Citation, LearningStateSnapshot, QuestionAttempt, TurnPlan, TurnRow } from '@learning-agent/shared'
import type { Capabilities, DocKind, DocTab, FilePreview, LedgerStatus, NewsDetail, NewsStatus, SetSubmissionStatus, SourceDetail } from './model'
import { ArtifactRenderer } from './renderers'
import { MarkdownView } from './markdown'
import { COLORS, Empty, HtmlFrame, Tag } from './ui'
import { chapterText, decisionLabel, intentLabel, phaseLabel, tagRoleLabel, turnStatusLabel } from './labels'
import { CloseIcon, DownloadIcon, ExpandIcon, FolderIcon, NewsIcon, PlusIcon, QuoteIcon } from './icons'

const LEDGER_LABEL: Record<string, string> = {
  summarized: '已整理',
  pending: '待整理',
  stale: '需重算',
  failed: '整理失败',
}

const TYPE_LABEL: Record<string, string> = {
  page: '页面',
  question_set: '题目集',
  research_design: '研究设计',
  bp_outline: 'BP 目录',
  case_analysis: '新闻分析',
  case_study: '案例精讲',
  growth_card: '成长卡',
  questionnaire: '问卷',
  bp_section: 'BP 章节',
  evidence_pack: '证据包',
}

/** 页面类产物只有 HTML 一种形态，导出的就是原件。 */
export type ExportFormat = 'md' | 'docx' | 'html'

function isPage(artifact: Artifact): boolean {
  return artifact.type === 'page' || artifact.format === 'html'
}

export interface WorkspaceProps {
  tabs: DocTab[]
  activeId?: string
  artifacts: Artifact[]
  attemptsByArtifact: Record<string, QuestionAttempt[]>
  citations: Citation[]
  citationLabels: Record<string, string>
  kpNames: Record<string, string>
  capabilities: Capabilities
  chapters: Array<{ id: string; number: number; title: string }>
  ledger: LedgerStatus
  newsStatus: NewsStatus
  snapshot?: LearningStateSnapshot
  turns: TurnRow[]
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onNew: (kind: DocKind) => void
  onOpenLocal: () => void
  onOpenArtifact: (artifact: Artifact) => void
  onOpenCitation: (citation: Citation) => void
  onSubmitSet: (artifactId: string, answers: Array<{ questionId: string; answer: string }>) => Promise<SetSubmissionStatus>
  onExport: (artifact: Artifact, format: ExportFormat) => void
  onReveal: (path: string) => void
  onRetryLedger: (sourceId: string) => void
  onRefreshNews: () => void
  onQuote: (text: string) => void
}

function tabLabel(tab: DocTab): string {
  if (tab.kind === 'artifact') return tab.title
  if (tab.kind === 'overview') return '任务概览'
  if (tab.kind === 'artifacts') return '产物'
  if (tab.kind === 'evidence') return '依据'
  if (tab.kind === 'process') return '过程 / 记录'
  if (tab.kind === 'files') return '文件'
  return tab.title
}

function artifactOf(tab: DocTab, artifacts: Artifact[]): Artifact | undefined {
  return tab.artifactId ? artifacts.find((artifact) => artifact.id === tab.artifactId) : undefined
}

function docSubtitle(tab: DocTab): string {
  if (tab.kind === 'evidence') return '本轮引用的知识点与新闻'
  if (tab.kind === 'process') return '记录 Agent 的整理水位与轮次'
  if (tab.kind === 'overview') return '当前任务的状态、产物与记录'
  if (tab.kind === 'artifacts') return '本次对话产生的产物'
  if (tab.kind === 'files') return '本地文件与导出'
  if (tab.kind === 'news') return '新闻原文与知识点匹配'
  if (tab.kind === 'source') return tab.source?.kind === 'resource' ? '教材资源与引用位置' : '教材块原文与引用位置'
  if (tab.kind === 'file') return tab.file?.path ?? '本地文件'
  return '打开产物、依据或过程'
}

const ROUTING_STRATEGY_LABEL: Record<string, string> = { rule: '规则', llm: 'LLM', fallback: '兜底' }

const AGENT_LABEL: Record<string, string> = {
  knowledge: '知识',
  question: '出题',
  research: '调研',
  bp: '商业计划',
  feedback: '反馈',
  growth: '成长',
  news_lab: '新闻',
  case: '案例',
  plan: '计划',
}

function stepSequence(steps: ReadonlyArray<{ agent: string; mode?: unknown }> | undefined): string {
  if (!Array.isArray(steps) || steps.length === 0) return ''
  return steps.map((step) => `${AGENT_LABEL[step.agent] ?? '步骤'}（${step.mode === 'read' ? '读取' : '生成'}）`).join(' → ')
}

function RoutingPill({ strategy, parallel }: { strategy?: string; parallel?: boolean }) {
  if (!strategy && !parallel) return null
  const label = strategy ? ROUTING_STRATEGY_LABEL[strategy] ?? strategy : ''
  const color = strategy === 'llm' ? COLORS.accent : strategy === 'fallback' ? COLORS.warning : COLORS.muted
  const pillStyle = {
    border: '1px solid',
    borderRadius: 999,
    padding: '0 5px',
    fontSize: 9,
    lineHeight: '14px',
    whiteSpace: 'nowrap',
  } as const
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flex: '0 0 auto' }}>
      {label ? <span style={{ ...pillStyle, borderColor: color, color }}>{label}</span> : null}
      {parallel ? <span style={{ ...pillStyle, borderColor: COLORS.accent, color: COLORS.accent }}>并行</span> : null}
    </span>
  )
}

function FilePreviewView({ file }: { file: FilePreview }) {
  if (file.kind === 'markdown') return <MarkdownView text={file.content} />
  if (file.kind === 'html') return <HtmlFrame title={file.name} html={file.content} />
  if (file.kind === 'text') {
    return <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.7, fontFamily: 'Consolas, monospace' }}>{file.content}</pre>
  }
  if (file.kind === 'image') {
    return <img src={file.content} alt={file.name} style={{ maxWidth: '100%', borderRadius: 8 }} />
  }
  if (file.kind === 'pdf') {
    return <iframe title={file.name} src={file.content} style={{ width: '100%', height: '100%', minHeight: 560, border: 'none' }} />
  }
  return <Empty>这个文件类型暂不支持只读预览。可以打开所在文件夹。</Empty>
}

function NewsView({ news, kpNames, onOpenCitation }: {
  news: NewsDetail
  kpNames: Record<string, string>
  onOpenCitation: (citation: Citation) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.6 }}>{news.article.title}</div>
        <div style={{ fontSize: 11, color: COLORS.muted, marginTop: 4 }}>
          {news.article.source} · {news.article.published_at.slice(0, 10)}
        </div>
        {news.article.url ? <a href={news.article.url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: COLORS.accent }}>查看原文</a> : null}
      </div>
      <MarkdownView text={news.article.content} compact />
      {news.matches.length > 0 ? (
        <section>
          <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.muted, marginBottom: 6 }}>匹配的知识点</div>
          {news.matches.map((match) => (
            <button
              key={match.kp_id}
              type="button"
              onClick={() => onOpenCitation({
                sourceType: 'kp',
                sourceId: match.kp_id,
                quote: match.evidence_span,
                locator: { name: kpNames[match.kp_id] ?? match.kpName ?? '' },
              })}
              style={{ display: 'block', width: '100%', textAlign: 'left', border: `1px solid ${COLORS.border}`, borderRadius: 8, background: '#fff', padding: 9, marginBottom: 6, cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Tag tone="accent">{tagRoleLabel(match.tag_role)}</Tag>
                <span style={{ fontSize: 12 }}>{kpNames[match.kp_id] ?? match.kpName ?? '知识点'}</span>
              </div>
              <div style={{ fontSize: 11, color: COLORS.muted, marginTop: 4, lineHeight: 1.6 }}>{match.evidence_span}</div>
            </button>
          ))}
        </section>
      ) : null}
    </div>
  )
}

function SourceView({ source }: { source: SourceDetail }) {
  if (source.kind === 'textbook') {
    const { block, chapter, section, quote } = source
    const location = [
      chapter ? `第${chapter.number}章 ${chapter.title}` : '',
      section?.title ?? '',
      block.page ? `第${block.page}页` : '',
    ].filter((item) => item.length > 0).join(' · ')
    return (
      <div data-source-kind="textbook" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 12, background: '#fff' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Tag tone="accent">教材原文</Tag>
            <Tag>{block.block_type === 'case_fragment' ? '案例片段' : block.block_type === 'paragraph' ? '段落' : block.block_type}</Tag>
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.6, marginTop: 6 }}>{location || '教材块'}</div>
          <div style={{ fontSize: 11, color: COLORS.muted, marginTop: 4 }}>来源：{block.source}{block.rights ? ` · ${block.rights}` : ''}</div>
        </div>
        {quote ? (
          <section>
            <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.muted, marginBottom: 6 }}>引用原文</div>
            <blockquote style={{ margin: 0, padding: '9px 12px', borderLeft: `3px solid ${COLORS.accent}`, background: '#fff', borderRadius: 8, fontSize: 12.5, lineHeight: 1.85 }}>
              {quote}
            </blockquote>
          </section>
        ) : null}
        <section>
          <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.muted, marginBottom: 6 }}>教材块完整原文</div>
          <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 9, background: '#fff', padding: 12, fontSize: 12.5, lineHeight: 1.9, whiteSpace: 'pre-wrap' }}>
            {block.text}
          </div>
        </section>
      </div>
    )
  }

  const { guide, chapter, quote } = source
  const lists: Array<[string, string[]]> = [
    ['重点', guide.key_points ?? []],
    ['难点', guide.difficulties ?? []],
    ['目标', guide.objectives ?? []],
    ['任务', guide.tasks ?? []],
  ]
  return (
    <div data-source-kind="resource" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 12, background: '#fff' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Tag tone="accent">教材资源</Tag>
          <Tag>教学指南</Tag>
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.6, marginTop: 6 }}>
          {chapter ? `第${chapter.number}章 ${chapter.title}` : guide.chapter_id || '教材资源'}
        </div>
        <div style={{ fontSize: 11, color: COLORS.muted, marginTop: 4 }}>来源：{guide.source ?? ''}</div>
      </div>
      {quote ? (
        <section>
          <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.muted, marginBottom: 6 }}>引用原文</div>
          <blockquote style={{ margin: 0, padding: '9px 12px', borderLeft: `3px solid ${COLORS.accent}`, background: '#fff', borderRadius: 8, fontSize: 12.5, lineHeight: 1.85 }}>
            {quote}
          </blockquote>
        </section>
      ) : null}
      {guide.summary ? (
        <section>
          <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.muted, marginBottom: 6 }}>概述</div>
          <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 9, background: '#fff', padding: 12, fontSize: 12.5, lineHeight: 1.85 }}>{guide.summary}</div>
        </section>
      ) : null}
      {lists.filter(([, items]) => items.length > 0).map(([title, items]) => (
        <section key={title}>
          <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.muted, marginBottom: 6 }}>{title}</div>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12.5, lineHeight: 1.85 }}>
            {items.map((item, index) => <li key={index}>{item}</li>)}
          </ul>
        </section>
      ))}
      {guide.framework_text ? (
        <section>
          <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.muted, marginBottom: 6 }}>教学框架</div>
          <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 9, background: '#fff', padding: 12, fontSize: 12.5, lineHeight: 1.9, whiteSpace: 'pre-wrap' }}>{guide.framework_text}</div>
        </section>
      ) : null}
    </div>
  )
}

export function Workspace(props: WorkspaceProps) {
  const {
    tabs, activeId, artifacts, attemptsByArtifact, citations, citationLabels, kpNames, capabilities, chapters,
    ledger, newsStatus, snapshot, turns,
    onActivate, onClose, onNew, onOpenLocal, onOpenArtifact, onOpenCitation, onSubmitSet, onExport, onReveal,
    onRetryLedger, onRefreshNews, onQuote,
  } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const tabBarRef = useRef<HTMLDivElement>(null)
  const active = tabs.find((tab) => tab.id === activeId)
  const artifact = active ? artifactOf(active, artifacts) : undefined
  // listTurns returns newest first, so the latest turn is the first row.
  const latestPlan = turns.length > 0 ? (turns[0]?.plan_json ?? {}) as Partial<TurnPlan> : undefined
  const latestRouting = latestPlan?.routing && typeof latestPlan.routing === 'object' ? latestPlan.routing : undefined

  useEffect(() => {
    if (!activeId) return
    const target = tabBarRef.current?.querySelector(`[data-tab-id="${activeId}"]`)
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId])

  const headerActions = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {artifact ? (
        <>
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              title="导出"
              aria-label="导出"
              onClick={() => setExportMenuOpen((value) => !value)}
              style={iconActionStyle}
            >
              <DownloadIcon size={14} />
            </button>
            {exportMenuOpen ? (
              <div style={{ position: 'absolute', right: 0, top: 30, width: 140, background: '#fff', border: `1px solid ${COLORS.border}`, borderRadius: 9, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', padding: 4, zIndex: 60 }}>
                {isPage(artifact) ? (
                  <button
                    type="button"
                    onClick={() => { onExport(artifact, 'html'); setExportMenuOpen(false) }}
                    style={menuStyle}
                  >
                    导出网页
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => { onExport(artifact, 'md'); setExportMenuOpen(false) }}
                      style={menuStyle}
                    >
                      导出 Markdown
                    </button>
                    <button
                      type="button"
                      onClick={() => { onExport(artifact, 'docx'); setExportMenuOpen(false) }}
                      style={menuStyle}
                    >
                      导出 Word
                    </button>
                  </>
                )}
              </div>
            ) : null}
          </div>
          {capabilities.revealFiles ? (
            <button type="button" title="打开所在文件夹" aria-label="打开所在文件夹" onClick={() => onReveal(artifact.path)} style={iconActionStyle}><FolderIcon size={14} /></button>
          ) : null}
        </>
      ) : null}
      {active?.file && capabilities.revealFiles ? (
        <button type="button" title="打开所在文件夹" aria-label="打开所在文件夹" onClick={() => onReveal(active.file!.path)} style={iconActionStyle}>
          <FolderIcon size={14} />
        </button>
      ) : null}
      <button
        type="button"
        title="引用选中文本"
        aria-label="引用选中文本"
        onClick={() => {
          const selected = window.getSelection()?.toString().trim() ?? ''
          if (selected.length > 0) onQuote(selected)
        }}
        style={iconActionStyle}
      >
        <QuoteIcon size={14} />
      </button>
      <button type="button" title={fullscreen ? '还原' : '全屏'} aria-label={fullscreen ? '还原' : '全屏'} onClick={() => setFullscreen((value) => !value)} style={iconActionStyle}>
        <ExpandIcon size={14} />
      </button>
    </div>
  )

  return (
    <aside style={{
      width: fullscreen ? '100vw' : 460,
      flex: fullscreen ? '1 1 auto' : '0 0 460px',
      position: fullscreen ? 'fixed' : 'relative',
      inset: fullscreen ? 0 : undefined,
      zIndex: fullscreen ? 40 : 1,
      borderLeft: `1px solid ${COLORS.border}`,
      background: '#fbfbfa',
      display: 'flex',
      flexDirection: 'column',
      minWidth: 0,
    }}>
      <div ref={tabBarRef} style={{ display: 'flex', alignItems: 'center', gap: 4, borderBottom: `1px solid ${COLORS.border}`, padding: '6px 8px', overflowX: 'auto' }}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            data-tab-id={tab.id}
            type="button"
            onClick={() => onActivate(tab.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              border: `1px solid ${tab.id === activeId ? COLORS.accent : COLORS.border}`,
              background: tab.id === activeId ? '#fff' : 'transparent',
              color: tab.id === activeId ? COLORS.accent : COLORS.muted,
              borderRadius: 8,
              padding: '4px 7px',
              fontSize: 11,
              cursor: 'pointer',
              maxWidth: 180,
              whiteSpace: 'nowrap',
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{tabLabel(tab)}</span>
            <span
              role="button"
              tabIndex={0}
              onClick={(event) => {
                event.stopPropagation()
                onClose(tab.id)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onClose(tab.id)
              }}
              style={{ color: COLORS.muted, display: 'inline-flex' }}
            >
              <CloseIcon size={11} />
            </span>
          </button>
        ))}
        <div style={{ position: 'relative', marginLeft: 'auto' }}>
          <button type="button" aria-label="+" onClick={() => setMenuOpen((value) => !value)} style={{ ...iconActionStyle, border: 'none' }}><PlusIcon size={14} /></button>
          {menuOpen ? (
            <div style={{ position: 'absolute', right: 0, top: 30, width: 170, background: '#fff', border: `1px solid ${COLORS.border}`, borderRadius: 9, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', padding: 5, zIndex: 50 }}>
              {([
                ['overview', '任务概览'],
                ['artifacts', '产物列表'],
                ['evidence', '依据 / 引用'],
                ['process', '过程 / 记录'],
                ['files', '文件'],
              ] as Array<[DocKind, string]>).map(([kind, label]) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => { onNew(kind); setMenuOpen(false) }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'transparent', padding: '7px 8px', fontSize: 12, cursor: 'pointer', borderRadius: 6 }}
                >
                  {label}
                </button>
              ))}
              {capabilities.localFiles ? (
                <button
                  type="button"
                  onClick={() => { onOpenLocal(); setMenuOpen(false) }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'transparent', padding: '7px 8px', fontSize: 12, cursor: 'pointer', borderRadius: 6 }}
                >
                  打开本地文件…
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, padding: '10px 14px', borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {active ? tabLabel(active) : '任务工作区'}
          </div>
          <div style={{ fontSize: 10, color: COLORS.muted, marginTop: 2 }}>
            {artifact
              ? ''
              : active
                ? docSubtitle(active)
                : '打开产物、依据或过程'}
          </div>
        </div>
        {headerActions}
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
        {!active ? (
          <div style={{ color: COLORS.muted, fontSize: 12, lineHeight: 1.8 }}>
            <div style={{ fontSize: 14, color: COLORS.text, fontWeight: 600, marginBottom: 6 }}>这里只放本次任务的工作文档</div>
            <div>点 + 打开任务概览、产物、依据、过程或本地文件；产物会以原生卡片渲染，不显示 Markdown 标记。</div>
          </div>
        ) : active.kind === 'artifact' && artifact ? (
          <ArtifactRenderer
            key={artifact.id}
            artifact={artifact}
            attempts={attemptsByArtifact[artifact.id] ?? []}
            kpNames={kpNames}
            onSubmitSet={(artifactId, answers) => onSubmitSet(artifactId, answers)}
            onOpenSource={(sourceId, sourceType, quote) => onOpenCitation({ sourceType, sourceId, quote, locator: {} })}
          />
        ) : active.kind === 'overview' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <section style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 12, background: '#fff' }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>本轮任务</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 7 }}>
                <Tag tone="accent">{chapterText(snapshot?.scope.chapterId, chapters)}</Tag>
                <Tag>证据 {snapshot?.evidence.count ?? 0}</Tag>
                <Tag>计划 {snapshot?.plan.completed ?? 0}/{snapshot?.plan.total ?? 0}</Tag>
              </div>

            </section>
            <section style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 12, background: '#fff' }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>记录账本</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 7 }}>
                <Tag tone="success">已整理 {ledger.counts.summarized}</Tag>
                <Tag tone={ledger.counts.pending > 0 ? 'warning' : 'neutral'}>待整理 {ledger.counts.pending}</Tag>
                <Tag tone={ledger.counts.stale > 0 ? 'warning' : 'neutral'}>需重算 {ledger.counts.stale}</Tag>
                <Tag tone={ledger.counts.failed > 0 ? 'warning' : 'neutral'}>失败 {ledger.counts.failed}</Tag>
              </div>
              <div style={{ fontSize: 11, color: COLORS.muted, marginTop: 7 }}>记录 Agent 只消费 TurnRecord，不重新生成轮次。</div>
            </section>
            <section style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 12, background: '#fff' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ display: 'inline-flex', color: COLORS.accent }}><NewsIcon size={14} /></span>
                <span style={{ fontSize: 13, fontWeight: 700 }}>新闻库</span>
                <span style={{ fontSize: 11, color: COLORS.muted }}>
                  {newsStatus.count} 条{newsStatus.newestFetchedAt ? ` · 最近抓取 ${newsStatus.newestFetchedAt.slice(0, 16).replace('T', ' ')}` : ''}
                </span>
                <button type="button" onClick={onRefreshNews} style={{ ...linkButtonStyle, marginTop: 0, marginLeft: 'auto' }}>刷新</button>
              </div>
              <div style={{ fontSize: 10.5, color: COLORS.muted, marginTop: 5, lineHeight: 1.6 }}>
                应用运行时自动检查更新；网络失败时保留旧数据。
              </div>
            </section>
            <section style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 12, background: '#fff' }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 7 }}>本次产物</div>
              {artifacts.length === 0 ? <Empty>暂无产物</Empty> : artifacts.slice(0, 8).map((item) => (
                <button key={item.id} type="button" onClick={() => onOpenArtifact(item)} style={listButtonStyle}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{item.title}</span>
                  <span style={{ fontSize: 10, color: COLORS.muted }}>{TYPE_LABEL[item.type] ?? '附件'}</span>
                </button>
              ))}
            </section>
          </div>
        ) : active.kind === 'artifacts' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {artifacts.length === 0 ? <Empty>还没有产物。让营小商出题、做调研或写 BP。</Empty> : artifacts.map((item) => (
              <button key={item.id} type="button" onClick={() => onOpenArtifact(item)} style={listButtonStyle}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{item.title}</span>
                <span style={{ fontSize: 10, color: COLORS.muted }}>{TYPE_LABEL[item.type] ?? '附件'} · {item.created_at.slice(0, 16)}</span>
              </button>
            ))}
          </div>
        ) : active.kind === 'evidence' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <section>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>本轮引用</div>
              {citations.length === 0 ? <Empty>本轮没有引用。解释类问题会在这里列出知识点和新闻原文。</Empty> : citations.map((citation, index) => {
                const name = citationLabels[`${citation.sourceType}:${citation.sourceId}`]
                  ?? (typeof citation.locator?.name === 'string' ? citation.locator.name : undefined)
                  ?? (typeof citation.locator?.title === 'string' ? citation.locator.title : undefined)
                const typeLabel = citation.sourceType === 'kp'
                  ? '知识点'
                  : citation.sourceType === 'news'
                    ? '新闻'
                    : citation.sourceType === 'textbook'
                      ? '教材'
                      : '教材资源'
                return (
                  <button
                    key={`${citation.sourceType}:${citation.sourceId}:${index}`}
                    type="button"
                    onClick={() => onOpenCitation(citation)}
                    style={citationRowStyle}
                  >
                    <span style={{ fontSize: 12, fontWeight: 600 }}>
                      [{index + 1}] {typeLabel}{name ? ` · ${name}` : ''}
                    </span>
                    {citation.quote ? (
                      <span style={{ fontSize: 11, color: COLORS.muted, lineHeight: 1.7, textAlign: 'left' }}>
                        {citation.sourceType === 'kp' ? '定义：' : '原文摘录：'}{citation.quote}
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </section>
            <div style={{ fontSize: 11, color: COLORS.muted, lineHeight: 1.7 }}>
              这里只展示本轮引用。完整的学生能力证据、认可/驳回和成长卡在左栏「学习档案」。
            </div>
          </div>
        ) : active.kind === 'process' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {latestRouting ? (
              <section>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: COLORS.muted }}>路由</span>
                  <span style={{ fontSize: 10, color: COLORS.muted }}>最新轮次</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 11, lineHeight: 1.7 }}>
                  <RoutingPill strategy={latestRouting.strategy} parallel={latestRouting.parallel} />
                  <span style={{ color: COLORS.muted }}>耗时 {latestRouting.elapsedMs ?? 0} 毫秒</span>
                  {Array.isArray(latestRouting.candidates) && latestRouting.candidates.length > 0 ? (
                    <span style={{ color: COLORS.muted }}>候选 {latestRouting.candidates.map((candidate) => AGENT_LABEL[candidate] ?? '候选').join('、')}</span>
                  ) : null}
                </div>
                {latestRouting.reason ? (
                  <div style={{ fontSize: 11, color: COLORS.muted, lineHeight: 1.7, marginTop: 3 }}>原因：{latestRouting.reason}</div>
                ) : null}
                {stepSequence(latestPlan?.steps) ? (
                  <div style={{ fontSize: 11, color: COLORS.muted, lineHeight: 1.7, marginTop: 3 }}>步骤：{stepSequence(latestPlan?.steps)}</div>
                ) : null}
              </section>
            ) : null}
            <section>
              <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.muted, marginBottom: 4 }}>整理水位</div>
              {ledger.items.length === 0 ? <Empty>还没有记录账本。</Empty> : ledger.items.map((item) => (
                <div key={`${item.source_type}:${item.source_id}`} style={{ display: 'flex', alignItems: 'center', gap: 8, borderBottom: `1px solid #f0f2f1`, padding: '7px 0', fontSize: 11 }}>
                  <Tag tone={item.status === 'summarized' ? 'success' : item.status === 'failed' ? 'warning' : 'accent'}>
                    {LEDGER_LABEL[item.status] ?? item.status}
                  </Tag>
                  <span style={{ color: COLORS.muted }}>seq {item.summarized_seq} / {item.source_seq}</span>
                  <span style={{ color: COLORS.muted }}>尝试 {item.attempts}</span>
                  {item.last_error ? <span style={{ color: COLORS.warning, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.last_error}</span> : <span style={{ flex: 1 }} />}
                  {item.status !== 'summarized' ? (
                    <button type="button" onClick={() => onRetryLedger(item.source_id)} style={{ ...linkButtonStyle, marginTop: 0 }}>重试</button>
                  ) : null}
                </div>
              ))}
            </section>
            <section>
              <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.muted, marginBottom: 2 }}>轮次</div>
              {turns.length === 0 ? <Empty>还没有轮次记录。</Empty> : turns.map((turn) => {
                const plan = (turn.plan_json ?? {}) as Partial<TurnPlan>
                const routing = plan.routing && typeof plan.routing === 'object' ? plan.routing : undefined
                const sequence = stepSequence(plan.steps)
                return (
                  <div key={turn.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, borderBottom: `1px solid #f0f2f1`, padding: '6px 0', fontSize: 11 }}>
                    <span style={{ width: 72, flex: '0 0 72px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{intentLabel(plan.intent)}</span>
                    <span style={{ flex: 1, color: COLORS.muted }}>
                      {phaseLabel(plan.phase)} · {decisionLabel(plan.decision)}
                      {sequence ? ` · ${sequence}` : ''}
                    </span>
                    <RoutingPill strategy={routing?.strategy} parallel={routing?.parallel} />
                    <span style={{ color: COLORS.muted, fontSize: 10 }}>{turn.seq_start}–{turn.seq_end}</span>
                    <span style={{ color: turn.status === 'completed' ? COLORS.success : turn.status === 'failed' ? COLORS.warning : COLORS.muted, fontSize: 10 }}>{turnStatusLabel(turn.status)}</span>
                  </div>
                )
              })}
            </section>
          </div>
        ) : active.kind === 'files' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {artifacts.length === 0 ? <Empty>还没有导出文件。</Empty> : artifacts.map((item) => (
              <div key={item.id} style={{ border: `1px solid ${COLORS.border}`, borderRadius: 9, background: '#fff', padding: 9 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>{item.title}</div>
                <div style={{ fontSize: 10, color: COLORS.muted, marginTop: 3, wordBreak: 'break-all' }}>
                  {capabilities.revealFiles ? item.path : '下载后由浏览器保存到本地'}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 5, flexWrap: 'wrap' }}>
                  {isPage(item) ? (
                    <button type="button" onClick={() => onExport(item, 'html')} style={actionStyle}>{capabilities.downloadArtifacts === 'browser' ? '下载' : '导出'} 网页</button>
                  ) : (
                    <>
                      <button type="button" onClick={() => onExport(item, 'md')} style={actionStyle}>{capabilities.downloadArtifacts === 'browser' ? '下载' : '导出'} MD</button>
                      <button type="button" onClick={() => onExport(item, 'docx')} style={actionStyle}>{capabilities.downloadArtifacts === 'browser' ? '下载' : '导出'} DOCX</button>
                    </>
                  )}
                  {capabilities.revealFiles ? (
                    <button type="button" onClick={() => onReveal(item.path)} style={actionStyle}>打开文件夹</button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : active.kind === 'file' && active.file ? (
          <FilePreviewView file={active.file} />
        ) : active.kind === 'news' && active.news ? (
          <NewsView news={active.news} kpNames={kpNames} onOpenCitation={onOpenCitation} />
        ) : active.kind === 'source' && active.source ? (
          <SourceView source={active.source} />
        ) : (
          <Empty>这个文档暂时无法预览。</Empty>
        )}
      </div>
    </aside>
  )
}

const actionStyle = {
  border: `1px solid ${COLORS.border}`,
  background: '#fff',
  color: COLORS.text,
  borderRadius: 7,
  padding: '3px 7px',
  fontSize: 11,
  cursor: 'pointer',
} as const

const iconActionStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: `1px solid ${COLORS.border}`,
  background: '#fff',
  color: COLORS.muted,
  borderRadius: 7,
  width: 26,
  height: 26,
  padding: 0,
  cursor: 'pointer',
} as const

const menuStyle = {
  display: 'block',
  width: '100%',
  textAlign: 'left' as const,
  border: 'none',
  background: 'transparent',
  padding: '6px 8px',
  fontSize: 11,
  cursor: 'pointer',
  borderRadius: 6,
}

const citationRowStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 3,
  textAlign: 'left' as const,
  border: 'none',
  borderBottom: `1px solid #f0f2f1`,
  background: 'transparent',
  padding: '8px 0',
  cursor: 'pointer',
}

const listButtonStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 3,
  textAlign: 'left' as const,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 9,
  background: '#fff',
  padding: '8px 10px',
  cursor: 'pointer',
}

const linkButtonStyle = {
  border: 'none',
  background: 'transparent',
  color: COLORS.accent,
  fontSize: 11,
  padding: 0,
  marginTop: 4,
  cursor: 'pointer',
} as const
