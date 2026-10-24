import { useMemo, useState } from 'react'
import type { Artifact, CaseStudyContent, QuestionAttempt } from '@learning-agent/shared'
import type { SetSubmissionStatus } from './model'
import { COLORS, Empty, HtmlFrame, Tag } from './ui'
import { MarkdownView } from './markdown'
import { tagRoleLabel } from './labels'

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function label(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return ''
}

export interface ArtifactRendererProps {
  artifact: Artifact
  attempts: QuestionAttempt[]
  kpNames: Record<string, string>
  onSubmitSet: (artifactId: string, answers: Array<{ questionId: string; answer: string }>) => Promise<SetSubmissionStatus>
  onOpenSource?: (sourceId: string, sourceType: 'kp' | 'news' | 'textbook' | 'resource', quote: string) => void
}

function SectionTitle({ children }: { children: string }) {
  return <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.muted, letterSpacing: 0.3, marginBottom: 6 }}>{children}</div>
}

const DIFFICULTY = {
  1: { label: '基础', bg: '#effaf5', border: '#86d9b8', soft: '#c9f0e1', text: '#047857' },
  2: { label: '应用', bg: '#f1f4ff', border: '#aebcf5', soft: '#dbe3ff', text: '#3730a3' },
  3: { label: '挑战', bg: '#fff7ed', border: '#f4b27a', soft: '#fde3cb', text: '#c2410c' },
} as const

function difficultyOf(value: number) {
  return DIFFICULTY[Math.min(3, Math.max(1, value)) as 1 | 2 | 3]
}

