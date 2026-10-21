import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import yaml from 'js-yaml'
import LearningDb from '@learning-agent/db'
import { ProfileService } from '@learning-agent/profile'
import {
  CompetencySchema,
  EvidenceSchema,
  StudentProfileSchema,
  type Competency,
  type Evidence,
  type LearningPlanItem,
} from '@learning-agent/shared'
import { loadEnv, repoRoot } from './env.ts'

loadEnv()
const appHome = process.env.LEARNING_AGENT_HOME || repoRoot
const studentDir = join(repoRoot, 'data', 'students', 'student_demo')

async function readYaml(name: string): Promise<Record<string, unknown>> {
  const text = await readFile(join(studentDir, name), 'utf8')
  const value = yaml.load(text, { schema: yaml.JSON_SCHEMA })
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be a YAML object`)
  }
  return value as Record<string, unknown>
}

function dateFor(chapterNumber: number, offsetDays: number): string {
  const date = new Date(Date.UTC(2026, 8, 15 + (chapterNumber - 1) * 7 + offsetDays))
  return date.toISOString()
}

const profileDoc = await readYaml('profile.yaml')
const profile = StudentProfileSchema.parse({
  ...profileDoc,
  created_at: profileDoc.created_at ?? new Date().toISOString(),
  updated_at: profileDoc.updated_at ?? new Date().toISOString(),
})

const competencyDoc = await readYaml('competencies.yaml')
const competencies = CompetencySchema.array().parse(competencyDoc.dimensions)

const planDoc = await readYaml('plan.yaml')
const chapters = Array.isArray(planDoc.chapters) ? planDoc.chapters as Array<Record<string, unknown>> : []
const plan: LearningPlanItem[] = []
for (let index = 0; index < chapters.length; index++) {
  const chapter = chapters[index]!
  const chapterId = String(chapter.chapter_id ?? '')
  const chapterNumber = index + 1
  for (const phase of ['pre', 'learning', 'post'] as const) {
    const raw = chapter[phase]
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    plan.push({
      id: `${profile.id}:${chapterId}:${phase}`,
      student_id: profile.id,
      chapter_id: chapterId,
      phase,
      title: String(entry.title ?? `${chapterId} ${phase}`),
      tasks: Array.isArray(entry.tasks) ? entry.tasks.map(String) : [],
      status: chapterId === 'ch04' && phase === 'learning' ? 'active' : 'pending',
      due_at: dateFor(chapterNumber, phase === 'pre' ? 0 : phase === 'learning' ? 3 : 7),
      updated_at: new Date().toISOString(),
    })
  }
}

const evidenceDoc = await readYaml('evidence_seed.yaml')
const seedEvidence = Array.isArray(evidenceDoc.evidence) ? evidenceDoc.evidence as Array<Record<string, unknown>> : []
const evidence: Evidence[] = seedEvidence.map((item) => EvidenceSchema.parse({
  ...item,
  student_id: profile.id,
  // Demo evidence is synthetic: it must never masquerade as human/reviewed.
  method: 'rule',
  review_status: 'draft',
  metadata: {
    ...(item.metadata && typeof item.metadata === 'object' ? item.metadata : {}),
    synthetic: true,
    seed: 'evidence_seed.yaml',
  },
  created_at: item.created_at ?? item.occurred_at,
}))

const ctx = new Context()
await ctx.plugin(LearningDb, { appHome })
const db = ctx.learningDb

const existingProfile = db.getStudentProfile(profile.id)
if (!existingProfile) db.upsertStudentProfile(profile)
const existingCompetencyIds = new Set(db.listCompetencies().map((item) => item.id))
db.upsertCompetencies(competencies.filter((item) => !existingCompetencyIds.has(item.id)))
const existingPlanIds = new Set(db.listLearningPlan(profile.id).map((item) => item.id))
db.upsertLearningPlan(plan.filter((item) => !existingPlanIds.has(item.id)))
const inserted = db.insertEvidence(evidence)
db.markSyntheticEvidence(evidence.map((item) => item.id))

const memoryNow = new Date().toISOString()
if (!existingProfile) profile.goals.forEach((goal, index) => {
  db.upsertMemoryFact({
    id: `${profile.id}:goal:${index}`,
    student_id: profile.id,
    kind: 'goal',
    key: `goal_${index + 1}`,
    value: goal,
    confidence: 0.9,
    source: 'profile',
    updated_at: memoryNow,
  })
})
if (!existingProfile) profile.constraints.forEach((constraint, index) => {
  db.upsertMemoryFact({
    id: `${profile.id}:constraint:${index}`,
    student_id: profile.id,
    kind: 'constraint',
    key: `constraint_${index + 1}`,
    value: constraint,
    confidence: 0.85,
    source: 'profile',
    updated_at: memoryNow,
  })
})
if (!existingProfile) Object.entries(profile.preferences).forEach(([key, value]) => {
  db.upsertMemoryFact({
    id: `${profile.id}:preference:${key}`,
    student_id: profile.id,
    kind: 'preference',
    key,
    value,
    confidence: 0.8,
    source: 'profile',
    updated_at: memoryNow,
  })
})
if (!existingProfile) db.insertMemoryEpisode({
  id: `${profile.id}:episode:ch04_pre`,
  student_id: profile.id,
  session_id: 'demo_pre',
  summary: '【合成演示，不代表真实学习记录】第 4 章前测示例：学生倾向把销量下滑归因为曝光不足，能说出假设但缺少验证标准。',
  decisions: ['先加预算', '同时投小红书和抖音'],
  open_questions: ['如何区分需求结构与渠道效率？', '什么证据能推翻曝光假设？'],
  created_at: '2026-09-20T10:30:00+08:00',
})
if (!existingProfile) db.insertMemoryEpisode({
  id: `${profile.id}:episode:ch04_post`,
  student_id: profile.id,
  session_id: 'demo_post',
  summary: '【合成演示，不代表真实学习记录】第 4 章后测示例：学生把问题拆成渠道效率与产品匹配，给出条件性主张，预算/组织/退出条件仍不完整。',
  decisions: ['先不加预算，做两周渠道效率诊断', '按诊断结果决定是否追加预算'],
  open_questions: ['退出条件是什么？', '如何在组织内推动渠道调整？'],
  created_at: '2026-10-12T20:10:00+08:00',
})

ctx.provide('llm', {
  async *stream() {
    // Snapshot calculation does not call the model.
  },
})
const profileService = new ProfileService(ctx)
if (!existingProfile) {
  profileService.recordSnapshot(profile.id, 'ch04', 'pre')
  profileService.recordSnapshot(profile.id, 'ch04', 'post')
}

console.log(JSON.stringify({
  appHome,
  db: db.dbPath,
  student: profile.id,
  name: profile.name,
  competencies: db.listCompetencies().length,
  plan_items: db.listLearningPlan(profile.id).length,
  evidence_seed: evidence.length,
  evidence_inserted: inserted,
  evidence_total: db.listEvidence({ studentId: profile.id, limit: 500 }).length,
}, null, 2))
