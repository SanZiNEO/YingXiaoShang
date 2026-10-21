import { useEffect, useState } from 'react'
import { BRAND } from '@learning-agent/shared/brand'
import { CHAPTER_TITLES } from '@learning-agent/shared/constants'
import type {
  BpProject,
  CaseMatch,
  IdeologyMatch,
  IdeologyPoint,
  KnowledgePoint,
  NewsArticle,
  Question,
  QuestionType,
  ResearchProject,
} from '@learning-agent/shared'
import {
  callLearning,
  panel,
  RemoteUnavailableError,
  startPreset,
  type ClientContext,
} from './client-context'
import {
  Button,
  Card,
  COLORS,
  Empty,
  ErrorText,
  Field,
  Page,
  Row,
  Select,
  Tag,
  TextArea,
  TextInput,
} from './ui'

const CHAPTER_OPTIONS = Object.entries(CHAPTER_TITLES).map(([number, title]) => ({
  value: `ch${String(number).padStart(2, '0')}`,
  label: `第${number}章 ${title}`,
}))

const QUESTION_TYPES: QuestionType[] = ['名词解释', '填空', '判断', '单选', '多选', '简答', '案例分析']

function useAsyncAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (reason) {
      if (reason instanceof RemoteUnavailableError) {
        setError(reason.message)
      } else {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run, setError }
}