function DifficultyMeter({ level }: { level: number }) {
  const palette = difficultyOf(level)
  return (
    <span title={`难度：${palette.label}`} aria-label={`难度：${palette.label}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 2.5 }}>
      {[1, 2, 3].map((item) => (
        <span
          key={item}
          style={{
            width: 7,
            height: 3,
            borderRadius: 2,
            background: item <= level ? palette.border : palette.soft,
            opacity: item <= level ? 1 : 0.65,
          }}
        />
      ))}
    </span>
  )
}

function QuestionSetRenderer({ artifact, attempts, kpNames, onSubmitSet }: ArtifactRendererProps) {
  const content = obj(artifact.content_json)
  const questions = arr(content.questions).map(obj)
  const attemptByQuestion = useMemo(() => {
    const map = new Map<string, QuestionAttempt>()
    for (const attempt of attempts) {
      if (!map.has(attempt.question_id)) map.set(attempt.question_id, attempt)
    }
    return map
  }, [attempts])
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submittedLocally, setSubmittedLocally] = useState(false)
  const pendingQuestions = questions.filter((question) => !attemptByQuestion.has(str(question.id)))
  const submitted = submittedLocally || (questions.length > 0 && pendingQuestions.length === 0)
  const answeredCount = pendingQuestions.filter((question) => (selected[str(question.id)] ?? '').trim().length > 0).length

  const choose = (questionId: string, option: string, multiple: boolean) => {
    setSelected((current) => {
      if (!multiple) return { ...current, [questionId]: option }
      const previous = current[questionId] ?? ''
      const values = previous.length > 0 ? previous.split(',') : []
      const next = values.includes(option) ? values.filter((item) => item !== option) : [...values, option]
      return { ...current, [questionId]: next.join(',') }
    })
  }

  if (questions.length === 0) {
    return artifact.content.trim().length > 0
      ? <MarkdownView text={artifact.content} />
      : <Empty>这份题目集没有可渲染的题目。</Empty>
  }

  return (
    <div data-submitted={submitted ? 'true' : 'false'} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 12, color: COLORS.muted, lineHeight: 1.7 }}>{str(content.intro)}</div>
      {questions.map((question, index) => {
        const id = str(question.id)
        const type = str(question.type, '简答')
        const options = arr(question.options).map((option) => label(option))
        const attempt = attemptByQuestion.get(id)
        const multiple = type === '多选'
        const chosen = selected[id] ?? ''
        const locked = Boolean(attempt) || submitted
        const existingCorrect = attempt ? num(attempt.score) >= 0.99 : undefined
        const difficulty = num(question.difficulty, 2)
        const palette = difficultyOf(difficulty)
        return (
          <section
            key={id || index}
            style={{
              borderLeft: `1px solid ${palette.soft}`,
              borderRight: `1px solid ${palette.soft}`,
              borderTop: `2px solid ${palette.border}`,
              borderBottom: `2px solid ${palette.soft}`,
              borderRadius: 12,
              background: `linear-gradient(180deg, ${palette.bg} 0%, #fff 46%, #fff 100%)`,
              padding: 14,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700 }}>第 {index + 1} 题</span>
              <Tag tone="accent">{type}</Tag>
              <DifficultyMeter level={difficulty} />
              {attempt ? <Tag tone={existingCorrect ? 'success' : 'warning'}>{existingCorrect ? '答对' : '答错'}</Tag> : null}
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.75, marginBottom: 10 }}>{str(question.stem)}</div>
            {options.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {options.map((option, optionIndex) => {
                  const letter = String.fromCharCode(65 + optionIndex)
                  const active = multiple
                    ? chosen.split(',').includes(option)
                    : chosen === option
                  return (
                    <button
                      key={`${id}-${optionIndex}`}
                      type="button"
                      disabled={locked}
                      onClick={() => choose(id, option, multiple)}
                      style={{
                        textAlign: 'left',
                        border: `1px solid ${active ? COLORS.accent : COLORS.border}`,
                        background: active ? 'color-mix(in srgb, var(--accent) 7%, transparent)' : '#fafafa',
                        borderRadius: 8,
                        padding: '7px 10px',
                        cursor: submitted ? 'default' : 'pointer',
                        fontSize: 12,
                        lineHeight: 1.6,
                      }}
                    >
                      <span style={{ color: COLORS.muted, marginRight: 6 }}>{letter}.</span>{option}
                    </button>
                  )
                })}
              </div>
            ) : (
              <textarea
                value={chosen}
                disabled={locked}
                onChange={(event) => setSelected((current) => ({ ...current, [id]: event.target.value }))}
                rows={3}
                placeholder="写下你的答案与理由…"
                style={{ width: '100%', border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 8, fontSize: 12, fontFamily: 'inherit', resize: 'vertical' }}
              />
            )}
            {attempt || submitted ? (
              <div style={{ marginTop: 10, borderTop: `1px solid ${COLORS.border}`, paddingTop: 8, fontSize: 12, lineHeight: 1.75 }}>
                <div style={{ color: COLORS.muted }}>你的答案：{attempt?.answer ?? selected[id] ?? ''}</div>
                <div style={{ marginTop: 4 }}><strong>参考答案：</strong>{str(question.answer)}</div>
                <div style={{ color: COLORS.muted, marginTop: 4 }}><strong>解析：</strong>{str(question.explanation)}</div>
                {arr(question.kpIds).some((id) => kpNames[str(id)]) ? (
                  <div style={{ color: COLORS.muted, marginTop: 4 }}>
                    知识点：{arr(question.kpIds).map((id) => kpNames[str(id)]).filter(Boolean).join('、')}
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
        )
      })}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, borderTop: `1px solid ${COLORS.border}`, paddingTop: 12 }}>
        <span style={{ fontSize: 11, color: COLORS.muted }}>
          {submitted
            ? '已交卷，答案与解析已展开。'
            : pendingQuestions.length < questions.length
              ? `部分题已判分；还有 ${pendingQuestions.length} 题未判，可重试。已判题不会重复提交。`
              : `已答 ${answeredCount}/${pendingQuestions.length} 题 · 交卷后统一判题`}
        </span>
        <button
          type="button"
          disabled={submitted || submitting || pendingQuestions.length === 0 || answeredCount < pendingQuestions.length}
          onClick={() => {
            setSubmitting(true)
            void onSubmitSet(artifact.id, pendingQuestions.map((question) => ({
              questionId: str(question.id),
              answer: selected[str(question.id)] ?? '',
            }))).then((status) => {
              if (status === 'completed') setSubmittedLocally(true)
            }).finally(() => setSubmitting(false))
          }}
          style={{
            border: '1px solid transparent',
            background: COLORS.accent,
            color: 'var(--on-accent, #fff)',
            borderRadius: 9,
            padding: '7px 16px',
            fontSize: 12,
            cursor: submitted || pendingQuestions.length === 0 || answeredCount < pendingQuestions.length ? 'default' : 'pointer',
            opacity: submitted || pendingQuestions.length === 0 || answeredCount < pendingQuestions.length ? 0.45 : 1,
          }}
        >
          {submitted
            ? '已交卷'
            : submitting
              ? '判题中…'
              : pendingQuestions.length < questions.length ? '重试未判题目' : '交卷'}
        </button>
      </div>
    </div>
  )
}

