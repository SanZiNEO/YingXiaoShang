import { Service, type Context } from '@deepseek-ai/cordis'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeDocx, writeMarkdown, type DocBlock } from '@learning-agent/export'
import { QuestionSetContentSchema, type Artifact } from '@learning-agent/shared'
import { isPathUnder } from '@learning-agent/shared/containment'
import type {} from '@learning-agent/db'

declare module '@deepseek-ai/cordis' {
  interface Context {
    artifacts: ArtifactService
  }
}

export interface ArtifactDraft {
  studentId: string
  sessionId?: string
  skillId: string
  templateId?: string
  type: Artifact['type']
  title: string
  format?: Artifact['format']
  content: string
  contentJson?: unknown
  schemaVersion?: string
  sourceRefs?: string[]
  evidenceIds?: string[]
  status?: Artifact['status']
}

export interface ArtifactServiceConfig {
  appHome: string
  templatesDir: string
}

function markdownToBlocks(markdown: string): DocBlock[] {
  const blocks: DocBlock[] = []
  let list: string[] = []
  const flush = () => {
    if (list.length > 0) {
      blocks.push({ list })
      list = []
    }
  }
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      flush()
      blocks.push({ heading: line.slice(3).trim() })
    } else if (line.startsWith('# ')) {
      flush()
      blocks.push({ heading: line.slice(2).trim() })
    } else if (line.startsWith('- ')) {
      list.push(line.slice(2).trim())
    } else if (line.trim().length === 0) {
      flush()
    } else {
      flush()
      blocks.push({ text: line.trim() })
    }
  }
  flush()
  return blocks
}

/** The printable question paper never contains the answer key kept for grading. */
function questionDocument(content: unknown, markdown: string): string {
  const parsed = QuestionSetContentSchema.safeParse(content)
  if (!parsed.success || parsed.data.questions.length === 0) {
    // Older question papers used this template before structured content existed.
    const questionHeading = /^##\s+题目\s*$/m.exec(markdown)
    const answerHeading = /^##\s+答案与解析\s*$/m.exec(markdown)
    if (questionHeading && answerHeading && questionHeading.index < answerHeading.index) {
      return `${markdown.slice(0, answerHeading.index).trim()}\n\n交卷后请在学习界面查看逐题反馈。`
    }
    return '题目集暂时无法预览，请回到学习界面重新打开。参考答案仅在交卷后显示。'
  }
  const lines = [parsed.data.intro, '']
  for (const [index, question] of parsed.data.questions.entries()) {
    lines.push(`## 第 ${index + 1} 题 · ${question.type}`, '', question.stem, '')
    for (const [optionIndex, option] of question.options.entries()) {
      lines.push(`${String.fromCharCode(65 + optionIndex)}. ${option}`)
    }
    lines.push('')
  }
  lines.push('本文件为练习题卷，不包含参考答案；交卷后可在学习界面查看逐题反馈。')
  return lines.join('\n')
}

export class ArtifactService extends Service {
  static inject = ['learningDb']
  private readonly appHome: string
  private readonly templatesDir: string

  constructor(ctx: Context, config: ArtifactServiceConfig) {
    super(ctx, 'artifacts')
    this.appHome = config.appHome
    this.templatesDir = config.templatesDir
  }

  async renderTemplate(templateId: string, vars: Record<string, string>): Promise<string> {
    const text = await readFile(join(this.templatesDir, `${templateId}.md`), 'utf8')
    return text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, key: string) => vars[key] ?? '')
  }

  async create(draft: ArtifactDraft): Promise<Artifact> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(draft.studentId)) {
      throw new Error('Invalid student identifier; no artifact was written.')
    }
    const id = `art_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    const created = new Date().toISOString()
    const month = created.slice(0, 7)
    const dir = join(this.appHome, 'artifacts', draft.studentId, month)
    if (!(await isPathUnder(dir, join(this.appHome, 'artifacts')))) {
      throw new Error('PATH_OUTSIDE_APP: artifact directory is outside the application home.')
    }
    await mkdir(dir, { recursive: true })
    const format = draft.format ?? 'md'
    const content = draft.type === 'question_set' ? questionDocument(draft.contentJson, draft.content) : draft.content
    let path: string
    if (format === 'html') {
      // 页面类产物本身就是终态，不再转 Markdown / Word：转出来是一堆标签。
      path = join(dir, `${id}.html`)
      await writeFile(path, content, 'utf8')
    } else {
      const markdownPath = join(dir, `${id}.md`)
      await writeMarkdown(markdownPath, draft.title, markdownToBlocks(content))
      path = markdownPath
      if (format === 'docx') {
        path = join(dir, `${id}.docx`)
        await writeDocx(path, draft.title, markdownToBlocks(content))
      }
    }
    const artifact: Artifact = {
      id,
      student_id: draft.studentId,
      session_id: draft.sessionId ?? '',
      skill_id: draft.skillId,
      template_id: draft.templateId ?? '',
      type: draft.type,
      title: draft.title,
      format,
      path,
      content,
      content_json: draft.contentJson ?? {},
      schema_version: draft.schemaVersion ?? 'Markdown@1',
      version: 1,
      status: draft.status ?? 'ready',
      source_refs: draft.sourceRefs ?? [],
      evidence_ids: draft.evidenceIds ?? [],
      created_at: created,
    }
    this.ctx.learningDb.insertArtifact(artifact)
    return artifact
  }

  list(studentId: string, limit = 20): Artifact[] {
    return this.ctx.learningDb.listArtifacts(studentId, limit).map((artifact) =>
      artifact.type === 'question_set'
        ? { ...artifact, content: questionDocument(artifact.content_json, artifact.content) }
        : artifact)
  }

  get(id: string): Artifact | undefined {
    const artifact = this.ctx.learningDb.getArtifact(id)
    return artifact?.type === 'question_set'
      ? { ...artifact, content: questionDocument(artifact.content_json, artifact.content) }
      : artifact
  }

  async export(id: string, format: 'md' | 'docx' | 'html'): Promise<{ path: string }> {
    const artifact = this.get(id)
    if (!artifact) throw new Error(`artifact not found: ${id}`)
    // 页面类产物只有 HTML 一种形态。要 md/docx 时给 HTML 原件，
    // 而不是把标签当正文转一份出来。
    if (artifact.format === 'html') return { path: artifact.path }
    const target = join(dirname(artifact.path), `${artifact.id}.${format === 'docx' ? 'docx' : 'md'}`)
    if (!(await isPathUnder(target, this.appHome))) {
      throw new Error('PATH_OUTSIDE_APP: export is outside the application home.')
    }
    if (format === 'docx') {
      await writeDocx(target, artifact.title, markdownToBlocks(artifact.content))
    } else {
      await writeMarkdown(target, artifact.title, markdownToBlocks(artifact.content))
    }
    return { path: target }
  }

  async writeTextFile(relativePath: string, content: string): Promise<string> {
    const target = join(this.appHome, relativePath)
    if (!(await isPathUnder(target, this.appHome))) {
      throw new Error('PATH_OUTSIDE_APP: text file is outside the application home.')
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
    return target
  }
}