export function KnowledgePage({ client }: { client: ClientContext }) {
  const [tab, setTab] = useState<'kp' | 'news'>('kp')
  const [chapter, setChapter] = useState('ch04')
  const [query, setQuery] = useState('')
  const [kps, setKps] = useState<KnowledgePoint[]>([])
  const [selected, setSelected] = useState<KnowledgePoint | undefined>()
  const [relatedQuestions, setRelatedQuestions] = useState<Question[]>([])
  const [ideology, setIdeology] = useState<IdeologyPoint[]>([])
  const [news, setNews] = useState<NewsArticle[]>([])
  const [selectedNews, setSelectedNews] = useState<NewsArticle | undefined>()
  const [matches, setMatches] = useState<CaseMatch[]>([])
  const [newsIdeology, setNewsIdeology] = useState<IdeologyMatch[]>([])
  const [remoteMissing, setRemoteMissing] = useState(false)
  const { busy, error, run } = useAsyncAction()

  useEffect(() => {
    if (tab !== 'kp') return
    void run(async () => {
      try {
        const points = await callLearning<KnowledgePoint[]>(client, 'listKps', {
          chapter,
          query: query.trim() || undefined,
          limit: 80,
        })
        setKps(points)
        setRemoteMissing(false)
      } catch (reason) {
        if (reason instanceof RemoteUnavailableError) {
          setRemoteMissing(true)
          setKps([])
          return
        }
        throw reason
      }
    })
  }, [chapter, query, tab])

  useEffect(() => {
    if (tab !== 'news') return
    void run(async () => {
      try {
        const articles = await callLearning<NewsArticle[]>(client, 'listNews', { limit: 30 })
        setNews(articles)
        setRemoteMissing(false)
      } catch (reason) {
        if (reason instanceof RemoteUnavailableError) {
          setRemoteMissing(true)
          setNews([])
          return
        }
        throw reason
      }
    })
  }, [tab])

  const openKp = (point: KnowledgePoint) => {
    setSelected(point)
    void run(async () => {
      const questions = await callLearning<Question[]>(client, 'listQuestions', { kpId: point.id, limit: 10 })
      const points = await callLearning<IdeologyPoint[]>(client, 'listIdeology', {})
      setRelatedQuestions(questions)
      setIdeology(points.filter((item) => item.related_kp_ids.includes(point.id)))
    })
  }

  const openNews = (article: NewsArticle) => {
    setSelectedNews(article)
    void run(async () => {
      const detail = await callLearning<{
        article: NewsArticle
        matches: CaseMatch[]
        ideology: IdeologyMatch[]
      } | undefined>(client, 'getNews', { articleId: article.id })
      setMatches(detail?.matches ?? [])
      setNewsIdeology(detail?.ideology ?? [])
    })
  }

  const matchSelectedNews = () => {
    if (!selectedNews) return
    void run(async () => {
      const result = await callLearning<{ matches: CaseMatch[] }>(client, 'matchNews', {
        articleId: selectedNews.id,
        topK: 3,
      })
      setMatches(result.matches)
      const detail = await callLearning<{
        article: NewsArticle
        matches: CaseMatch[]
        ideology: IdeologyMatch[]
      } | undefined>(client, 'getNews', { articleId: selectedNews.id })
      setNewsIdeology(detail?.ideology ?? [])
    })
  }

  return (
    <Page
      title="知识库 · 新闻"
      subtitle="第4章消费者行为知识点是匹配与出题的底座。先让学生判断，再揭示匹配结果。"
      actions={
        <>
          <Button onClick={() => startPreset(client, 'knowledge-news', '这条新闻体现了哪些消费者行为知识点？请先让我判断，再给证据。')}>
            和案例教练对话
          </Button>
          <Button kind="primary" onClick={() => panel(client, 'question')}>去出题</Button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <Button kind={tab === 'kp' ? 'primary' : 'default'} onClick={() => setTab('kp')}>知识库</Button>
        <Button kind={tab === 'news' ? 'primary' : 'default'} onClick={() => setTab('news')}>新闻</Button>
      </div>
      {remoteMissing ? (
        <Card>
          <Empty>
            数据接口尚未挂载。你仍然可以直接和「知识库·新闻」智能体对话，它会检索本地知识库和新闻。
          </Empty>
        </Card>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
      {tab === 'kp' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 0.8fr) minmax(320px, 1.2fr)', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Card title="筛选">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <Field label="章节">
                  <Select value={chapter} onChange={setChapter} options={CHAPTER_OPTIONS} />
                </Field>
                <Field label="检索">
                  <TextInput value={query} onChange={setQuery} placeholder="输入关键词，如 参照群体" />
                </Field>
              </div>
            </Card>
            <Card title={`知识点（${kps.length}）`}>
              {kps.length === 0 ? <Empty>本章暂无已入库知识点</Empty> : null}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 520, overflow: 'auto' }}>
                {kps.map((point) => (
                  <Row key={point.id} active={selected?.id === point.id} onClick={() => openKp(point)}>
                    <div style={{ fontWeight: 500 }}>{point.name}</div>
                    <div style={{ color: COLORS.muted, fontSize: 11, marginTop: 2 }}>{point.id}</div>
                  </Row>
                ))}
              </div>
            </Card>
          </div>
          <Card title={selected ? selected.name : '知识点详情'}>
            {!selected ? <Empty>从左侧选择一个知识点</Empty> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <Tag tone="accent">{selected.chapter_id}</Tag>
                  <Tag>{selected.section_id}</Tag>
                  <Tag tone="warning">难度 {selected.difficulty}</Tag>
                </div>
                <div>
                  <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>定义</h3>
                  <p style={{ margin: 0, fontSize: 13, lineHeight: 1.75 }}>{selected.definition}</p>
                </div>
                {selected.keywords.length > 0 ? (
                  <div>
                    <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>关键词</h3>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {selected.keywords.map((keyword) => <Tag key={keyword}>{keyword}</Tag>)}
                    </div>
                  </div>
                ) : null}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>正例</h3>
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: COLORS.muted }}>
                      {selected.examples.map((item) => <li key={item}>{item}</li>)}
                    </ul>
                  </div>
                  <div>
                    <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>反例</h3>
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: COLORS.muted }}>
                      {selected.non_examples.map((item) => <li key={item}>{item}</li>)}
                    </ul>
                  </div>
                </div>
                {ideology.length > 0 ? (
                  <div>
                    <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>关联课程思政</h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {ideology.map((item) => (
                        <div key={item.id} style={{ fontSize: 12, color: COLORS.muted }}>
                          <strong style={{ color: COLORS.text }}>{item.name}</strong>：{item.definition}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div>
                  <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>相关题目（{relatedQuestions.length}）</h3>
                  {relatedQuestions.length === 0 ? <Empty>暂无题目，去「出题」生成</Empty> : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {relatedQuestions.map((question) => (
                        <div key={question.id} style={{ fontSize: 12, borderTop: `1px solid ${COLORS.border}`, paddingTop: 6 }}>
                          <Tag tone="accent">{question.type}</Tag> {question.stem}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button
                    kind="primary"
                    onClick={() => startPreset(client, 'question-gen', `请围绕知识点「${selected.name}」生成 2 道简答题。`)}
                  >
                    让出题智能体出题
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 1fr) minmax(320px, 1.2fr)', gap: 16 }}>
          <Card title={`新闻（${news.length}）`}>
            {news.length === 0 ? <Empty>暂无新闻，运行 pipeline:news 后刷新</Empty> : null}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 560, overflow: 'auto' }}>
              {news.map((article) => (
                <Row key={article.id} active={selectedNews?.id === article.id} onClick={() => openNews(article)}>
                  <div style={{ fontWeight: 500, lineHeight: 1.45 }}>{article.title}</div>
                  <div style={{ color: COLORS.muted, fontSize: 11, marginTop: 3 }}>
                    {article.source} · {article.published_at.slice(0, 10)}
                  </div>
                </Row>
              ))}
            </div>
          </Card>
          <Card
            title={selectedNews ? selectedNews.title : '新闻详情'}
            actions={selectedNews ? <Button kind="primary" disabled={busy} onClick={matchSelectedNews}>匹配知识点</Button> : undefined}
          >
            {!selectedNews ? <Empty>选择一条新闻查看原文与匹配证据</Empty> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <Tag tone="accent">{selectedNews.source}</Tag>
                  <Tag>{selectedNews.content_status}</Tag>
                  <a href={selectedNews.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: COLORS.accent }}>
                    原文链接
                  </a>
                </div>
                <p style={{ margin: 0, fontSize: 13, lineHeight: 1.75, whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto' }}>
                  {selectedNews.content.slice(0, 2400)}
                </p>
                <div>
                  <h3 style={{ fontSize: 13, margin: '0 0 8px' }}>匹配结果（{matches.length}）</h3>
                  {matches.length === 0 ? <Empty>尚未匹配</Empty> : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {matches.map((match) => (
                        <div key={match.kp_id} style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 10 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <strong style={{ fontSize: 13 }}>{match.kp_id}</strong>
                            <Tag tone="accent">{match.tag_role}</Tag>
                            <Tag>{Math.round(match.confidence * 100)}%</Tag>
                          </div>
                          <blockquote style={{ margin: '8px 0 0', paddingLeft: 10, borderLeft: `2px solid ${COLORS.accent}`, fontSize: 12, color: COLORS.muted }}>
                            {match.evidence_span}
                          </blockquote>
                          <p style={{ margin: '6px 0 0', fontSize: 12, color: COLORS.muted }}>{match.rationale}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {newsIdeology.length > 0 ? (
                  <div>
                    <h3 style={{ fontSize: 13, margin: '0 0 8px' }}>课程思政</h3>
                    {newsIdeology.map((item) => (
                      <div key={item.ideology_id} style={{ fontSize: 12, color: COLORS.muted }}>
                        {item.ideology_id}：{item.evidence_span}
                      </div>
                    ))}
                  </div>
                ) : null}
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button
                    kind="primary"
                    onClick={() => startPreset(client, 'question-gen', `请根据新闻「${selectedNews.title}」生成 2 道案例分析题。`)}
                  >
                    生成题目
                  </Button>
                  <Button onClick={() => startPreset(client, 'knowledge-news', `请分析新闻「${selectedNews.title}」体现了哪些消费者行为知识点。`)}>
                    和案例教练对话
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </div>
      )}
    </Page>
  )
}

export function QuestionPage({ client }: { client: ClientContext }) {
  const [sourceType, setSourceType] = useState<'news' | 'kp' | 'text' | 'resource'>('kp')
  const [sourceId, setSourceId] = useState('')
  const [text, setText] = useState('')
  const [type, setType] = useState<QuestionType>('简答')
  const [difficulty, setDifficulty] = useState('2')
  const [count, setCount] = useState('2')
  const [questions, setQuestions] = useState<Question[]>([])
  const { busy, error, run } = useAsyncAction()

  const generate = () => {
    void run(async () => {
      try {
        const created = await callLearning<Question[]>(client, 'generateQuestions', {
          sourceType,
          sourceId: sourceId.trim() || undefined,
          text: text.trim() || undefined,
          types: [type],
          difficulty: Number(difficulty) as 1 | 2 | 3,
          count: Number(count),
        })
        setQuestions(created)
      } catch (reason) {
        if (reason instanceof RemoteUnavailableError) {
          startPreset(
            client,
            'question-gen',
            `请从 ${sourceType} ${sourceId || ''} 生成 ${count} 道${type}题，难度 ${difficulty}。`,
          )
          return
        }
        throw reason
      }
    })
  }

  const exportQuestions = (format: 'json' | 'csv' | 'docx') => {
    void run(async () => {
      const result = await callLearning<{ path: string }>(client, 'exportQuestions', {
        questionIds: questions.map((question) => question.id),
        format,
      })
      window.alert(`已导出：${result.path}`)
    })
  }

  return (
    <Page
      title="出题"
      subtitle="底层是知识库与新闻。每题必须绑定知识点、答案、解析与难度；不得凭空编题。"
      actions={
        <>
          <Button onClick={() => startPreset(client, 'question-gen', '请先确认来源、题型、难度和数量，再出题。')}>
            和出题智能体对话
          </Button>
          <Button kind="primary" onClick={() => panel(client, 'knowledge')}>回知识库</Button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 0.9fr) minmax(340px, 1.1fr)', gap: 16 }}>
        <Card title="生成设置">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Field label="来源类型">
              <Select
                value={sourceType}
                onChange={(value) => setSourceType(value as typeof sourceType)}
                options={[
                  { value: 'kp', label: '知识点' },
                  { value: 'news', label: '新闻' },
                  { value: 'text', label: '自定义文本' },
                  { value: 'resource', label: '教材资源' },
                ]}
              />
            </Field>
            {sourceType === 'text' ? (
              <Field label="文本">
                <TextArea value={text} onChange={setText} placeholder="粘贴一段案例或材料" />
              </Field>
            ) : (
              <Field label={sourceType === 'kp' ? '知识点 ID' : sourceType === 'news' ? '新闻 ID' : '资源 ID'}>
                <TextInput value={sourceId} onChange={setSourceId} placeholder={sourceType === 'kp' ? 'kp_consumer_market' : '如 news-xxx'} />
              </Field>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Field label="题型">
                <Select
                  value={type}
                  onChange={(value) => setType(value as QuestionType)}
                  options={QUESTION_TYPES.map((item) => ({ value: item, label: item }))}
                />
              </Field>
              <Field label="难度">
                <Select
                  value={difficulty}
                  onChange={setDifficulty}
                  options={[{ value: '1', label: '1 基础' }, { value: '2', label: '2 应用' }, { value: '3', label: '3 综合' }]}
                />
              </Field>
            </div>
            <Field label="数量">
              <Select
                value={count}
                onChange={setCount}
                options={[1, 2, 3, 4, 5].map((item) => ({ value: String(item), label: `${item} 道` }))}
              />
            </Field>
            <Button kind="primary" disabled={busy} onClick={generate}>
              {busy ? '生成中…' : '生成题目'}
            </Button>
            {error ? <ErrorText>{error}</ErrorText> : null}
          </div>
        </Card>
        <Card title={`题目（${questions.length}）`} actions={
          questions.length > 0 ? (
            <>
              <Button onClick={() => exportQuestions('json')}>JSON</Button>
              <Button onClick={() => exportQuestions('csv')}>CSV</Button>
              <Button onClick={() => exportQuestions('docx')}>DOCX</Button>
            </>
          ) : undefined
        }>
          {questions.length === 0 ? <Empty>生成后在这里查看题目、答案与解析</Empty> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {questions.map((question, index) => (
                <div key={question.id} style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 12 }}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                    <Tag tone="accent">{question.type}</Tag>
                    <Tag tone="warning">难度 {question.difficulty}</Tag>
                    <Tag>{question.kp_ids.join(', ')}</Tag>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{index + 1}. {question.stem}</div>
                  {question.options.length > 0 ? (
                    <ul style={{ margin: '6px 0 0', paddingLeft: 20, fontSize: 12, color: COLORS.muted }}>
                      {question.options.map((option) => <li key={option}>{option}</li>)}
                    </ul>
                  ) : null}
                  <div style={{ marginTop: 8, fontSize: 12 }}><strong>答案：</strong>{question.answer}</div>
                  <div style={{ marginTop: 4, fontSize: 12, color: COLORS.muted }}><strong>解析：</strong>{question.explanation}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </Page>
  )
}

export function ResearchPage({ client }: { client: ClientContext }) {
  const [brief, setBrief] = useState('某国产美妆品牌想了解 Z 世代对国潮联名的态度')
  const [projects, setProjects] = useState<ResearchProject[]>([])
  const [selected, setSelected] = useState<ResearchProject | undefined>()
  const { busy, error, run } = useAsyncAction()

  useEffect(() => {
    void run(async () => {
      try {
        const list = await callLearning<ResearchProject[]>(client, 'listResearchProjects', {})
        setProjects(list)
      } catch (reason) {
        if (!(reason instanceof RemoteUnavailableError)) throw reason
      }
    })
  }, [])

  const create = () => {
    void run(async () => {
      const result = await callLearning<{ id: string }>(client, 'createResearchProject', { brief })
      const project = await callLearning<ResearchProject | undefined>(client, 'getResearchProject', { id: result.id })
      setProjects((current) => [project ?? { id: result.id, student_id: 'student_default', brief, status: 'draft', created_at: '', updated_at: '' }, ...current])
      setSelected(project)
    })
  }

  return (
    <Page
      title="调研教练"
      subtitle="先问清决策问题、研究问题、目标人群和约束，再给方法；每个方法都要说明取舍和风险。"
      actions={
        <Button kind="primary" onClick={() => startPreset(client, 'research', brief)}>
          和调研教练对话
        </Button>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 0.9fr) minmax(340px, 1.1fr)', gap: 16 }}>
        <Card title="研究任务">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Field label="Brief">
              <TextArea value={brief} onChange={setBrief} rows={5} />
            </Field>
            <Button kind="primary" disabled={busy || brief.trim().length === 0} onClick={create}>创建调研项目</Button>
            {error ? <ErrorText>{error}</ErrorText> : null}
            <div style={{ borderTop: `1px solid ${COLORS.border}`, paddingTop: 10 }}>
              <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>项目（{projects.length}）</h3>
              {projects.length === 0 ? <Empty>暂无项目</Empty> : projects.map((project) => (
                <Row key={project.id} active={selected?.id === project.id} onClick={() => setSelected(project)}>
                  <div style={{ fontSize: 12, fontWeight: 500 }}>{project.brief}</div>
                  <div style={{ fontSize: 11, color: COLORS.muted }}>{project.id} · {project.status}</div>
                </Row>
              ))}
            </div>
          </div>
        </Card>
        <Card title="研究设计步骤">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
            {['研究问题与目标', '方法与取舍', '抽样设计', '问卷 / 访谈提纲', '分析计划', '设计评审 L1-L4'].map((step, index) => (
              <div key={step} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ color: COLORS.accent, fontWeight: 600 }}>{index + 1}</span>
                <span>{step}</span>
              </div>
            ))}
            <p style={{ color: COLORS.muted, fontSize: 12, margin: '8px 0 0' }}>
              在对话中逐步完成；每一步都会写入研究项目，评审必须引用具体设计要素。
            </p>
            {selected ? (
              <Button onClick={() => startPreset(client, 'research', `继续研究项目：${selected.brief}`)}>继续这个项目</Button>
            ) : null}
          </div>
        </Card>
      </div>
    </Page>
  )
}

export function BpPage({ client }: { client: ClientContext }) {
  const [idea, setIdea] = useState('校园二手书交易平台')
  const [projects, setProjects] = useState<BpProject[]>([])
  const [selected, setSelected] = useState<BpProject | undefined>()
  const { busy, error, run } = useAsyncAction()

  useEffect(() => {
    void run(async () => {
      try {
        const list = await callLearning<BpProject[]>(client, 'listBpProjects', {})
        setProjects(list)
      } catch (reason) {
        if (!(reason instanceof RemoteUnavailableError)) throw reason
      }
    })
  }, [])

  const create = () => {
    void run(async () => {
      const result = await callLearning<{ id: string }>(client, 'createBpProject', { idea })
      const project = await callLearning<BpProject | undefined>(client, 'getBpProject', { id: result.id })
      setProjects((current) => [project ?? { id: result.id, student_id: 'student_default', idea, status: 'draft', created_at: '', updated_at: '' }, ...current])
      setSelected(project)
    })
  }

  const exportBp = () => {
    if (!selected) return
    void run(async () => {
      const result = await callLearning<{ path: string }>(client, 'exportBp', {
        projectId: selected.id,
        format: 'docx',
      })
      window.alert(`已导出：${result.path}`)
    })
  }

  return (
    <Page
      title="商业计划书教练"
      subtitle="每个数字都要标来源或假设；没有来源就写「假设」，不要编造市场数据。"
      actions={
        <Button kind="primary" onClick={() => startPreset(client, 'bp', idea)}>
          和 BP 教练对话
        </Button>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 0.9fr) minmax(340px, 1.1fr)', gap: 16 }}>
        <Card title="商业想法">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Field label="Idea">
              <TextArea value={idea} onChange={setIdea} rows={4} />
            </Field>
            <Button kind="primary" disabled={busy || idea.trim().length === 0} onClick={create}>创建 BP 项目</Button>
            {error ? <ErrorText>{error}</ErrorText> : null}
            <div style={{ borderTop: `1px solid ${COLORS.border}`, paddingTop: 10 }}>
              <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>项目（{projects.length}）</h3>
              {projects.length === 0 ? <Empty>暂无项目</Empty> : projects.map((project) => (
                <Row key={project.id} active={selected?.id === project.id} onClick={() => setSelected(project)}>
                  <div style={{ fontSize: 12, fontWeight: 500 }}>{project.idea}</div>
                  <div style={{ fontSize: 11, color: COLORS.muted }}>{project.id} · {project.status}</div>
                </Row>
              ))}
            </div>
          </div>
        </Card>
        <Card title="计划书结构" actions={selected ? <Button onClick={exportBp}>导出 DOCX</Button> : undefined}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
            {['执行摘要', '客户与痛点', '市场与竞争', '价值主张与商业模式', '渠道与 GTM', '财务预测', '风险与里程碑'].map((section, index) => (
              <div key={section} style={{ display: 'flex', gap: 10 }}>
                <span style={{ color: COLORS.accent, fontWeight: 600 }}>{index + 1}</span>
                <span>{section}</span>
              </div>
            ))}
            <p style={{ color: COLORS.muted, fontSize: 12, margin: '8px 0 0' }}>
              市场规模必须标注 source 或 assumption；评审按 L1-L4 给出证据与差距。
            </p>
            {selected ? (
              <Button onClick={() => startPreset(client, 'bp', `继续商业计划书项目：${selected.idea}`)}>继续这个项目</Button>
            ) : null}
          </div>
        </Card>
      </div>
    </Page>
  )
}

export function LearningSettings() {
  return (
    <Page title={`${BRAND.name} 设置`} subtitle={`本地优先；课程材料只读，所有写入都落在 ${BRAND.homeEnv}。`}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Card title="模型与数据">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
            <div>模型：由本地运行时配置决定</div>
            <div>数据库：&lt;{BRAND.homeEnv}&gt;/data/{BRAND.dbFile}</div>
            <div>导出目录：&lt;{BRAND.homeEnv}&gt;/exports</div>
            <div>新闻刷新：每 30 分钟</div>
          </div>
        </Card>
        <Card title="新闻源">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
            <div>SocialBeta</div>
            <div>联商网</div>
            <div>品牌星球</div>
            <div>华尔街见闻（seed）</div>
          </div>
        </Card>
      </div>
    </Page>
  )
}