function ResearchDesignRenderer({ artifact }: ArtifactRendererProps) {
  const content = obj(artifact.content_json)
  const method = obj(content.method)
  const sampling = obj(content.sampling)
  if (!str(content.researchQuestion) && arr(content.objectives).length === 0) {
    return artifact.content.trim().length > 0
      ? <MarkdownView text={artifact.content} />
      : <Empty>这份研究设计暂时没有可展示的结构化内容。</Empty>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ border: `1px solid ${COLORS.accent}`, background: 'color-mix(in srgb, var(--accent) 6%, transparent)', borderRadius: 10, padding: 12 }}>
        <SectionTitle>研究问题</SectionTitle>
        <div style={{ fontSize: 14, lineHeight: 1.75 }}>{str(content.researchQuestion)}</div>
      </div>
      <section>
        <SectionTitle>研究目标</SectionTitle>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.8 }}>
          {arr(content.objectives).map((item, index) => <li key={index}>{label(item)}</li>)}
        </ol>
      </section>
      <section>
        <SectionTitle>方法与取舍</SectionTitle>
        <div style={{ fontSize: 13, lineHeight: 1.8 }}>
          <Tag tone="accent">{str(method.chosen, '未指定')}</Tag>
          <div style={{ marginTop: 6 }}>{str(method.rationale)}</div>
        </div>
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ border: `1px solid ${COLORS.border}`, padding: '6px 8px', textAlign: 'left', background: '#f9fafb' }}>替代方法</th>
                <th style={{ border: `1px solid ${COLORS.border}`, padding: '6px 8px', textAlign: 'left', background: '#f9fafb' }}>取舍</th>
              </tr>
            </thead>
            <tbody>
              {arr(method.alternatives).map((item, index) => {
                const alternative = obj(item)
                return (
                  <tr key={index}>
                    <td style={{ border: `1px solid ${COLORS.border}`, padding: '6px 8px' }}>{str(alternative.method)}</td>
                    <td style={{ border: `1px solid ${COLORS.border}`, padding: '6px 8px', color: COLORS.muted }}>{str(alternative.tradeoff)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <SectionTitle>抽样设计</SectionTitle>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12, lineHeight: 1.7 }}>
          {[
            ['抽样框', str(sampling.frame)],
            ['抽样技术', str(sampling.technique)],
            ['目标样本', String(num(sampling.targetSize))],
            ['招募方式', str(sampling.recruitment)],
          ].map(([title, value]) => (
            <div key={title} style={{ border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 9, background: '#fff' }}>
              <div style={{ color: COLORS.muted, fontSize: 11 }}>{title}</div>
              <div style={{ marginTop: 3 }}>{value}</div>
            </div>
          ))}
        </div>
      </section>
      <section>
        <SectionTitle>风险</SectionTitle>
        <ul style={{ margin: 0, paddingLeft: 20, color: COLORS.warning, fontSize: 12, lineHeight: 1.8 }}>
          {arr(sampling.risks).map((risk, index) => <li key={index}>{label(risk)}</li>)}
        </ul>
      </section>
      <section>
        <SectionTitle>下一步</SectionTitle>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.8 }}>
          {arr(content.nextSteps).map((item, index) => <li key={index}>{label(item)}</li>)}
        </ol>
      </section>
    </div>
  )
}

function BpOutlineRenderer({ artifact }: ArtifactRendererProps) {
  const content = obj(artifact.content_json)
  const sections = arr(content.sections).map(obj)
  const [open, setOpen] = useState<Set<string>>(() => new Set(sections[0]?.id ? [String(sections[0].id)] : []))
  if (sections.length === 0) {
    return artifact.content.trim().length > 0
      ? <MarkdownView text={artifact.content} />
      : <Empty>这份 BP 目录暂时没有可展示的结构化内容。</Empty>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 12, color: COLORS.muted, lineHeight: 1.7 }}>
        {str(content.idea)} · 数字必须标 source 或 assumption。
      </div>
      {sections.map((section, index) => {
        const id = str(section.id, String(index))
        const expanded = open.has(id)
        return (
          <section key={id} style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, background: '#fff', overflow: 'hidden' }}>
            <button
              type="button"
              onClick={() => setOpen((current) => {
                const next = new Set(current)
                if (next.has(id)) next.delete(id)
                else next.add(id)
                return next
              })}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, border: 'none', background: 'transparent', padding: '10px 12px', cursor: 'pointer', textAlign: 'left' }}
            >
              <span style={{ color: COLORS.muted, fontSize: 11, width: 18 }}>{index + 1}</span>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{str(section.title)}</span>
              <span style={{ color: COLORS.muted, fontSize: 12 }}>{expanded ? '−' : '+'}</span>
            </button>
            {expanded ? (
              <div style={{ borderTop: `1px solid ${COLORS.border}`, padding: '10px 12px 12px', fontSize: 12, lineHeight: 1.75 }}>
                <div style={{ color: COLORS.muted }}>目的</div>
                <div>{str(section.purpose)}</div>
                <div style={{ color: COLORS.muted, marginTop: 8 }}>所需证据</div>
                <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                  {arr(section.requiredEvidence).map((item, itemIndex) => <li key={itemIndex}>{label(item)}</li>)}
                </ul>
              </div>
            ) : null}
          </section>
        )
      })}
    </div>
  )
}

