import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Artifact,
  Ask,
  ChatMessage,
  ChatSession,
  Citation,
  Evidence,
  LearningStateSnapshot,
  LearningSuggestions,
  MemoryEpisode,
  MemoryFact,
  QuestionAttempt,
  Scope,
  TeachingGuide,
  TurnPlan,
  TurnRow,
} from '@learning-agent/shared'
import type {
  AnswerSetResponse,
  BlockDetail,
  ChatEvent,
  DocKind,
  DocTab,
  LedgerStatus,
  MemorySummary,
  NewsDetail,
  NewsRefreshResult,
  NewsStatus,
  ProfileData,
  ResourceDetail,
  SessionSummary,
  SetSubmissionStatus,
  SourceDetail,
  StudentIdentity,
  TurnPayload,
  TurnResponse,
  TurnTrace,
} from './model'
import { locateSpan } from '@learning-agent/shared'
import { Button, COLORS, Empty, Tag } from './ui'
import { MarkdownView } from './markdown'
import { Workspace } from './workspace'
import { DragHandle } from './layout/DragHandle'
import { useViewportWidth } from './layout/useViewportWidth'
import {
  CENTER_MIN,
  SIDEBAR_AUTO_COLLAPSE,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  WORKSPACE_DEFAULT_RATIO,
  WORKSPACE_MAX_RATIO,
  WORKSPACE_MIN,
  clampWidth,
  computeColumns,
} from './layout/columns'
import { CHAPTER_SHORT, chapterText, phaseLabel } from './labels'
import {
  ArtifactIcon,
  BrandMark,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  DocIcon,
  EmptyChatArt,
  EvidenceIcon,
  LayersIcon,
  PlusIcon,
  SendIcon,
  SparkIcon,
} from './icons'

const LEVEL_WORD: Record<string, string> = {
  L1: '起步',
  L2: '能套用',
  L3: '能情境化',
  L4: '能批判',
  unknown: '证据不足',
}

const STRENGTH_WORD: Record<string, string> = { A: '强', B: '较强', C: '中', D: '弱' }

const MEMORY_KIND_LABEL: Record<string, string> = {
  goal: '目标',
  preference: '偏好',
  constraint: '约束',
  background: '背景',
  self_assessment: '自我评估',
  open_question: '待确认',
}

const SESSION_STATUS_LABEL: Record<string, string> = {
  active: '进行中',
  awaiting_confirmation: '待确认',
  awaiting_input: '待确认',
  new_artifact: '有新产物',
  organized: '已整理',
}

const EMPTY_LEDGER: LedgerStatus = {
  items: [],
  counts: { summarized: 0, pending: 0, stale: 0, failed: 0 },
}

const SIDEBAR_STORAGE_KEY = 'yingxiaoshang.layout.sidebar'
const WORKSPACE_STORAGE_KEY = 'yingxiaoshang.layout.workspace'

type WorkspacePref = { ratio: number } | { px: number }

function readNumber(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(key)
    const value = raw === null ? Number.NaN : Number(raw)
    return Number.isFinite(value) ? value : fallback
  } catch {
    return fallback
  }
}

function persistNumber(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value))
  } catch {
    // 存储被禁用时保持内存态即可。
  }
}

function readWorkspacePref(): WorkspacePref {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>
        if (typeof record.ratio === 'number' && Number.isFinite(record.ratio)) {
          return { ratio: Math.min(Math.max(record.ratio, 0), WORKSPACE_MAX_RATIO) }
        }
        if (typeof record.px === 'number' && Number.isFinite(record.px) && record.px > 0) {
          return { px: record.px }
        }
      }
    }
  } catch {
    // 旧值或损坏的 JSON 都回落到默认比例。
  }
  return { ratio: WORKSPACE_DEFAULT_RATIO }
}

function persistWorkspacePref(pref: WorkspacePref): void {
  try {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(pref))
  } catch {
    // 存储被禁用时保持内存态即可。
  }
}

const SUGGESTIONS = [
  '我想学消费者行为',
  '直播间为什么让人冲动消费',
  '给我出 3 道题',
]

/** 一轮对话中主进程推给界面的进度事件。 */
interface ChatStreamEvent {
  requestId: string
  agent: string
  type: 'round' | 'text' | 'tool'
  round?: number
  text?: string
  tool?: string
}

/** 工具名 → 用户可读的动作文案；进度提示不暴露内部工具名。 */
const TOOL_LABEL: Record<string, string> = {
  'list_chapter_kps': '正在看本章有哪些知识点',
  'read_material': '正在取教材材料',
  'read_kp': '正在读知识点定义',
  'read_textbook': '正在读教材原文',
  'read_reference': '正在查手册',
  'search_news': '正在检索新闻',
  'read_news': '正在读新闻原文',
  'write_page': '正在写页面',
  'emit_question_set': '正在出题',
}

function mapMessages(rows: ChatMessage[]): ChatEvent[] {
  return rows.map((row) => ({
    ...row,
    payload: row.payload_json && typeof row.payload_json === 'object'
      ? row.payload_json as TurnPayload
      : {},
  }))
}

function lastPayload(rows: ChatEvent[]): TurnPayload {
  const assistant = [...rows].reverse().find((event) => event.role === 'assistant')
  return assistant?.payload ?? {}
}

function scopeText(scope: Scope | undefined): string {
  if (!scope?.chapterId) return '课程通识'
  const number = /ch(\d{1,2})/.exec(scope.chapterId)?.[1]
  const short = CHAPTER_SHORT[scope.chapterId] ?? scope.chapterTitle
  if (!short) return number ? `第${Number(number)}章` : '课程通识'
  return number ? `第${Number(number)}章 · ${short}` : short
}

function artifactTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    page: '页面',
    question_set: '题目集',
    research_design: '研究设计',
    bp_outline: 'BP 目录',
    case_analysis: '新闻分析',
    case_study: '案例精讲',
    growth_card: '成长卡',
  }
  return labels[type] ?? '附件'
}

function artifactTabTitle(artifact: Artifact): string {
  if (artifact.type === 'question_set') {
    const content = artifact.content_json as { questions?: unknown[] } | null
    return `题目集 · ${content?.questions?.length ?? 0} 题`
  }
  if (artifact.type === 'research_design') return '研究设计'
  if (artifact.type === 'bp_outline') return 'BP 目录'
  if (artifact.type === 'case_analysis') return '新闻分析'
  if (artifact.type === 'case_study') {
    const content = artifact.content_json as { knowledgePoints?: unknown[] } | null
    const count = content?.knowledgePoints?.length ?? 0
    return count > 0 ? `案例精讲 · ${count} 个知识点` : '案例精讲'
  }
  if (artifact.type === 'growth_card') return '成长卡'
  return artifact.title
}

function docTitle(kind: DocKind): string {
  if (kind === 'overview') return '任务概览'
  if (kind === 'artifacts') return '产物列表'
  if (kind === 'evidence') return '依据'
  if (kind === 'process') return '过程 / 记录'
  if (kind === 'files') return '文件'
  if (kind === 'source') return '原文'
  return kind
}

function guideText(guide: TeachingGuide): string {
  return [
    guide.chapter_id ?? '',
    guide.summary ?? '',
    ...(guide.key_points ?? []),
    ...(guide.difficulties ?? []),
    ...(guide.objectives ?? []),
    ...(guide.tasks ?? []),
    guide.framework_text ?? '',
  ].filter((item) => item.length > 0).join('\n')
}

function sourceTabTitle(source: SourceDetail): string {
  if (source.kind === 'textbook') {
    return source.chapter ? `教材 · 第${source.chapter.number}章 ${source.chapter.title}` : '教材原文'
  }
  return source.chapter ? `教材资源 · 第${source.chapter.number}章 ${source.chapter.title}` : '教材资源'
}