function confidenceWord(value: number): string {
  if (value >= 0.7) return '强'
  if (value >= 0.45) return '中'
  return '弱'
}

const REVIEWED_STATUS: Record<string, true> = { reviewed: true, adjudicated: true, published: true }
const REVIEWED_EVIDENCE: Record<string, true> = { verified: true, gold: true }
const REVIEW_STATUS_LABEL: Record<string, string> = {
  draft: '未审核',
  reviewed: '已审核',
  adjudicated: '已裁定',
  published: '已发布',
  rejected: '已排除',
}
const EVIDENCE_LEVEL_LABEL: Record<string, string> = { auto: '自动', verified: '已核验', gold: '金标' }
const MATCH_METHOD_LABEL: Record<string, string> = { rule: '规则匹配', llm: 'LLM 匹配', hybrid: '混合匹配', human: '人工匹配' }

/** 审核门：candidate 不能为 true，且 status 与 evidenceLevel 都要在已审核集合内。 */
function isReviewedMatch(match: Record<string, unknown>): boolean {
  return match.candidate !== true
    && REVIEWED_STATUS[str(match.reviewStatus)] === true
    && REVIEWED_EVIDENCE[str(match.evidenceLevel)] === true
}

function NewsAnalysisRenderer({ artifact, kpNames, onOpenSource }: ArtifactRendererProps) {
  const content = obj(artifact.content_json)
  const article = obj(content.article)
  const matches = arr(content.matches).map(obj)
  if (!str(article.title) && matches.length === 0) {
    return artifact.content.trim().length > 0
      ? <MarkdownView text={artifact.content} />
      : <Empty>这份新闻分析暂时没有可展示的结构化内容。</Empty>
  }
  const hasAutoCandidate = matches.some((match) => !isReviewedMatch(match))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 12, background: '#fff' }}>
        <div style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.6 }}>{str(article.title, artifact.title)}</div>
        <div style={{ fontSize: 11, color: COLORS.muted, marginTop: 4 }}>
          {str(article.source)}{str(article.publishedAt) ? ` · ${str(article.publishedAt).slice(0, 10)}` : ''}
        </div>
        {str(article.summary) ? <div style={{ fontSize: 12, color: COLORS.muted, lineHeight: 1.75, marginTop: 8 }}>{str(article.summary)}</div> : null}
        {str(article.url) ? <a href={str(article.url)} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: COLORS.accent }}>查看原文</a> : null}
      </div>
      <SectionTitle>知识点候选</SectionTitle>
      {hasAutoCandidate ? (
        <div style={{ border: `1px solid ${COLORS.warning}`, borderRadius: 9, background: '#fffaf0', padding: '7px 10px', fontSize: 11, color: COLORS.muted, lineHeight: 1.7 }}>
          标记为「自动候选 · 未人审」或「审核状态未标注」的条目只用于召回：只展示候选名、原文和匹配线索，不提供定义、案例对应或示例对话等教学结论。
        </div>
      ) : null}
      {matches.length === 0 ? <Empty>没有可靠匹配。</Empty> : matches.map((match, index) => {
        const kpId = str(match.kpId)
        const definition = str(match.definition)
        const evidence = str(match.evidence)
        const reviewed = isReviewedMatch(match)
        const candidateFlag = match.candidate === true
        const reviewStatus = str(match.reviewStatus)
        const evidenceLevel = str(match.evidenceLevel)
        const hasDefinition = definition.length > 0
          && definition.replace(/\s+/g, '') !== evidence.replace(/\s+/g, '')
        const reviewLabel = reviewStatus ? REVIEW_STATUS_LABEL[reviewStatus] ?? reviewStatus : '未标注'
        const levelLabel = evidenceLevel ? EVIDENCE_LEVEL_LABEL[evidenceLevel] ?? evidenceLevel : '未标注'
        const method = str(match.method)
        const roleLabel = str(match.roleLabel) || tagRoleLabel(str(match.role))
        const autoLabel = candidateFlag || reviewStatus === 'draft' || evidenceLevel === 'auto'
          ? '自动候选 · 未人审'
          : reviewStatus.length > 0 || evidenceLevel.length > 0
            ? '证据未达教学标准'
            : '审核状态未标注'
        return (
          <div
            key={index}
            data-match-review={reviewed ? 'reviewed' : 'auto'}
            style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 11, background: '#fff' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{str(match.name) || kpNames[kpId] || '知识点'}</span>
              <Tag tone="accent">{roleLabel}</Tag>
              <Tag>{confidenceWord(num(match.confidence))}</Tag>
              <span data-review-badge={reviewed ? 'reviewed' : 'auto'}>
                {reviewed ? <Tag tone="success">已人审</Tag> : <Tag tone="warning">{autoLabel}</Tag>}
              </span>
            </div>
            <div style={{ fontSize: 10.5, color: COLORS.muted, marginTop: 5, lineHeight: 1.6 }}>
              匹配线索：{roleLabel} · 置信度 {Math.round(num(match.confidence) * 100)}% · 审核状态：{reviewLabel} · 证据等级：{levelLabel}
              {method ? ` · 匹配方式：${MATCH_METHOD_LABEL[method] ?? method}` : ''}
            </div>
            {reviewed ? (
              <>
                {hasDefinition ? (
                  <div style={{ border: `1px solid ${COLORS.accent}`, borderRadius: 8, background: 'color-mix(in srgb, var(--accent) 5%, transparent)', padding: '7px 9px', marginTop: 6 }}>
                    <div style={{ fontSize: 10.5, fontWeight: 700, color: COLORS.accent, marginBottom: 3 }}>定义</div>
                    <div style={{ fontSize: 12, lineHeight: 1.75 }}>{definition}</div>
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: COLORS.muted, marginTop: 6 }}>这条匹配暂无可引用的课程定义，请把下面的原文摘录当作线索。</div>
                )}
                {str(match.caseMapping) ? (
                  <div style={{ fontSize: 12, lineHeight: 1.75, marginTop: 7 }}><strong>案例对应：</strong>{str(match.caseMapping)}</div>
                ) : null}
              </>
            ) : (
              <div style={{ border: `1px dashed ${COLORS.border}`, borderRadius: 8, background: '#fbfbfa', padding: '7px 9px', marginTop: 7, fontSize: 11, color: COLORS.muted, lineHeight: 1.7 }}>
                未人审候选：教学解释与示例内容需人工审核通过后才展示，当前不作为教学结论。
              </div>
            )}
            {evidence ? (
              <blockquote style={{ margin: '7px 0 0', padding: '5px 10px', borderLeft: `3px solid ${COLORS.accent}`, background: '#fafafa', fontSize: 12, lineHeight: 1.7 }}>
                原文摘录：{evidence}
              </blockquote>
            ) : null}
            {reviewed ? (
              <>
                <DialoguePanel dialogue={arr(match.dialogue).map(obj).map((turn) => ({ role: str(turn.role), text: str(turn.text) }))} />
                {kpId && onOpenSource ? (
                  <button type="button" onClick={() => onOpenSource(kpId, 'kp', hasDefinition ? definition : '')} style={{ border: 'none', background: 'transparent', color: COLORS.accent, fontSize: 11, padding: 0, marginTop: 5, cursor: 'pointer' }}>
                    查看依据
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        )
      })}
      <section>
        <SectionTitle>课程思政点</SectionTitle>
        {arr(content.ideology).length > 0 ? arr(content.ideology).map((item, index) => {
          const point = obj(item)
          return (
            <div key={index} style={{ fontSize: 12, lineHeight: 1.7, marginBottom: 5 }}>
              <strong>{str(point.name)}</strong>：{str(point.evidence)}
            </div>
          )
        }) : (
          <div style={{ fontSize: 12, color: COLORS.muted }}>本篇没有可追溯的思政匹配。</div>
        )}
      </section>
      <div style={{ fontSize: 11, color: COLORS.muted, lineHeight: 1.7 }}>
        {str(content.usageNote)}
        {hasAutoCandidate ? ' 请以每条候选的审核状态与证据等级为准。' : ''}
      </div>
    </div>
  )
}

function DialoguePanel({ dialogue, hint = '用于说明概念，不是你的真实发言' }: {
  dialogue: Array<{ role: string; text: string }>
  hint?: string
}) {
  if (dialogue.length === 0) return null
  return (
    <div style={{ margin: '11px 0 0', border: `1px solid ${COLORS.border}`, borderRadius: 10, background: '#fbfbfa', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', borderBottom: `1px solid ${COLORS.border}`, background: '#f6f8f7' }}>
        <span style={{ width: 5, height: 5, borderRadius: 99, background: COLORS.accent }} />
        <span style={{ fontSize: 10.5, fontWeight: 700, color: COLORS.muted, letterSpacing: 0.4 }}>示例对话</span>
        <span style={{ fontSize: 10, color: COLORS.muted }}>{hint}</span>
      </div>
      <div style={{ padding: '10px 10px 11px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {dialogue.map((turn, turnIndex) => {
          const student = turn.role === 'student'
          return (
            <div key={turnIndex} style={{ display: 'flex', justifyContent: student ? 'flex-end' : 'flex-start', gap: 6, alignItems: 'flex-start' }}>
              {!student ? (
                <span style={{ width: 20, height: 20, flex: '0 0 20px', borderRadius: 6, background: '#e8f2ee', color: COLORS.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, marginTop: 1 }}>营</span>
              ) : null}
              <div style={{
                maxWidth: '82%',
                background: student ? '#eef0ef' : '#fff',
                border: student ? 'none' : `1px solid ${COLORS.border}`,
                borderRadius: student ? '10px 10px 3px 10px' : '10px 10px 10px 3px',
                padding: '7px 10px',
                fontSize: 12,
                lineHeight: 1.75,
              }}>
                {turn.text}
              </div>
              {student ? <span style={{ width: 20, height: 20, flex: '0 0 20px', borderRadius: 6, background: '#eef0ef', color: COLORS.muted, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, marginTop: 1 }}>例</span> : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CaseStudyRenderer({ artifact, onOpenSource }: ArtifactRendererProps) {
  const content = obj(artifact.content_json) as unknown as Partial<CaseStudyContent>
  const caseInfo = content.case
  const points = content.knowledgePoints ?? []
  if (!caseInfo && points.length === 0) {
    return artifact.content.trim().length > 0
      ? <MarkdownView text={artifact.content} />
      : <Empty>这份案例精讲暂时没有可展示的结构化内容。</Empty>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <header style={{ border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 14, background: 'linear-gradient(180deg, #f5faf8 0%, #fff 70%)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, color: COLORS.accent }}>案例精讲</span>
          <Tag tone="accent">教学示例</Tag>
        </div>
        <div style={{ fontSize: 17, fontWeight: 750, lineHeight: 1.55, marginTop: 4 }}>{caseInfo?.title ?? artifact.title}</div>
        {caseInfo?.subtitle ? <div style={{ fontSize: 11.5, color: COLORS.muted, marginTop: 3 }}>{caseInfo.subtitle}</div> : null}
        {caseInfo?.summary ? <div style={{ fontSize: 12.5, lineHeight: 1.8, marginTop: 8 }}>{caseInfo.summary}</div> : null}
        {caseInfo?.companies && caseInfo.companies.length > 0 ? (
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 9 }}>
            {caseInfo.companies.map((company) => <Tag key={company} tone="accent">{company}</Tag>)}
          </div>
        ) : null}
        {caseInfo?.sourceNote ? <div style={{ fontSize: 10.5, color: COLORS.muted, lineHeight: 1.65, marginTop: 8 }}>{caseInfo.sourceNote}</div> : null}
      </header>

      {points.map((point, index) => (
        <section key={point.id ?? index} data-case-kp-name={point.name || '知识点'} style={{ border: `1px solid ${COLORS.border}`, borderRadius: 12, background: '#fff', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', padding: '11px 13px 9px', borderBottom: `1px solid ${COLORS.border}` }}>
            <span style={{ fontSize: 10.5, color: COLORS.muted, fontVariantNumeric: 'tabular-nums' }}>{String(index + 1).padStart(2, '0')}</span>
            <span style={{ fontSize: 14, fontWeight: 700 }}>{point.name || '知识点'}</span>
            <Tag tone="accent">定义先行</Tag>
          </div>

          <div style={{ padding: '11px 13px 0' }}>
            {point.definition && !(point.evidence ?? []).some((item) => item.quote.replace(/\s+/g, '') === point.definition?.replace(/\s+/g, '')) ? (
              <div style={{ border: `1px solid ${COLORS.accent}`, borderRadius: 9, background: 'color-mix(in srgb, var(--accent) 5%, transparent)', padding: '9px 11px' }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: COLORS.accent, letterSpacing: 0.4, marginBottom: 4 }}>定义</div>
                <div style={{ fontSize: 13, lineHeight: 1.8 }}>{point.definition}</div>
                {point.definitionSource ? <div style={{ fontSize: 10, color: COLORS.muted, marginTop: 4 }}>来源：{point.definitionSource}</div> : null}
              </div>
            ) : (
              <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 9, background: '#fafafa', padding: '9px 11px', fontSize: 11.5, color: COLORS.muted, lineHeight: 1.7 }}>
                课程定义暂缺：先看下面的案例对应和原文证据，不要把它们当作教材定义。
              </div>
            )}

            {point.caseMapping ? (
              <div style={{ border: `1px solid ${COLORS.border}`, borderLeft: `3px solid ${COLORS.accent}`, borderRadius: 8, background: '#fafbfa', padding: '9px 11px', marginTop: 9 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: COLORS.muted, marginBottom: 4 }}>案例对应</div>
                <div style={{ fontSize: 12.5, lineHeight: 1.8 }}>{point.caseMapping}</div>
              </div>
            ) : null}

            {point.evidence && point.evidence.length > 0 ? (
              <div style={{ marginTop: 9, display: 'flex', flexDirection: 'column', gap: 5 }}>
                {point.evidence.map((item, evidenceIndex) => {
                  const declaredType = str(item.sourceType, 'news')
                  const legacySource = str(item.sourceType).length === 0
                  const sourceType: 'kp' | 'news' | 'textbook' | 'resource' = declaredType === 'textbook'
                    ? 'textbook'
                    : declaredType === 'resource'
                      ? 'resource'
                      : declaredType === 'kp' ? 'kp' : 'news'
                  return (
                    <blockquote key={evidenceIndex} style={{ margin: 0, padding: '6px 10px', borderLeft: `2px solid ${COLORS.border}`, background: '#fbfbfa', fontSize: 11.5, lineHeight: 1.7 }}>
                      {item.quote}
                      {item.sourceTitle ? <span style={{ color: COLORS.muted }}> · {item.sourceTitle}</span> : null}
                      {legacySource ? (
                        <span style={{ marginLeft: 6, color: COLORS.warning, fontSize: 10.5 }}>旧引用需复核</span>
                      ) : null}
                      {item.sourceId && onOpenSource ? (
                        <button
                          type="button"
                          onClick={() => onOpenSource(item.sourceId, sourceType, item.quote)}
                          style={{ border: 'none', background: 'transparent', color: COLORS.accent, fontSize: 10.5, padding: 0, marginLeft: 6, cursor: 'pointer' }}
                        >
                          {sourceType === 'textbook'
                            ? '查看教材原文'
                            : sourceType === 'resource' ? '查看资料' : sourceType === 'kp' ? '查看依据' : '查看原文'}
                        </button>
                      ) : null}
                    </blockquote>
                  )
                })}
              </div>
            ) : null}
          </div>

          {point.dialogue && point.dialogue.length > 0 ? (
            <div style={{ padding: '0 13px' }}>
              <DialoguePanel dialogue={point.dialogue} />
            </div>
          ) : null}

          <div style={{ padding: '10px 13px 13px', display: 'flex', flexDirection: 'column', gap: 7 }}>
            {point.takeaway ? (
              <div style={{ fontSize: 12, lineHeight: 1.75 }}><strong>结论：</strong>{point.takeaway}</div>
            ) : null}
            {point.boundary ? (
              <div style={{ fontSize: 11.5, lineHeight: 1.75, color: COLORS.muted }}><strong>边界：</strong>{point.boundary}</div>
            ) : null}
            {point.checkQuestion ? (
              <div style={{ fontSize: 11.5, lineHeight: 1.75, color: COLORS.accent }}><strong>想一想：</strong>{point.checkQuestion}</div>
            ) : null}
          </div>
        </section>
      ))}

      {content.transfer && content.transfer.length > 0 ? (
        <section style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 12, background: '#fff' }}>
          <SectionTitle>可迁移结论</SectionTitle>
          <ol style={{ margin: 0, paddingLeft: 20, fontSize: 12.5, lineHeight: 1.85 }}>
            {content.transfer.map((item, index) => <li key={index}>{item}</li>)}
          </ol>
        </section>
      ) : null}
      {content.boundaries && content.boundaries.length > 0 ? (
        <section style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 12, background: '#fff' }}>
          <SectionTitle>边界条件</SectionTitle>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12, lineHeight: 1.8, color: COLORS.muted }}>
            {content.boundaries.map((item, index) => <li key={index}>{item}</li>)}
          </ul>
        </section>
      ) : null}
      {content.usageNote ? <div style={{ fontSize: 11, color: COLORS.muted, lineHeight: 1.7 }}>{content.usageNote}</div> : null}
    </div>
  )
}

const STRENGTH_LABEL: Record<string, string> = { A: '强', B: '较强', C: '中', D: '弱' }

/** 默认产物：模型直接写成的页面，沙箱里渲染。 */
function PageRenderer({ artifact }: ArtifactRendererProps) {
  const content = obj(artifact.content_json)
  const html = str(content.html) || (artifact.format === 'html' ? artifact.content : '')
  if (html.trim().length === 0) {
    return <Empty>这份页面暂时没有内容。可以让我重写一次。</Empty>
  }
  return <HtmlFrame title={artifact.title} html={html} />
}

function GrowthCardRenderer({ artifact }: ArtifactRendererProps) {
  const content = obj(artifact.content_json)
  const dimensions = arr(content.dimensions).map(obj)
  if (dimensions.length === 0) {
    return artifact.content.trim().length > 0
      ? <MarkdownView text={artifact.content} />
      : <Empty>这份成长卡暂时没有可展示的结构化内容。</Empty>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {dimensions.map((dimension, index) => {
        const evidenceCount = num(dimension.evidenceCount)
        return (
          <section key={str(dimension.id, String(index))} style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 12, background: '#fff' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{str(dimension.name)}</span>
              <Tag tone={evidenceCount === 0 ? 'warning' : 'success'}>{str(dimension.status, evidenceCount === 0 ? '证据不足' : '')}</Tag>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 6 }}>
              <span style={{ fontSize: 16, fontWeight: 700 }}>{str(dimension.levelWord, '证据不足')}</span>
              <span style={{ fontSize: 11, color: COLORS.muted }}>证据 {evidenceCount} 条</span>
            </div>
            {dimension.preLevel || dimension.postLevel ? (
              <div style={{ fontSize: 11, color: COLORS.muted, marginTop: 3 }}>
                前测 {str(dimension.preLevel)} → 后测 {str(dimension.postLevel)}
              </div>
            ) : null}
            {arr(dimension.evidence).length > 0 ? (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
                {arr(dimension.evidence).map((item, evidenceIndex) => {
                  const evidence = obj(item)
                  return (
                    <blockquote key={evidenceIndex} style={{ margin: 0, padding: '5px 10px', borderLeft: `3px solid ${COLORS.accent}`, background: '#fafafa', fontSize: 11, lineHeight: 1.7 }}>
                      “{str(evidence.quote)}” <span style={{ color: COLORS.muted }}>· 证据{STRENGTH_LABEL[str(evidence.strength)] ?? '待验证'}</span>
                    </blockquote>
                  )
                })}
              </div>
            ) : (
              <div style={{ marginTop: 8, fontSize: 12, color: COLORS.warning, lineHeight: 1.7 }}>证据不足：本维度暂不给出确定结论。</div>
            )}
            <div style={{ fontSize: 11, color: COLORS.muted, marginTop: 7 }}>下一步：{str(dimension.nextStep)}</div>
          </section>
        )
      })}
    </div>
  )
}

export function ArtifactRenderer(props: ArtifactRendererProps) {
  const { artifact } = props
  switch (artifact.type) {
    case 'page':
      return <PageRenderer {...props} />
    case 'question_set':
      return <QuestionSetRenderer {...props} />
    case 'research_design':
      return <ResearchDesignRenderer {...props} />
    case 'bp_outline':
      return <BpOutlineRenderer {...props} />
    case 'case_analysis':
      return <NewsAnalysisRenderer {...props} />
    case 'case_study':
      return <CaseStudyRenderer {...props} />
    case 'growth_card':
      return <GrowthCardRenderer {...props} />
    default:
      return artifact.content.trim().length > 0
        ? <MarkdownView text={artifact.content} />
        : <Empty>这份产物暂时无法预览。</Empty>
  }
}