function QuickAsks({ asks, onSend }: { asks: Ask[]; onSend: (text: string) => void }) {
  return (
    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 7 }}>
      {asks.map((ask, index) => (
        <div key={index}>
          <div style={{ fontSize: 12, color: COLORS.muted, lineHeight: 1.65 }}>{ask.question}</div>
          {ask.options.length > 0 ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 5 }}>
              {ask.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  data-quick-ask="true"
                  onClick={() => onSend(option)}
                  style={{
                    border: 'none',
                    background: '#f1f4f3',
                    color: COLORS.text,
                    borderRadius: 999,
                    padding: '4px 10px',
                    fontSize: 11.5,
                    cursor: 'pointer',
                  }}
                >
                  {option}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
}

function FeedbackDetails({ feedback }: { feedback: NonNullable<TurnPayload['feedback']> }) {
  const [open, setOpen] = useState(false)
  if (!feedback.explanation && !feedback.correctAnswer) return null
  return (
    <div style={{ marginTop: 7, fontSize: 11.5, color: COLORS.muted }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        style={{ border: 'none', background: 'transparent', color: COLORS.muted, padding: 0, fontSize: 11.5, cursor: 'pointer' }}
      >
        {open ? '收起解析' : '查看解析'}
      </button>
      {open ? (
        <div style={{ marginTop: 5, lineHeight: 1.75 }}>
          {feedback.correctAnswer ? <div>参考答案：{feedback.correctAnswer}</div> : null}
          {feedback.explanation ? <div>{feedback.explanation}</div> : null}
        </div>
      ) : null}
    </div>
  )
}

function ProfileView({
  student, profileData, evidence, facts, episodes, memorySummary, ledger, snapshot,
  onBack, onReview, onRecordCheckpoint,
}: {
  student?: StudentIdentity
  profileData?: ProfileData
  evidence: Evidence[]
  facts: MemoryFact[]
  episodes: MemoryEpisode[]
  memorySummary?: MemorySummary
  ledger: LedgerStatus
  snapshot?: LearningStateSnapshot
  onBack: () => void
  onReview: (id: string, status: 'reviewed' | 'rejected') => void
  onRecordCheckpoint: (checkpoint: 'pre' | 'post') => void
}) {
  const profile = profileData?.profile
  const growth = profileData?.growth ?? []
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px 40px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <Button onClick={onBack}>← 回到对话</Button>
        <div>
          <h1 style={{ margin: 0, fontSize: 19 }}>学习档案</h1>
          <div style={{ color: COLORS.muted, fontSize: 11, marginTop: 3 }}>{student?.name ?? '学生'} · {student?.cohort ?? ''}</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 0.9fr', gap: 12 }}>
        <section style={panelStyle}>
          <div style={sectionTitleStyle}>目标与约束</div>
          {profile?.goals.map((goal) => <div key={goal} style={lineStyle}>· {goal}</div>)}
          {profile?.constraints.map((constraint) => <div key={constraint} style={{ ...lineStyle, color: COLORS.muted }}>约束：{constraint}</div>)}
          {Object.entries(profile?.preferences ?? {}).map(([key, value]) => (
            <div key={key} style={{ ...lineStyle, color: COLORS.muted }}>{MEMORY_KIND_LABEL[key] ?? key}：{String(value)}</div>
          ))}
          {memorySummary?.headline ? (
            <div style={{ ...lineStyle, color: COLORS.muted, marginTop: 7 }}>我记得：{memorySummary.headline}</div>
          ) : null}
        </section>
        <section style={panelStyle}>
          <div style={sectionTitleStyle}>当前状态</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Tag tone="accent">{phaseLabel(snapshot?.phase)}</Tag>
            <Tag>{scopeText(snapshot?.scope)}</Tag>
            <Tag>证据 {snapshot?.evidence.count ?? 0}</Tag>
            <Tag>计划 {snapshot?.plan.completed ?? 0}/{snapshot?.plan.total ?? 0}</Tag>
          </div>
          <div style={{ fontSize: 11, color: COLORS.muted, lineHeight: 1.7, marginTop: 8 }}>{snapshot?.phase_reasons.join('；')}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            <Button onClick={() => onRecordCheckpoint('pre')}>前测快照</Button>
            <Button onClick={() => onRecordCheckpoint('post')}>后测快照</Button>
          </div>
          <div style={{ fontSize: 10, color: COLORS.muted, marginTop: 8 }}>整理状态：已整理 {ledger.counts.summarized} · 待整理 {ledger.counts.pending} · 需重算 {ledger.counts.stale}</div>
        </section>
      </div>

      <section style={{ ...panelStyle, marginTop: 12 }}>
        <div style={sectionTitleStyle}>能力维度</div>
        {growth.length === 0 ? <Empty>还没有形成能力快照。</Empty> : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9 }}>
            {growth.map((item) => (
              <div key={item.competency.id} style={{ border: `1px solid ${COLORS.border}`, borderRadius: 9, padding: 10, background: '#fff' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{item.competency.name}</span>
                  <Tag tone={item.status === '证据不足' ? 'warning' : 'success'}>{item.status}</Tag>
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, marginTop: 4 }}>{LEVEL_WORD[item.level] ?? '证据不足'}</div>
                <div style={{ fontSize: 10, color: COLORS.muted, marginTop: 3 }}>证据 {item.evidenceCount} 条</div>
                {item.latestEvidence ? (
                  <blockquote style={{ margin: '6px 0 0', paddingLeft: 8, borderLeft: `2px solid ${COLORS.accent}`, fontSize: 10, color: COLORS.muted, lineHeight: 1.6 }}>
                    “{item.latestEvidence.excerpt}”
                  </blockquote>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={{ ...panelStyle, marginTop: 12 }}>
        <div style={sectionTitleStyle}>证据账本（{evidence.length}）</div>
        {evidence.length === 0 ? <Empty>还没有学生能力证据。</Empty> : evidence.slice(0, 40).map((item) => (
          <div key={item.id} style={{ borderTop: `1px solid ${COLORS.border}`, padding: '7px 0', fontSize: 11, lineHeight: 1.7 }}>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 3 }}>
              <Tag tone="accent">{profileData?.competencies.find((competency) => competency.id === item.competency_id)?.name ?? '能力维度'}</Tag>
              <Tag>{LEVEL_WORD[item.level] ?? '证据不足'}</Tag>
              <Tag tone={item.strength === 'A' || item.strength === 'B' ? 'success' : 'warning'}>证据{STRENGTH_WORD[item.strength] ?? '待验证'}</Tag>
              <Tag tone={item.review_status === 'rejected' ? 'warning' : item.review_status === 'reviewed' ? 'success' : 'neutral'}>
                {item.review_status === 'rejected' ? '已驳回' : item.review_status === 'reviewed' ? '已认可' : '待复核'}
              </Tag>
              <span style={{ color: COLORS.muted, fontSize: 9 }}>{item.occurred_at.slice(0, 10)}</span>
            </div>
            <div>{item.excerpt}</div>
            {item.rationale ? <div style={{ color: COLORS.muted, marginTop: 2 }}>{item.rationale}</div> : null}
            <div style={{ display: 'flex', gap: 8, marginTop: 3 }}>
              <button type="button" onClick={() => onReview(item.id, 'reviewed')} style={linkStyle}>认可</button>
              <button type="button" onClick={() => onReview(item.id, 'rejected')} style={{ ...linkStyle, color: COLORS.muted }}>驳回</button>
            </div>
          </div>
        ))}
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
        <section style={panelStyle}>
          <div style={sectionTitleStyle}>待确认问题</div>
          {facts.filter((fact) => fact.kind === 'open_question').map((fact) => (
            <div key={fact.id} style={lineStyle}>· {String(fact.value)}</div>
          ))}
          {episodes.flatMap((episode) => episode.open_questions).slice(0, 6).map((question) => (
            <div key={question} style={lineStyle}>· {question}</div>
          ))}
          {facts.length === 0 && episodes.length === 0 ? <Empty>暂无</Empty> : null}
        </section>
        <section style={panelStyle}>
          <div style={sectionTitleStyle}>最近整理</div>
          {episodes.slice(0, 4).map((episode) => (
            <div key={episode.id} style={{ ...lineStyle, whiteSpace: 'pre-wrap' }}>{episode.summary}</div>
          ))}
          {episodes.length === 0 ? <Empty>还没有会话摘要</Empty> : null}
        </section>
      </div>
    </div>
  )
}

export function App() {
  const [student, setStudent] = useState<StudentIdentity>()
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [sessionSummaries, setSessionSummaries] = useState<Record<string, SessionSummary>>({})
  const [citationLabels, setCitationLabels] = useState<Record<string, string>>({})
  const [kpNames, setKpNames] = useState<Record<string, string>>({})
  const [sessionId, setSessionId] = useState<string>()
  const [events, setEvents] = useState<ChatEvent[]>([])
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [ledger, setLedger] = useState<LedgerStatus>(EMPTY_LEDGER)
  const [newsStatus, setNewsStatus] = useState<NewsStatus>({ count: 0, newestFetchedAt: '' })
  const [snapshot, setSnapshot] = useState<LearningStateSnapshot>()
  const [suggestions, setSuggestions] = useState<LearningSuggestions>()
  const [turns, setTurns] = useState<TurnRow[]>([])
  const [profileData, setProfileData] = useState<ProfileData>()
  const [facts, setFacts] = useState<MemoryFact[]>([])
  const [episodes, setEpisodes] = useState<MemoryEpisode[]>([])
  const [memorySummary, setMemorySummary] = useState<MemorySummary>()
  const [attemptsByArtifact, setAttemptsByArtifact] = useState<Record<string, QuestionAttempt[]>>({})
  const [citations, setCitations] = useState<Citation[]>([])
  const [chapters, setChapters] = useState<Array<{ id: string; number: number; title: string }>>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [queue, setQueue] = useState<string[]>([])
  const [view, setView] = useState<'chat' | 'profile'>('chat')
  const [scopeOverride, setScopeOverride] = useState<Scope>()
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [tabs, setTabs] = useState<DocTab[]>([])
  const [activeTab, setActiveTab] = useState<string>()
  const layoutRef = useRef<HTMLDivElement | null>(null)
  const viewport = useViewportWidth(layoutRef)
  const [sidebarWidth, setSidebarWidth] = useState(() => readNumber(SIDEBAR_STORAGE_KEY, SIDEBAR_DEFAULT))
  const [workspacePref, setWorkspacePref] = useState<WorkspacePref>(readWorkspacePref)
  const [narrowExpanded, setNarrowExpanded] = useState(false)
  const [workspaceFullscreen, setWorkspaceFullscreen] = useState(false)
  const sidebarBaseRef = useRef(SIDEBAR_DEFAULT)
  const sidebarLiveRef = useRef(sidebarWidth)
  const workspaceBaseRef = useRef(WORKSPACE_MIN)
  const workspaceLiveRef = useRef(WORKSPACE_MIN)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [hasApiKey, setHasApiKey] = useState(false)
  const [apiKeySource, setApiKeySource] = useState<'env' | 'stored' | 'none'>('none')
  /** Settings file exists but is unparsable (e.g. saved with a BOM). */
  const [configError, setConfigError] = useState<string | undefined>(undefined)
  const [model, setModel] = useState('deepseek-chat')
  const [settingsSaved, setSettingsSaved] = useState('')
  const [notice, setNotice] = useState('')
  const [stream, setStream] = useState<{ requestId: string; text: string; step: string } | null>(null)
  /** 上一轮的实际执行轨迹（程序统计，去重后）。 */
  const [lastTrace, setLastTrace] = useState<TurnTrace | null>(null)

  const headerMenusRef = useRef<HTMLDivElement | null>(null)
  const queueRef = useRef<string[]>([])
  const busyRef = useRef(false)
  const sendRef = useRef<((text?: string) => Promise<void>) | undefined>(undefined)
  const studentId = student?.studentId
  const capabilities = window.learning.capabilities ?? { localFiles: true, revealFiles: true, downloadArtifacts: 'desktop' as const }

  const sidebarCollapsed = viewport < SIDEBAR_AUTO_COLLAPSE ? !narrowExpanded : sidebarWidth === 0
  const effectiveSidebar = sidebarCollapsed ? 0 : (sidebarWidth || SIDEBAR_DEFAULT)
  const workspaceWidth = 'ratio' in workspacePref ? Math.round(viewport * workspacePref.ratio) : workspacePref.px
  const workspaceOpen = view === 'chat' && tabs.length > 0 && !workspaceFullscreen
  const cols = computeColumns(viewport, effectiveSidebar, workspaceOpen ? workspaceWidth : 0)
  const workspaceMax = cols.workspace === 0 ? 0 : clampWidth(workspaceWidth, WORKSPACE_MIN, viewport * WORKSPACE_MAX_RATIO)
  const gridTemplateColumns = `${cols.sidebar}px minmax(${cols.workspace === 0 ? 0 : CENTER_MIN}px, 1fr) minmax(0px, ${workspaceMax}px)`
  const previousTabCount = useRef(tabs.length)

  useEffect(() => {
    const grew = tabs.length > previousTabCount.current
    previousTabCount.current = tabs.length
    if (grew && viewport > 0 && viewport < SIDEBAR_AUTO_COLLAPSE) setNarrowExpanded(false)
    if (tabs.length === 0 && workspaceFullscreen) setWorkspaceFullscreen(false)
  }, [tabs.length, viewport, workspaceFullscreen])

  const startSidebarDrag = () => {
    sidebarBaseRef.current = cols.sidebar > 0 ? cols.sidebar : SIDEBAR_DEFAULT
    sidebarLiveRef.current = sidebarBaseRef.current
  }

  const dragSidebar = (dx: number) => {
    const next = Math.round(clampWidth(sidebarBaseRef.current + dx, SIDEBAR_MIN, SIDEBAR_MAX))
    sidebarLiveRef.current = next
    setSidebarWidth(next)
  }

  const endSidebarDrag = () => {
    persistNumber(SIDEBAR_STORAGE_KEY, sidebarLiveRef.current)
  }

  const resetSidebar = () => {
    sidebarLiveRef.current = SIDEBAR_DEFAULT
    setSidebarWidth(SIDEBAR_DEFAULT)
    persistNumber(SIDEBAR_STORAGE_KEY, SIDEBAR_DEFAULT)
  }

  const toggleSidebar = () => {
    if (viewport < SIDEBAR_AUTO_COLLAPSE) {
      setNarrowExpanded((value) => !value)
      return
    }
    const next = sidebarWidth === 0 ? SIDEBAR_DEFAULT : 0
    sidebarLiveRef.current = next
    setSidebarWidth(next)
    persistNumber(SIDEBAR_STORAGE_KEY, next)
  }

  const startWorkspaceDrag = () => {
    workspaceBaseRef.current = cols.workspace
    workspaceLiveRef.current = cols.workspace
  }

  const dragWorkspace = (dx: number) => {
    const next = Math.round(clampWidth(workspaceBaseRef.current - dx, WORKSPACE_MIN, viewport * WORKSPACE_MAX_RATIO))
    workspaceLiveRef.current = next
    setWorkspacePref({ px: next })
  }

  const endWorkspaceDrag = () => {
    persistWorkspacePref({ px: workspaceLiveRef.current })
  }

  const resetWorkspace = () => {
    setWorkspacePref({ ratio: WORKSPACE_DEFAULT_RATIO })
    persistWorkspacePref({ ratio: WORKSPACE_DEFAULT_RATIO })
  }

  const refreshAll = useCallback(async (sid?: string) => {
    if (!studentId) return
    try {
      const [
        sessionList,
        artifactList,
        ledgerValue,
        profile,
        factList,
        episodeList,
        summary,
        chapterList,
        news,
        suggestionValue,
      ] = await Promise.all([
        window.learning.invoke('chat.sessions', { studentId }) as Promise<ChatSession[]>,
        window.learning.invoke('artifacts.list', { studentId, limit: 50 }) as Promise<Artifact[]>,
        window.learning.invoke('agent.ledger', { studentId }) as Promise<LedgerStatus>,
        window.learning.invoke('profile.get', { studentId }) as Promise<ProfileData>,
        window.learning.invoke('memory.facts', { studentId }) as Promise<MemoryFact[]>,
        window.learning.invoke('memory.episodes', { studentId, limit: 50 }) as Promise<MemoryEpisode[]>,
        window.learning.invoke('memory.summary', { studentId }) as Promise<MemorySummary>,
        window.learning.invoke('chapters.list', {}) as Promise<Array<{ id: string; number: number; title: string }>>,
        window.learning.invoke('news.status', {}) as Promise<NewsStatus>,
        window.learning.invoke('agent.suggestions', { studentId, sessionId: sid }) as Promise<LearningSuggestions>,
      ])
      setSessions(sessionList)
      setArtifacts(artifactList)
      setLedger(ledgerValue)
      setProfileData(profile)
      setFacts(factList)
      setEpisodes(episodeList)
      setMemorySummary(summary)
      setChapters(chapterList)
      setNewsStatus(news)
      setSuggestions(suggestionValue)
      try {
        const summaries = await window.learning.invoke('agent.sessions', { studentId }) as SessionSummary[]
        setSessionSummaries(Object.fromEntries(summaries.map((summary) => [summary.id, summary])))
      } catch {
        // 摘要接口可能不存在；左侧栏仍能用标题。
        setSessionSummaries({})
      }
      if (sid) {
        const [messageRows, snapshotValue, turnRows] = await Promise.all([
          window.learning.invoke('chat.messages', { sessionId: sid }) as Promise<ChatMessage[]>,
          window.learning.invoke('agent.snapshot', { studentId, sessionId: sid }) as Promise<LearningStateSnapshot>,
          window.learning.invoke('agent.turns', { sessionId: sid, limit: 100 }) as Promise<TurnRow[]>,
        ])
        const mapped = mapMessages(messageRows)
        setEvents(mapped)
        setSnapshot(snapshotValue)
        setTurns(turnRows)
        const latestCitations = lastPayload(mapped).citations ?? []
        setCitations(latestCitations)
        const unresolved = latestCitations.filter((citation) => {
          const name = citation.locator?.name ?? citation.locator?.title
          return typeof name !== 'string' || name.length === 0
        })
        if (unresolved.length > 0) {
          const resolved = await Promise.all(unresolved.map(async (citation) => {
            try {
              if (citation.sourceType === 'kp') {
                const kp = await window.learning.invoke('getKp', { kpId: citation.sourceId }) as { name?: string } | undefined
                return kp?.name ? [`${citation.sourceType}:${citation.sourceId}`, kp.name] as const : undefined
              }
              if (citation.sourceType === 'news') {
                const detail = await window.learning.invoke('news.get', { articleId: citation.sourceId }) as { article?: { title?: string } } | undefined
                return detail?.article?.title ? [`${citation.sourceType}:${citation.sourceId}`, detail.article.title] as const : undefined
              }
              if (citation.sourceType === 'textbook') {
                const detail = await window.learning.invoke('getBlock', { blockId: citation.sourceId }) as BlockDetail | undefined
                const chapter = detail?.chapter ? `第${detail.chapter.number}章 ${detail.chapter.title}` : ''
                const section = detail?.section?.title ?? ''
                const page = detail?.block.page ? `第${detail.block.page}页` : ''
                const label = ['教材', chapter, section, page].filter((item) => item.length > 0).join(' · ')
                return label ? [`${citation.sourceType}:${citation.sourceId}`, label] as const : undefined
              }
              if (citation.sourceType === 'resource') {
                const detail = await window.learning.invoke('getResource', { resourceId: citation.sourceId }) as ResourceDetail | undefined
                if (!detail?.guide) return undefined
                const label = detail.chapter ? `教材资源 · 第${detail.chapter.number}章 ${detail.chapter.title}` : '教材资源'
                return [`${citation.sourceType}:${citation.sourceId}`, label] as const
              }
            } catch {
              // Keep the generic type label when the source is unavailable.
            }
            return undefined
          }))
          const labels = Object.fromEntries(resolved.filter((item) => item !== undefined))
          if (Object.keys(labels).length > 0) {
            setCitationLabels((current) => ({ ...current, ...labels }))
          }
        }
      } else {
        setEvents([])
        setSnapshot(undefined)
        setTurns([])
        setCitations([])
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }, [studentId])

  useEffect(() => {
    void window.learning.invoke('student.current', {}).then((value) => {
      setStudent(value as StudentIdentity)
    })
  }, [])

  useEffect(() => {
    if (!studentId) return
    void refreshAll(sessionId)
  }, [studentId, refreshAll])

  // 两个浮层都要能关：点外面、按 Esc、或打开另一个时自动关。
  useEffect(() => {
    if (!contextOpen && !scopeMenuOpen) return
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target
      if (headerMenusRef.current && target instanceof Node && headerMenusRef.current.contains(target)) return
      setContextOpen(false)
      setScopeMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setContextOpen(false)
        setScopeMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [contextOpen, scopeMenuOpen])

  // 本轮执行进度：先显示"在读什么"，再逐字出正文。
  useEffect(() => {
    const unsubscribe = window.learning.onChatEvent?.((payload) => {
      const item = payload as ChatStreamEvent
      setStream((current) => {
        if (!current || current.requestId !== item.requestId) return current
        if (item.type === 'tool') {
          // 负责人已经吐过字又决定继续查资料：收回这段，避免半截话上屏。
          const reset = item.agent === 'lead' ? '' : current.text
          return { ...current, text: reset, step: TOOL_LABEL[item.tool ?? ''] ?? '查资料' }
        }
        if (item.type === 'text' && item.agent === 'lead') {
          return { ...current, text: current.text + (item.text ?? ''), step: '' }
        }
        if (item.type === 'round' && item.agent === 'lead' && current.step === '') {
          return { ...current, step: '正在组织回答…' }
        }
        return current
      })
    })
    return () => { unsubscribe?.() }
  }, [])

  useEffect(() => {
    if (!settingsOpen) return
    void window.learning.settings.get().then((value) => {
      setApiKey('')
      setHasApiKey(value.hasApiKey)
      setApiKeySource(value.apiKeySource ?? 'none')
      setConfigError(value.configError)
      setModel(value.model)
    })
  }, [settingsOpen])

  const loadAttempts = useCallback(async (artifact: Artifact) => {
    if (!studentId || artifact.type !== 'question_set') return
    const content = artifact.content_json as { questions?: Array<{ id?: string }> } | null
    const questionIds = (content?.questions ?? [])
      .map((question) => question.id)
      .filter((id): id is string => typeof id === 'string')
    if (questionIds.length === 0) return
    try {
      const rows = await window.learning.invoke('questions.attempts', { studentId, questionIds }) as QuestionAttempt[]
      setAttemptsByArtifact((current) => ({ ...current, [artifact.id]: rows }))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }, [studentId])

  const openTab = useCallback((kind: DocKind, title = docTitle(kind)) => {
    setTabs((current) => current.some((tab) => tab.id === kind)
      ? current
      : [...current, { id: kind, kind, title }])
    setActiveTab(kind)
  }, [])

  const openArtifact = useCallback((artifact: Artifact) => {
    const id = `artifact:${artifact.id}`
    setTabs((current) => current.some((tab) => tab.id === id)
      ? current
      : [...current, { id, kind: 'artifact', title: artifactTabTitle(artifact), artifactId: artifact.id }])
    setActiveTab(id)
    void loadAttempts(artifact)
  }, [loadAttempts])

  const openTextbook = useCallback(async (sourceId: string, quote: string): Promise<boolean> => {
    try {
      const detail = await window.learning.invoke('getBlock', { blockId: sourceId }) as BlockDetail | undefined
      if (!detail?.block) {
        setNotice('原文无法定位：教材块不存在，旧引用需复核。已打开依据列表。')
        return false
      }
      if (!locateSpan(detail.block.text, quote)) {
        setNotice('原文无法定位：这条引用与教材原文不一致，旧引用需复核。已打开依据列表。')
        return false
      }
      const source: SourceDetail = { kind: 'textbook', quote, ...detail }
      const id = `source:textbook:${sourceId}`
      setTabs((current) => {
        const next = { id, kind: 'source' as const, title: sourceTabTitle(source), source }
        return current.some((tab) => tab.id === id)
          ? current.map((tab) => (tab.id === id ? { ...tab, ...next } : tab))
          : [...current, next]
      })
      setActiveTab(id)
      return true
    } catch {
      setNotice('教材原文暂时无法读取，旧引用需复核。已打开依据列表。')
      return false
    }
  }, [])

  const openResource = useCallback(async (sourceId: string, quote: string): Promise<boolean> => {
    try {
      const detail = await window.learning.invoke('getResource', { resourceId: sourceId }) as ResourceDetail | undefined
      if (!detail?.guide) {
        setNotice('原文无法定位：教材资源不存在，旧引用需复核。已打开依据列表。')
        return false
      }
      if (!locateSpan(guideText(detail.guide), quote)) {
        setNotice('原文无法定位：这条引用与教材资源不一致，旧引用需复核。已打开依据列表。')
        return false
      }
      const source: SourceDetail = { kind: 'resource', quote, ...detail }
      const id = `source:resource:${sourceId}`
      setTabs((current) => {
        const next = { id, kind: 'source' as const, title: sourceTabTitle(source), source }
        return current.some((tab) => tab.id === id)
          ? current.map((tab) => (tab.id === id ? { ...tab, ...next } : tab))
          : [...current, next]
      })
      setActiveTab(id)
      return true
    } catch {
      setNotice('教材资源暂时无法读取，旧引用需复核。已打开依据列表。')
      return false
    }
  }, [])

  const openCitation = useCallback(async (citation: Citation) => {
    if (citation.sourceType === 'textbook') {
      if (!(await openTextbook(citation.sourceId, citation.quote))) openTab('evidence')
      return
    }
    if (citation.sourceType === 'resource') {
      if (!(await openResource(citation.sourceId, citation.quote))) openTab('evidence')
      return
    }
    if (citation.sourceType === 'news') {
      try {
        const detail = await window.learning.invoke('news.get', { articleId: citation.sourceId }) as NewsDetail | undefined
        if (detail) {
          if (!locateSpan(detail.article.content, citation.quote)) {
            setNotice('原文无法定位：这条引用与新闻正文不一致，旧引用需复核。已打开依据列表。')
            openTab('evidence')
            return
          }
          const resolvedMatches = await Promise.all(detail.matches.map(async (match) => {
            try {
              const kp = await window.learning.invoke('getKp', { kpId: match.kp_id }) as { name?: string } | undefined
              return kp?.name ? { ...match, kpName: kp.name } : match
            } catch {
              return match
            }
          }))
          const names = Object.fromEntries(resolvedMatches
            .filter((match) => match.kpName)
            .map((match) => [match.kp_id, match.kpName as string]))
          if (Object.keys(names).length > 0) setKpNames((current) => ({ ...current, ...names }))
          const news: NewsDetail = { ...detail, matches: resolvedMatches }
          const id = `news:${citation.sourceId}`
          setTabs((current) => current.some((tab) => tab.id === id)
            ? current
            : [...current, { id, kind: 'news', title: '新闻原文', news }])
          setActiveTab(id)
          return
        }
        setNotice('原文无法定位：新闻不在库中，旧引用需复核。已打开依据列表。')
      } catch {
        setNotice('新闻原文暂时无法读取，旧引用需复核。已打开依据列表。')
      }
    }
    openTab('evidence')
  }, [openResource, openTab, openTextbook])

  const openLocalFile = useCallback(async () => {
    try {
      const file = await window.learning.invoke('files.openDialog', {}) as DocTab['file']
      if (!file) return
      const id = `file:${file.path}`
      setTabs((current) => current.some((tab) => tab.id === id)
        ? current
        : [...current, { id, kind: 'file', title: file.name, file }])
      setActiveTab(id)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const send = useCallback(async (prompt?: string) => {
    const text = (prompt ?? draft).trim()
    if (text.length === 0 || !studentId) return
    if (busyRef.current) {
      queueRef.current = [...queueRef.current, text]
      setQueue([...queueRef.current])
      setDraft('')
      return
    }
    busyRef.current = true
    setBusy(true)
    setDraft('')
    setNotice('')
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    setStream({ requestId, text: '', step: '正在判断这一句该怎么接…' })
    setEvents((current) => [...current, {
      id: `local_${Date.now()}`,
      session_id: sessionId ?? '',
      role: 'user',
      content: text,
      evidence_count: 0,
      created_at: new Date().toISOString(),
      seq: 0,
      turn_id: '',
      kind: 'user_message',
      payload: {},
    }])
    try {
      const result = await window.learning.chat({
        studentId,
        sessionId,
        message: text,
        scopeOverride,
        requestId,
      }) as TurnResponse
      setLastTrace(result.trace ?? null)
      setSessionId(result.sessionId)
      setScopeOverride(undefined)
      await refreshAll(result.sessionId)
      const questionSet = result.artifacts.find((artifact) => artifact.type === 'question_set')
      const caseLesson = result.plan.steps.some((step) => step.agent === 'case')
        ? result.artifacts.find((artifact) => artifact.type === 'case_study')
        : undefined
      const pageArtifact = result.artifacts.find((artifact) => artifact.type === 'page')
      if (questionSet) openArtifact(questionSet)
      else if (caseLesson) openArtifact(caseLesson)
      else if (pageArtifact) openArtifact(pageArtifact)
      if (!questionSet && !caseLesson && !pageArtifact
        && (result.citations.length > 0 || result.plan.steps.some((step) => step.agent === 'knowledge'))) {
        openTab('evidence')
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
      await refreshAll(sessionId)
    } finally {
      busyRef.current = false
      setBusy(false)
      setStream(null)
      const next = queueRef.current.shift()
      setQueue([...queueRef.current])
      if (next) {
        setTimeout(() => { void sendRef.current?.(next) }, 0)
      }
    }
  }, [draft, openArtifact, openTab, refreshAll, scopeOverride, sessionId, studentId])
  sendRef.current = send

  const handleAnswerSet = useCallback(async (artifactId: string, answers: Array<{ questionId: string; answer: string }>): Promise<SetSubmissionStatus> => {
    if (!studentId || !sessionId) return 'failed'
    try {
      const result = await window.learning.answerSet({
        studentId,
        sessionId,
        artifactId,
        answers,
        chapterId: snapshot?.scope.chapterId,
      }) as AnswerSetResponse
      await refreshAll(sessionId)
      const artifact = artifacts.find((item) => item.id === artifactId)
      if (artifact) await loadAttempts(artifact)
      const status: SetSubmissionStatus = result.status ?? 'completed'
      if (status === 'failed') {
        setNotice(result.text || '这次交卷没有成功，答案没有被计为错误，请重试。')
        return 'failed'
      }
      const graded = result.results.filter((item) => typeof item.correct === 'boolean')
      const correct = graded.filter((item) => item.correct === true).length
      if (status === 'partial') {
        setNotice(`部分交卷：${correct}/${graded.length} 题已判，未判成功的题可保留答案重试；已判题不会重复提交。`)
        return 'partial'
      }
      setNotice(`已交卷：${correct}/${graded.length} 题正确`)
      return 'completed'
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
      return 'failed'
    }
  }, [artifacts, loadAttempts, refreshAll, sessionId, snapshot?.scope.chapterId, studentId])

  const reviewEvidence = useCallback(async (evidenceId: string, status: 'reviewed' | 'rejected') => {
    if (!studentId) return
    try {
      await window.learning.invoke('profile.review', {
        studentId,
        evidenceId,
        status,
        note: status === 'rejected' ? '学生标记为不认可' : '学生确认',
      })
      await refreshAll(sessionId)
      setNotice(status === 'reviewed' ? '已认可这条证据' : '已驳回这条证据')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }, [refreshAll, sessionId, studentId])

  const recordCheckpoint = useCallback(async (checkpoint: 'pre' | 'post') => {
    if (!studentId) return
    try {
      await window.learning.invoke('profile.snapshot', {
        studentId,
        chapterId: snapshot?.scope.chapterId ?? '',
        checkpoint,
      })
      await refreshAll(sessionId)
      setNotice(`已记录${checkpoint === 'pre' ? '前测' : '后测'}快照`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }, [refreshAll, sessionId, snapshot?.scope.chapterId, studentId])

  const exportArtifact = useCallback(async (artifact: Artifact, format: 'md' | 'docx' | 'html') => {
    try {
      if (capabilities.downloadArtifacts === 'browser' && window.learning.downloadArtifact) {
        const result = await window.learning.downloadArtifact(artifact.id, format)
        setNotice(`已下载：${result.filename}`)
        return
      }
      const result = await window.learning.invoke('artifacts.export', { artifactId: artifact.id, format }) as { path: string }
      setNotice(`已导出：${result.path}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }, [capabilities.downloadArtifacts])

  const refreshNews = useCallback(async () => {
    try {
      const result = await window.learning.invoke('news.refresh', {}) as NewsRefreshResult
      const errors = result.results.reduce((sum, item) => sum + item.errors, 0)
      setNotice(errors > 0
        ? `新闻已刷新：${result.count} 条；${errors} 个抓取错误，旧数据已保留`
        : `新闻已刷新：${result.count} 条`)
      await refreshAll(sessionId)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }, [refreshAll, sessionId])

  const retryLedger = useCallback(async (sourceId: string) => {
    if (!studentId) return
    try {
      await window.learning.invoke('agent.retry', { studentId, sourceId })
      await refreshAll(sessionId)
      setNotice('记录 Agent 已重试整理')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }, [refreshAll, sessionId, studentId])

  const newChat = () => {
    setSessionId(undefined)
    setEvents([])
    setSnapshot(undefined)
    setTurns([])
    setCitations([])
    setTabs([])
    setActiveTab(undefined)
    setScopeOverride(undefined)
    setDraft('')
    setView('chat')
    if (studentId) {
      void window.learning.invoke('agent.suggestions', { studentId }).then((value) => {
        setSuggestions(value as LearningSuggestions)
      })
    }
  }

  const loadSession = async (session: ChatSession) => {
    setSessionId(session.id)
    setView('chat')
    setTabs([])
    setActiveTab(undefined)
    setScopeOverride(undefined)
    await refreshAll(session.id)
  }

  const saveSettings = async () => {
    const value = await window.learning.settings.set({
      ...(apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {}),
      model,
    })
    setApiKey('')
    setHasApiKey(value.hasApiKey)
    setApiKeySource(value.apiKeySource ?? 'none')
    setConfigError(value.configError)
    setModel(value.model)
    setSettingsSaved(value.apiKeySource === 'env'
      ? '已保存；当前生效的是环境变量 DEEPSEEK_API_KEY'
      : '已保存')
  }

  const clearApiKey = async () => {
    const value = await window.learning.settings.set({ clearApiKey: true })
    setApiKey('')
    setHasApiKey(value.hasApiKey)
    setApiKeySource(value.apiKeySource ?? 'none')
    setConfigError(value.configError)
    setSettingsSaved(value.apiKeySource === 'env'
      ? '已清除本机保存的 Key；环境变量 DEEPSEEK_API_KEY 仍在生效'
      : '已清除本机 Key')
  }

  const displayScope = scopeOverride ?? snapshot?.scope
  const activeEvidence = profileData?.evidence ?? []

  const renderAssistant = (event: ChatEvent) => {
    const payload = event.payload
    const plan = payload.plan
    const produced = (payload.artifactIds ?? [])
      .map((id) => artifacts.find((artifact) => artifact.id === id))
      .filter((artifact): artifact is Artifact => artifact !== undefined)
    const feedback = payload.feedback
    const meta = scopeText(plan?.scope ?? displayScope)
    return (
      <div key={event.id} data-message-role="assistant" style={{ display: 'flex', alignItems: 'flex-start', gap: 10, maxWidth: 820 }}>
        <div style={{ width: 26, height: 26, flex: '0 0 26px', borderRadius: 8, background: '#edf4f1', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
          <BrandMark size={15} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap', marginBottom: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 650 }}>营小商</span>
            <span style={{ fontSize: 10.5, color: COLORS.muted }}>{meta}</span>
            {feedback ? (
              <span style={{ fontSize: 10.5, color: feedback.correct ? COLORS.success : COLORS.warning }}>
                {feedback.correct ? '答对' : '再看看'}
              </span>
            ) : null}
          </div>
          <MarkdownView text={event.content} />
          {feedback ? <FeedbackDetails feedback={feedback} /> : null}
          {payload.warnings && payload.warnings.length > 0 ? (
            <div style={{ marginTop: 7, fontSize: 11, color: COLORS.warning, lineHeight: 1.7 }}>
              {payload.warnings.map((warning, index) => <div key={index}>提示：{warning}</div>)}
            </div>
          ) : null}
          {payload.citations && payload.citations.length > 0 ? (
            <button
              type="button"
              onClick={() => void openCitation(payload.citations![0]!)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: 'none', background: 'transparent', color: COLORS.muted, padding: 0, marginTop: 7, fontSize: 11, cursor: 'pointer' }}
            >
              <EvidenceIcon size={13} />
              依据 {payload.citations.length} 条
            </button>
          ) : null}
          {produced.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 9, maxWidth: 420 }}>
              {produced.map((artifact) => (
                <button
                  key={artifact.id}
                  type="button"
                  onClick={() => openArtifact(artifact)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    textAlign: 'left',
                    border: `1px solid ${COLORS.border}`,
                    background: 'var(--surface)',
                    borderRadius: 10,
                    padding: '7px 9px',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ width: 24, height: 24, flex: '0 0 24px', borderRadius: 7, background: '#f1f4f3', display: 'flex', alignItems: 'center', justifyContent: 'center', color: COLORS.accent }}>
                    <ArtifactIcon type={artifact.type} size={14} />
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }} title={artifact.title}>
                    <span style={{ display: 'block', fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{artifactTabTitle(artifact)}</span>
                    <span style={{ display: 'block', fontSize: 10, color: COLORS.muted, marginTop: 1 }}>
                      {artifactTypeLabel(artifact.type)}
                    </span>
                  </span>
                  <ChevronRightIcon size={14} style={{ color: COLORS.muted }} />
                </button>
              ))}
            </div>
          ) : null}
          {payload.asks && payload.asks.length > 0 ? <QuickAsks asks={payload.asks} onSend={(text) => void send(text)} /> : null}
          {payload.checkQuestion ? (
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 12, color: COLORS.muted, lineHeight: 1.7 }}>
              <SparkIcon size={13} style={{ marginTop: 3, flex: '0 0 13px' }} />
              <span>想一想：{payload.checkQuestion}</span>
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div
      ref={layoutRef}
      style={{
        display: 'grid',
        gridTemplateColumns,
        gridTemplateRows: 'minmax(0, 1fr)',
        height: '100%',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <aside style={{ width: '100%', minWidth: 0, overflow: 'hidden', background: '#fbfbfa', borderRight: sidebarCollapsed ? 'none' : `1px solid ${COLORS.border}`, display: 'flex', flexDirection: 'column', padding: sidebarCollapsed ? 0 : '14px 9px 9px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px 14px' }}>
          <div style={{ width: 28, height: 28, borderRadius: 9, background: '#edf4f1', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <BrandMark size={17} />
          </div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>营小商</div>
        </div>
        <button
          type="button"
          onClick={newChat}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%', border: 'none', background: COLORS.accent, color: 'var(--on-accent, #fff)', borderRadius: 9, padding: '8px 10px', fontSize: 12, cursor: 'pointer' }}
        >
          <PlusIcon size={14} />
          新对话
        </button>
        <div style={{ marginTop: 15, fontSize: 10.5, color: COLORS.muted, padding: '0 8px' }}>最近对话</div>
        <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 1, maxHeight: 330, overflow: 'auto' }}>
          {sessions.map((session) => {
            const summary = sessionSummaries[session.id]
            const status = summary?.status ? SESSION_STATUS_LABEL[summary.status] : undefined
            const statusTone: 'neutral' | 'accent' | 'success' | 'warning' = summary?.status === 'awaiting_confirmation'
              ? 'warning'
              : summary?.status === 'new_artifact'
                ? 'accent'
                : summary?.status === 'organized'
                  ? 'success'
                  : 'neutral'
            const chapter = summary?.chapterTitle || chapterText(session.chapter_id, chapters)
            return (
              <button
                key={session.id}
                type="button"
                onClick={() => void loadSession(session)}
                style={{
                  textAlign: 'left',
                  border: 'none',
                  borderRadius: 7,
                  padding: '6px 8px',
                  cursor: 'pointer',
                  background: sessionId === session.id ? 'color-mix(in srgb, var(--accent) 7%, transparent)' : 'transparent',
                  color: COLORS.text,
                  fontSize: 11.5,
                  lineHeight: 1.45,
                }}
              >
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: sessionId === session.id ? 600 : 400 }}>{session.title || '未命名对话'}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2, minWidth: 0 }}>
                  <span style={{ color: COLORS.muted, fontSize: 9, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{chapter}</span>
                  {status ? <Tag tone={statusTone}>{status}</Tag> : null}
                  {summary?.lastTurnAt ? <span style={{ color: COLORS.muted, fontSize: 8.5, marginLeft: 'auto', flex: '0 0 auto' }}>{summary.lastTurnAt.slice(5, 16).replace('T', ' ')}</span> : null}
                </div>
              </button>
            )
          })}
          {sessions.length === 0 ? <div style={{ padding: '6px 8px', color: COLORS.muted, fontSize: 11 }}>还没有对话</div> : null}
        </div>
        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            onClick={() => setView('profile')}
            style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left', border: 'none', background: 'transparent', padding: '7px 8px', borderRadius: 7, cursor: 'pointer', color: COLORS.text, fontSize: 11.5 }}
          >
            <DocIcon size={14} />
            学习档案
          </button>
        </div>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          style={{ border: 'none', background: 'transparent', color: COLORS.muted, borderRadius: 7, padding: '7px 8px', cursor: 'pointer', fontSize: 11.5, textAlign: 'left' }}
        >
          设置
        </button>
      </aside>

      <main style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {view === 'profile' ? (
          <ProfileView
            student={student}
            profileData={profileData}
            evidence={activeEvidence}
            facts={facts}
            episodes={episodes}
            memorySummary={memorySummary}
            ledger={ledger}
            snapshot={snapshot}
            onBack={() => setView('chat')}
            onReview={(id, status) => void reviewEvidence(id, status)}
            onRecordCheckpoint={(checkpoint) => void recordCheckpoint(checkpoint)}
          />
        ) : (
          <>
            <header style={{ padding: '10px 22px 8px', borderBottom: `1px solid ${COLORS.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <button
                  type="button"
                  aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
                  title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
                  onClick={toggleSidebar}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 26px', border: 'none', background: 'transparent', color: COLORS.muted, borderRadius: 7, width: 26, height: 26, padding: 0, cursor: 'pointer' }}
                >
                  <ChevronRightIcon size={15} style={{ transform: sidebarCollapsed ? 'none' : 'rotate(180deg)', transition: 'transform 120ms ease' }} />
                </button>
                <h1 style={{ fontSize: 16, margin: 0, fontWeight: 650 }}>营小商</h1>
              </div>
              <div ref={headerMenusRef} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <div style={{ position: 'relative' }}>
                  <button
                    type="button"
                    title="调整章节"
                    onClick={() => { setContextOpen(false); setScopeMenuOpen((value) => !value) }}
                    style={{ display: 'flex', alignItems: 'center', gap: 4, border: 'none', background: 'transparent', borderRadius: 999, padding: '3px 7px', fontSize: 11, cursor: 'pointer', color: COLORS.muted }}
                  >
                    <span>{scopeText(displayScope)}</span>
                    <ChevronDownIcon size={12} />
                  </button>
                  {scopeMenuOpen ? (
                    <div style={{ position: 'absolute', right: 0, top: 27, width: 230, maxHeight: 320, overflow: 'auto', background: '#fff', border: `1px solid ${COLORS.border}`, borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', padding: 5, zIndex: 30 }}>
                      <button type="button" onClick={() => { setScopeOverride(undefined); setScopeMenuOpen(false) }} style={menuStyle}>自动判断</button>
                      {chapters.map((chapter) => (
                        <button
                          key={chapter.id}
                          type="button"
                          onClick={() => {
                            setScopeOverride({
                              chapterId: chapter.id,
                              chapterTitle: chapter.title,
                              topicIds: [],
                              source: 'explicit',
                              confidence: 'high',
                            })
                            setScopeMenuOpen(false)
                          }}
                          style={menuStyle}
                        >
                          第{chapter.number}章 {chapter.title}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div style={{ position: 'relative' }}>
                  <button
                    type="button"
                    aria-label="上下文"
                    title="查看本轮自动传入的上下文"
                    onClick={() => { setScopeMenuOpen(false); setContextOpen((value) => !value) }}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'transparent', color: COLORS.muted, borderRadius: 7, width: 26, height: 26, cursor: 'pointer' }}
                  >
                    <LayersIcon size={15} />
                  </button>
                  {contextOpen ? (
                    <div style={{ position: 'absolute', right: 0, top: 27, width: 264, maxHeight: 360, overflow: 'auto', background: '#fff', border: `1px solid ${COLORS.border}`, borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', padding: 10, zIndex: 35 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 7 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: COLORS.muted }}>本轮实际读到的材料</span>
                        <button
                          type="button"
                          aria-label="关闭"
                          onClick={() => setContextOpen(false)}
                          style={{ border: 'none', background: 'transparent', color: COLORS.muted, cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0 }}
                        >
                          ×
                        </button>
                      </div>
                      {[
                        ['章节', scopeText(displayScope)],
                        ['模型调用', lastTrace ? `${lastTrace.modelCalls} 次` : '—'],
                        ['工具调用', lastTrace ? `${lastTrace.toolCalls} 次` : '—'],
                        ['教材原文', lastTrace ? `${lastTrace.reads.blocks} 段（已去重）` : '—'],
                        ['引用', lastTrace ? `${lastTrace.citations} 条` : '—'],
                        ['累计轮次', String(snapshot?.session.turns ?? 0)],
                        ['证据', `${snapshot?.evidence.count ?? 0} 条`],
                        ['最近产物', snapshot?.artifacts.recent_types.map(artifactTypeLabel).join(' / ') || '无'],
                      ].map(([label, value]) => (
                        <div key={label} style={{ display: 'flex', gap: 8, fontSize: 11, lineHeight: 1.65, padding: '3px 0' }}>
                          <span style={{ width: 60, flex: '0 0 60px', color: COLORS.muted }}>{label}</span>
                          <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{value}</span>
                        </div>
                      ))}
                      {lastTrace && lastTrace.reads.kps.length > 0 ? (
                        <div style={{ marginTop: 6, paddingTop: 6, borderTop: `1px solid ${COLORS.border}`, fontSize: 10.5, color: COLORS.muted, lineHeight: 1.6 }}>
                          读过知识点（{lastTrace.reads.kps.length}）：{lastTrace.reads.kps.join('、')}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  aria-label="任务概览"
                  title="任务概览"
                  onClick={() => openTab('overview')}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'transparent', color: COLORS.muted, borderRadius: 7, width: 26, height: 26, cursor: 'pointer' }}
                >
                  <DocIcon size={15} />
                </button>
              </div>
            </header>

            <div style={{ flex: 1, overflow: 'auto', padding: '18px 22px' }}>
              <div style={{ width: '100%', maxWidth: 'clamp(680px, 64%, 920px)', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 13 }}>
              {events.length === 0 ? (
                <div style={{ maxWidth: 600, margin: '48px auto', textAlign: 'center' }}>
                  <EmptyChatArt width={210} />
                  <div style={{ fontSize: 17, color: COLORS.text, fontWeight: 650, marginTop: 4 }}>
                    {suggestions?.title ?? '今天想解决什么？'}
                  </div>
                  <div style={{ color: COLORS.muted, fontSize: 12, lineHeight: 1.8, marginTop: 6 }}>
                    {suggestions?.description ?? '直接说。章节和下一步由营小商判断，不确定时只问一个必要问题。'}
                  </div>
                  <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', justifyContent: 'center', marginTop: 16 }}>
                    {(suggestions?.items?.length ? suggestions.items : SUGGESTIONS.map((prompt) => ({ label: prompt, prompt }))).map((item) => (
                      <button
                        key={item.prompt}
                        type="button"
                        onClick={() => void send(item.prompt)}
                        style={{ border: `1px solid ${COLORS.border}`, background: 'var(--surface)', borderRadius: 999, padding: '6px 11px', fontSize: 11.5, color: COLORS.text, cursor: 'pointer' }}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : events.map((event) => {
                if (event.role === 'user') {
                  return (
                    <div key={event.id} data-message-role="user" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <div style={{ maxWidth: '72%', background: '#f1f3f2', borderRadius: 14, padding: '8px 12px', fontSize: 13, lineHeight: 1.75 }}>
                        {event.kind === 'answer_submitted' ? <div style={{ fontSize: 10, color: COLORS.muted, marginBottom: 2 }}>作答</div> : null}
                        {event.content}
                      </div>
                    </div>
                  )
                }
                return renderAssistant(event)
              })}
              {busy ? (
                stream && stream.text.trim().length > 0 ? (
                  <div data-message-role="assistant" data-streaming="true" style={{ display: 'flex', alignItems: 'flex-start', gap: 10, maxWidth: 820 }}>
                    <div style={{ width: 26, height: 26, flex: '0 0 26px', borderRadius: 8, background: '#edf4f1', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
                      <BrandMark size={15} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginBottom: 4 }}>
                        <span style={{ fontSize: 12, fontWeight: 650 }}>营小商</span>
                        <span style={{ fontSize: 10.5, color: COLORS.muted }}>正在作答</span>
                      </div>
                      <MarkdownView text={stream.text} />
                    </div>
                  </div>
                ) : (
                  <div style={{ color: COLORS.muted, fontSize: 11.5, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <ClockIcon size={13} />
                    <span>{stream?.step || '正在判断并整理…'}</span>
                  </div>
                )
              ) : null}
              {notice ? <div style={{ color: COLORS.warning, fontSize: 11, lineHeight: 1.6 }}>{notice}</div> : null}
              </div>
            </div>

            <div style={{ padding: '10px 22px 14px' }}>
              <div style={{ width: '100%', maxWidth: 'clamp(680px, 64%, 920px)', margin: '0 auto' }}>
              {queue.length > 0 ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6, fontSize: 10.5, color: COLORS.muted }}>
                  <span>排队 {queue.length}</span>
                  {queue.map((item, index) => (
                    <span key={`${item}-${index}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#f3f4f3', borderRadius: 999, padding: '1px 7px' }}>
                      {item.slice(0, 16)}{item.length > 16 ? '…' : ''}
                      <button
                        type="button"
                        onClick={() => {
                          queueRef.current = queueRef.current.filter((_, queueIndex) => queueIndex !== index)
                          setQueue([...queueRef.current])
                        }}
                        style={{ border: 'none', background: 'transparent', color: COLORS.muted, cursor: 'pointer', fontSize: 10, padding: 0 }}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              <div style={{ border: `1px solid ${COLORS.border}`, background: 'var(--surface)', borderRadius: 12, padding: '8px 10px 6px' }}>
                <textarea
                  value={draft}
                  rows={2}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      void send()
                    }
                  }}
                  placeholder="说说你现在想解决什么…"
                  style={{ width: '100%', resize: 'none', border: 'none', outline: 'none', padding: 0, fontSize: 13, lineHeight: 1.65, fontFamily: 'inherit', boxSizing: 'border-box', background: 'transparent' }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                  <span style={{ color: COLORS.muted, fontSize: 10 }}>Enter 发送 · Shift+Enter 换行</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: COLORS.muted, fontSize: 10 }}>{scopeText(displayScope)}</span>
                    <button
                      type="button"
                      disabled={draft.trim().length === 0}
                      onClick={() => void send()}
                      aria-label={busy ? '排队' : '发送'}
                      style={{ display: 'flex', alignItems: 'center', gap: 4, border: 'none', background: COLORS.accent, color: 'var(--on-accent, #fff)', borderRadius: 8, padding: '5px 9px', fontSize: 11, cursor: draft.trim().length === 0 ? 'default' : 'pointer', opacity: draft.trim().length === 0 ? 0.45 : 1 }}
                    >
                      <SendIcon size={13} />
                      {busy ? '排队' : '发送'}
                    </button>
                  </div>
                </div>
              </div>
              </div>
            </div>
          </>
        )}
      </main>

      {!sidebarCollapsed && !workspaceFullscreen ? (
        <DragHandle
          side="sidebar"
          left={cols.sidebar}
          onStart={startSidebarDrag}
          onDrag={dragSidebar}
          onEnd={endSidebarDrag}
          onReset={resetSidebar}
        />
      ) : null}

      {workspaceOpen && cols.workspace > 0 ? (
        <DragHandle
          side="workspace"
          left={viewport - cols.workspace}
          onStart={startWorkspaceDrag}
          onDrag={dragWorkspace}
          onEnd={endWorkspaceDrag}
          onReset={resetWorkspace}
        />
      ) : null}

      {view === 'chat' && tabs.length > 0 ? (
        <Workspace
          fullscreen={workspaceFullscreen}
          onToggleFullscreen={() => setWorkspaceFullscreen((value) => !value)}
          tabs={tabs}
          activeId={activeTab}
          artifacts={artifacts}
          attemptsByArtifact={attemptsByArtifact}
          citations={citations}
          citationLabels={citationLabels}
          kpNames={kpNames}
          capabilities={capabilities}
          chapters={chapters}
          ledger={ledger}
          newsStatus={newsStatus}
          snapshot={snapshot}
          turns={turns}
          onActivate={setActiveTab}
          onClose={(id) => {
            setTabs((current) => current.filter((tab) => tab.id !== id))
            if (activeTab === id) setActiveTab(tabs.find((tab) => tab.id !== id)?.id)
          }}
          onNew={(kind) => openTab(kind)}
          onOpenLocal={() => void openLocalFile()}
          onOpenArtifact={openArtifact}
          onOpenCitation={(citation) => void openCitation(citation)}
          onSubmitSet={handleAnswerSet}
          onExport={(artifact, format) => void exportArtifact(artifact, format)}
          onReveal={(path) => { void window.learning.invoke('files.reveal', { path }) }}
          onRetryLedger={(sourceId) => void retryLedger(sourceId)}
          onRefreshNews={() => void refreshNews()}
          onQuote={(text) => setDraft((current) => `${current}${current ? '\n' : ''}引用：「${text}」\n`)}
        />
      ) : null}

      {settingsOpen ? (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.28)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}>
          <div style={{ width: 420, background: '#fff', borderRadius: 14, padding: 22, boxShadow: '0 20px 60px rgba(0,0,0,0.18)' }}>
            <h2 style={{ margin: 0, fontSize: 16 }}>设置</h2>
            <p style={{ color: COLORS.muted, fontSize: 12, margin: '6px 0 16px' }}>
              Key 只保存在本机应用数据目录，不会回传到页面或写入仓库。
              {apiKeySource === 'env'
                ? ' 当前生效的是环境变量 DEEPSEEK_API_KEY；这里只能清除本机保存的 Key，不能清除环境变量。'
                : hasApiKey ? ' 当前已配置，留空保存会保留原 Key。' : ' 当前未配置。'}
            </p>
            {configError ? (
              <p style={{ margin: '0 0 14px', padding: '8px 10px', borderRadius: 8, background: '#fdecec', color: '#a33', fontSize: 12, lineHeight: 1.5 }}>
                本机配置文件读不出来，已忽略：{configError}
                <br />
                在这里填一次 Key 点保存就会覆盖掉坏文件，不用手动改。
              </p>
            ) : null}
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: COLORS.muted }}>
              DEEPSEEK_API_KEY
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={apiKeySource === 'env'
                  ? '环境变量已配置；本机 Key 不会覆盖它'
                  : hasApiKey ? '已配置，输入新 Key 可替换' : 'sk-...'}
                style={{ border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '8px 10px' }}
              />
            </label>
            {hasApiKey ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                <button type="button" onClick={() => void clearApiKey()} style={{ ...linkStyle, marginTop: 0, alignSelf: 'flex-start' }}>
                  清除本机已保存的 Key
                </button>
                {apiKeySource === 'env' ? (
                  <span style={{ fontSize: 10.5, color: COLORS.muted, lineHeight: 1.6 }}>
                    环境变量优先于本机设置；要停用环境变量 Key，需要修改启动环境。
                  </span>
                ) : null}
              </div>
            ) : null}
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: COLORS.muted, marginTop: 12 }}>
              模型
              <input value={model} onChange={(event) => setModel(event.target.value)} style={{ border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '8px 10px' }} />
            </label>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 18 }}>
              <span style={{ color: COLORS.success, fontSize: 12 }}>{settingsSaved}</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button onClick={() => setSettingsOpen(false)}>取消</Button>
                <Button kind="primary" onClick={() => void saveSettings()}>保存</Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

const panelStyle = {
  background: '#fff',
  border: `1px solid ${COLORS.border}`,
  borderRadius: 11,
  padding: 13,
} as const

const sectionTitleStyle = {
  fontSize: 12,
  fontWeight: 700,
  color: COLORS.muted,
  marginBottom: 8,
} as const

const lineStyle = {
  fontSize: 12,
  lineHeight: 1.8,
} as const

const linkStyle = {
  border: 'none',
  background: 'transparent',
  color: COLORS.accent,
  cursor: 'pointer',
  fontSize: 10,
  padding: 0,
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
