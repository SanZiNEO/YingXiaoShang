import type { Context } from '@deepseek-ai/cordis'
import type {
  ArtifactDraft,
  CaseStudyContent,
  Citation,
  KnowledgePoint,
  NewsArticle,
  SubagentResult,
  TurnStep,
} from '@learning-agent/shared'
import type {} from '@learning-agent/db'
import type {} from '@learning-agent/matcher'
import {
  BUYING_ROLE_DEFINITIONS,
  BUYING_ROLE_NAMES,
  SUPERMARKET_META,
  caseStudyMarkdown,
  collectTextbookEvidence,
  counterexampleText,
  demoNote,
  evidenceForPart,
  findCaseArticles,
  learningLoyaltyStandard,
  locateQuote,
  partWantsLoyalty,
  partWantsOrganization,
  partWantsRoles,
  roleSummary,
  selectMaterialKps,
  type MaterialEvidence,
  type MaterialPart,
  type SupplementalKp,
} from './case-library.js'
import type { StepContext } from './subagents.js'
import { topicLabel } from './text.js'

interface CoveragePartInput {
  id?: unknown
  kind?: unknown
  label?: unknown
  question?: unknown
  kpIds?: unknown
  required?: unknown
}

interface CoverageInput {
  parts?: unknown
  focusPartIds?: unknown
}

interface ModelDraftPart {
  partId?: unknown
  kpIds?: unknown
  caseMapping?: unknown
  dialogue?: unknown
  takeaway?: unknown
  boundary?: unknown
  checkQuestion?: unknown
  evidence?: unknown
}

interface PartMaterial {
  part: MaterialPart
  kps: KnowledgePoint[]
  supplemental: SupplementalKp[]
  evidence: MaterialEvidence[]
  warnings: string[]
  missing: string[]
}

interface ValidatedDraft {
  caseMapping: string
  dialogue: Array<{ role: 'student' | 'mentor'; text: string }>
  takeaway: string
  boundary: string
  checkQuestion: string
  evidence: MaterialEvidence[]
  kpIds: string[]
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** Plan input is untrusted JSON; fields are checked again in parseParts. */
function coverageFrom(input: Record<string, unknown>): CoverageInput | undefined {
  const value = input.coverage
  if (typeof value !== 'object' || value === null) return undefined
  return value as CoverageInput
}

function rawCoveragePartCount(input: Record<string, unknown>): number | undefined {
  const value = input.coverage
  if (typeof value !== 'object' || value === null || !('parts' in value)) return undefined
  return Array.isArray(value.parts) ? value.parts.length : undefined
}

function parseParts(input: Record<string, unknown>, message: string): MaterialPart[] {
  const coverage = coverageFrom(input)
  const focusIds = new Set(strings(coverage?.focusPartIds))
  const raw = Array.isArray(coverage?.parts) ? coverage.parts as CoveragePartInput[] : []
  const parsed = raw
    .map((part, index): MaterialPart | undefined => {
      if (typeof part !== 'object' || part === null) return undefined
      const label = typeof part.label === 'string' ? part.label.trim() : ''
      const question = typeof part.question === 'string' ? part.question.trim() : ''
      if (label.length === 0 && question.length === 0) return undefined
      return {
        id: typeof part.id === 'string' && part.id.length > 0 ? part.id : `part_${index + 1}`,
        kind: typeof part.kind === 'string' ? part.kind : 'concept',
        label: label || question.slice(0, 18),
        question: question || label,
        kpIds: strings(part.kpIds),
        required: part.required !== false,
      }
    })
    .filter((part): part is MaterialPart => part !== undefined)
  if (parsed.length > 0) {
    const focused = focusIds.size > 0
      ? parsed.filter((part) => focusIds.has(part.id) || (part.kpIds ?? []).some((id) => focusIds.has(id)))
      : parsed
    return focused.length > 0 ? focused : parsed
  }

  // Fallback only when the routing contract did not supply coverage.
  const parts: MaterialPart[] = []
  if (/组织市场|消费者市场|最终用途|为什么.*消费者/.test(message)) {
    parts.push({
      id: 'consumer_market',
      kind: 'comparison',
      label: '消费者还是组织市场',
      question: '为什么进店的人是消费者，而不是组织市场？判断标准和例外是什么？',
    })
  }
  if (/角色|发起者|影响者|决策者|购买者|使用者|谁买/.test(message)) {
    parts.push({
      id: 'buying_roles',
      kind: 'roles',
      label: '购买决策参与者',
      question: '一次购买中可能有哪些角色？单人会不会同时承担多个角色？',
    })
  }
  if (/学习|忠诚|品牌忠诚|复购|打卡|跨城/.test(message)) {
    const comparesLoyalty = /忠诚|品牌|区别|区分|对比|vs|VS/.test(message)
    parts.push({
      id: 'learning_loyalty',
      kind: 'standard',
      label: comparesLoyalty ? '消费者学习与品牌忠诚' : '消费者学习',
      question: comparesLoyalty
        ? '消费者学习和品牌忠诚怎么区分？判断标准是什么？'
        : '消费者学习指什么？判断时关键看什么？',
    })
  }
  if (/反例|例外|判断标准/.test(message)) {
    parts.push({
      id: 'counterexample',
      kind: 'counterexample',
      label: '反例与边界',
      question: '给出一个反例，说明判断在什么情况下不成立。',
    })
  }
  if (parts.length === 0) {
    parts.push({
      id: 'main',
      kind: 'concept',
      label: topicLabel(message),
      question: message,
    })
  }
  return parts
}

function chapterKpLabel(db: Context['learningDb'], chapterId: string, kp: KnowledgePoint): string {
  const chapter = db.listChapters().find((item) => item.id === chapterId)
  const section = db.listSections(chapterId).find((item) => item.id === kp.section_id)
  return [chapter ? `第${chapter.number}章 ${chapter.title}` : '', section?.title ?? '']
    .filter((item) => item.length > 0)
    .join(' · ') || kp.source
}

function supplementalAsKp(item: SupplementalKp, chapterId: string): KnowledgePoint {
  return {
    id: item.id,
    chapter_id: chapterId,
    section_id: '',
    name: item.name,
    name_en: '',
    definition: item.definition,
    keywords: item.aliases,
    examples: [],
    non_examples: [],
    aliases: item.aliases,
    difficulty: 2,
    competencies: [],
    decisions: [],
    source: item.definitionSource,
    status: 'draft',
  }
}

function buildPartMaterials(
  ctx: Context,
  chapterId: string,
  parts: MaterialPart[],
  query: string,
  companies: string[],
): { materials: PartMaterial[]; warnings: string[]; caseArticles: NewsArticle[] } {
  const warnings: string[] = []
  const caseArticles = findCaseArticles(ctx.learningDb, query, companies)
  const materials = parts.map((part) => {
    const resolved = selectMaterialKps(ctx.learningDb, chapterId, part)
    const kps = [
      ...resolved.kps,
      ...resolved.supplemental.map((item) => supplementalAsKp(item, chapterId)),
    ]
    const partWarnings: string[] = []
    const evidence: MaterialEvidence[] = []
    const seen = new Set<string>()

    for (const kp of kps) {
      const collected = collectTextbookEvidence(ctx.learningDb, chapterId, kp)
      partWarnings.push(...collected.warnings)
      for (const item of collected.items) {
        const key = `${item.sourceType}:${item.sourceId}:${item.quote}`
        if (seen.has(key)) continue
        seen.add(key)
        evidence.push(item)
      }
    }

    const kpIds = kps.map((kp) => kp.id)
    for (const article of caseArticles) {
      if (evidence.filter((item) => item.sourceType === 'news').length >= 2) break
      const found = evidenceForPart(ctx.learningDb, article, part, kpIds)
      if (!found) continue
      const key = `${found.sourceType}:${found.sourceId}:${found.quote}`
      if (seen.has(key)) continue
      seen.add(key)
      evidence.push(found)
    }

    if (resolved.supplemental.length > 0) {
      partWarnings.push(
        `课程数据暂未收录「${resolved.supplemental.map((item) => item.name).join('、')}」，已使用补充定义（未人审），未冒充教材原文。`,
      )
    }
    if (resolved.missing.length > 0) {
      partWarnings.push(`课程中没有找到「${resolved.missing.join('、')}」，该部分只按已有材料回答。`)
    }
    if (evidence.length === 0 && part.kind !== 'counterexample') {
      partWarnings.push(`「${part.label}」没有检索到可核对的教材块或新闻原文，只保留课程定义与判断标准。`)
    }
    if (kps.length === 0 && part.kind !== 'counterexample') {
      partWarnings.push(`「${part.label}」没有找到课程知识点，无法展开。`)
    }

    return {
      part,
      kps,
      supplemental: resolved.supplemental,
      evidence,
      warnings: partWarnings,
      missing: resolved.missing,
    }
  })

  for (const material of materials) warnings.push(...material.warnings)
  return { materials, warnings, caseArticles }
}

function caseMappingForKp(
  material: PartMaterial,
  kp: KnowledgePoint,
  supermarket: boolean,
): string {
  const part = material.part
  const place = supermarket ? '本轮商超购物情境' : '你问的这个情境'
  const quote = material.evidence.find((item) => item.kpIds.includes(kp.id))?.quote
  const evidenceNote = quote ? `原文证据是：“${quote}”。` : ''

  if (partWantsOrganization(part) || part.id === 'consumer_market') {
    if (/组织市场/.test(kp.name)) {
      return `把「${kp.name}」放回${place}：如果购买者是餐馆、食堂或便利店，买回去用于做菜再卖、转售或组织运行，就属于组织市场。分界线是最终用途，不是购买数量；小餐馆临时买一袋土豆，也可能是组织市场。${evidenceNote}`
    }
    if (/消费者市场/.test(kp.name)) {
      return `这些个人和家庭为了生活消费而购买，合起来就是消费者市场。${place}的业态、价格带和服务不同，但服务的市场类型相同；细分市场不等于另一个市场类型。${evidenceNote}`
    }
    return `先看最终用途：${place}的顾客如果买的是自己和家庭要吃、要用的商品，就是生活消费，属于消费者。商品包装、选址客群、价格和交易方式只是辅助线索，不能替代“买来给谁用”。${evidenceNote}`
  }
  if (partWantsRoles(part)) {
    return `一次购买可以拆成五个角色：${roleSummary()} 在${place}的日常购物里，同一位顾客常常同时承担发起者、决策者、购买者和使用者；影响者可能是家人、朋友、店员或测评内容。角色分离更常见于组织采购，但这不改变消费者市场的判断。${evidenceNote}`
  }
  if (partWantsLoyalty(part)) {
    if (/品牌忠诚|忠诚/.test(kp.name)) {
      const loyaltyScenario = /顺路|跨城|打卡|复购/.test(part.question)
        ? '一次跨城打卡不足以判定忠诚；要看在存在可选替代时是否仍保持稳定偏好并重复选择。如果跨城来自经验形成的判断规则变化，那是学习过程；忠诚是结果/表现，两者可以并存。注意：题目里的“顺路买→跨城打卡”是假设情境，不是这条新闻已证实的事实。'
        : '如果消费者在存在可选替代时仍保持稳定偏好、重复选择且转换意愿低，更像忠诚；但它是否由经验导致，还要另看学习证据。'
      return `「${kp.name}」看结果：在存在可选替代时是否稳定偏好、重复选择，并且转换意愿低。${loyaltyScenario}${evidenceNote}`
    }
    const scenario = /顺路|跨城|打卡|复购/.test(part.question)
      ? '从“顺路买”变成“跨城打卡”，不能只凭这一次行为判定学习；要看跨城是否来自经验形成的判断规则变化，并且下一次选择是否也改变。如果只是稳定偏好和重复选择，更像忠诚。'
      : '如果一次或多次体验改变了消费者下一次的判断规则，更像学习；如果只是稳定偏好，则更像忠诚。'
    return `「${kp.name}」看过程：经验有没有改变行为或行为潜能，关键是下一次的判断规则有没有变。${scenario}两者可以同时存在，但证据不同。${evidenceNote}`
  }
  if (part.kind === 'counterexample') return counterexampleText()
  const definition = kp.definition
  return supermarket
    ? `用课程定义看，「${kp.name}」的核心是：${definition} 放回${place}：顾客买生鲜、熟食和日用品供自己和家庭消费，符合这个定义；如果购买目的是转售或生产经营，就要改判为组织市场。${evidenceNote}`
    : `用课程定义看，「${kp.name}」的核心是：${definition} 放回你问的情境，先找出符合定义的核心特征，再用原文证据检验；没有证据的地方只能算教学推断。${evidenceNote}`
}

function dialogueForKp(material: PartMaterial, kp: KnowledgePoint, supermarket: boolean): Array<{ role: 'student' | 'mentor'; text: string }> {
  const part = material.part
  const place = supermarket ? '这三家商超' : '这个情境'
  if (partWantsOrganization(part) || part.id === 'consumer_market') {
    if (/组织市场/.test(kp.name)) {
      return [
        { role: 'student', text: `如果开餐馆的人来${place}买土豆，也算消费者吗？` },
        { role: 'mentor', text: '要看他买回去做什么。用于餐馆做菜再卖，是生产经营用途，属于组织市场；买回家自己吃，才是生活消费。' },
        { role: 'student', text: '那买得多就一定是组织市场吗？' },
        { role: 'mentor', text: '不是。数量、金额、包装都不是分界线，最终用途才是。小餐馆临时买一点，也可能是组织市场。' },
      ]
    }
    if (/消费者市场/.test(kp.name)) {
      return [
        { role: 'student', text: '三家超市定位不一样，为什么都叫消费者市场？' },
        { role: 'mentor', text: '市场类型看“谁买、为什么买”，不看门店风格。它们都面向个人和家庭的生活消费，所以属于消费者市场。' },
        { role: 'student', text: '那高端店和平价店不是不同的市场吗？' },
        { role: 'mentor', text: '那是同一消费者市场里的细分。客群、价格带和品类结构不同，但购买目的仍是生活消费。' },
      ]
    }
    return [
      { role: 'student', text: `为什么进${place}买东西的人都是消费者？` },
      { role: 'mentor', text: '先看购买用途，不看店招。消费者不是按“去哪家店”定义的，而是按“为什么买、买来干什么”定义的。' },
      { role: 'student', text: '那如果我是开餐馆的，来买很多土豆呢？' },
      { role: 'mentor', text: '买回去给餐馆做菜再卖，属于组织市场的购买；买回家自己吃，才是生活消费。分界线是最终用途，不是买了多少。' },
    ]
  }
  if (partWantsRoles(part)) {
    return [
      { role: 'student', text: '一次购买里到底有哪几个角色？' },
      { role: 'mentor', text: `可以拆成五个：${BUYING_ROLE_NAMES.map((name) => `${name}（${BUYING_ROLE_DEFINITIONS[name]}）`).join('；')}` },
      { role: 'student', text: '那一个人去买菜，不可能同时是五个人吧？' },
      { role: 'mentor', text: '可以同时承担多个角色。家庭日常购物里，同一个人常常既发起、又决策、又付款、又使用；影响者可能是家人或店员。' },
    ]
  }
  if (partWantsLoyalty(part)) {
    if (/品牌忠诚|忠诚/.test(kp.name)) {
      return [
        { role: 'student', text: '那品牌忠诚是不是就是一直买同一个牌子？' },
        { role: 'mentor', text: '不只看重复购买。忠诚还要看存在可选替代时是否仍有稳定偏好、转换意愿是否低；便利、合约或转换成本也会造成重复购买。' },
        { role: 'student', text: '所以一次跨城打卡也不能直接算忠诚？' },
        { role: 'mentor', text: '对。单次行为不够。反例是顾客只因顺路或价格低每周买同一家，没有品牌偏好，也谈不上忠诚。' },
      ]
    }
    const subject = supermarket ? '去超市买东西' : '一次消费体验'
    const example = supermarket ? '这家店的熟食可以放心买' : '这个品牌的产品可以放心买'
    return [
      { role: 'student', text: `“学习”不是指看书上课吗？为什么${subject}也算学习？` },
      { role: 'mentor', text: `营销学里的学习，看的是经验有没有改变行为或行为潜能。你开始形成“${example}”的判断规则，就是学习。` },
      { role: 'student', text: '那每次买差不多的东西，或者一次跨城打卡，算学习吗？' },
      { role: 'mentor', text: '重复和单次跨城本身都不算。关键是有没有形成新的判断规则；只是顺路、习惯或一次打卡，不能仅凭行为判定学习。' },
    ]
  }
  return [
    { role: 'student', text: `「${kp.name}」在这个问题里到底指什么？` },
    { role: 'mentor', text: `先回到定义：${kp.definition}` },
    { role: 'student', text: '那怎么判断它成不成立？' },
    { role: 'mentor', text: '找符合定义的核心特征，再看原文证据；如果证据只支持相邻概念，就不要把它写成这个概念的结论。' },
  ]
}

function takeawayForKp(material: PartMaterial, kp: KnowledgePoint): string {
  const part = material.part
  if (partWantsOrganization(part) || part.id === 'consumer_market') {
    if (/组织市场/.test(kp.name)) return '用于生产、转售或组织运行 → 组织市场；数量不是分界线。'
    if (/消费者市场/.test(kp.name)) return '先判断市场类型，再看细分与定位；不要用门店风格替代购买目的。'
    return '判断一个人是不是消费者，先问“买来给谁用”，而不是“在哪买、买多少”。'
  }
  if (partWantsRoles(part)) return '先列五个角色，再问每个角色由谁承担；单人全担并不矛盾。'
  if (partWantsLoyalty(part)) {
    return /品牌忠诚|忠诚/.test(kp.name)
      ? '忠诚看结果：存在可选替代时仍稳定偏好、重复选择、低转换意愿，缺一不可。'
      : '学习看过程：经验有没有改变下一次的判断规则。'
  }
  return `判断「${kp.name}」时，先回到定义的核心特征，再用原文证据检验。`
}

function boundaryForKp(material: PartMaterial, kp: KnowledgePoint): string {
  const part = material.part
  if (partWantsOrganization(part) || part.id === 'consumer_market') {
    if (/组织市场/.test(kp.name)) return '小餐馆临时采购也可能是组织市场；不要用采购量判断。'
    if (/消费者市场/.test(kp.name)) return '购买者是组织且用于生产经营时，进入组织市场，而不是消费者市场。'
    return '批量采购、转售、生产经营用途不属于生活消费，不能直接算作消费者。'
  }
  if (partWantsRoles(part)) return '组织采购中角色可能分离，不能把消费者市场的角色分工直接套到组织市场。'
  if (partWantsLoyalty(part)) {
    return /品牌忠诚|忠诚/.test(kp.name)
      ? '没有稳定偏好和低转换意愿，不能仅凭复购称忠诚。'
      : '重复购买可能来自便利、价格或合约，不能单独证明学习。'
  }
  return `如果证据只支持相邻概念，不要把它写成「${kp.name}」的结论。`
}

function checkQuestionForKp(material: PartMaterial, kp: KnowledgePoint): string {
  const part = material.part
  if (partWantsOrganization(part) || part.id === 'consumer_market') {
    if (/组织市场/.test(kp.name)) return '一家小餐馆临时来买一袋土豆，买回去做菜卖，属于消费者市场还是组织市场？为什么？'
    return '如果一个人买 20 箱矿泉水放在自己开的便利店卖，他还是这个案例里的消费者吗？'
  }
  if (partWantsRoles(part)) return '一次家庭买菜里，发起者、影响者、决策者、购买者和使用者分别可能是谁？'
  if (partWantsLoyalty(part)) {
    return /品牌忠诚|忠诚/.test(kp.name)
      ? '重复购买一定等于品牌忠诚吗？举一个反例。'
      : '一位顾客每周顺路复购，另一位只去过两次却跨城，谁更可能发生学习？还需要什么证据？'
  }
  return '换一个情境，这个定义还成立吗？哪条证据会推翻它？'
}

function coverageSummary(material: PartMaterial, supermarket: boolean): string {
  const part = material.part
  if (part.kind === 'counterexample' || part.id === 'counterexample') return counterexampleText()
  if (partWantsOrganization(part) || part.id === 'consumer_market') {
    return `按最终用途判断：个人和家庭为生活消费而购买 → 消费者市场；餐馆、食堂、便利店等用于生产、转售或组织运行 → 组织市场。${supermarket ? '三家商超的普通顾客买生鲜、熟食和日用品供家庭消费，是消费者；开餐馆来进货则进入组织市场。' : '数量、金额、店型都不是分界线。'}`
  }
  if (partWantsRoles(part)) {
    return `五种购买角色：${BUYING_ROLE_NAMES.join('、')}。${roleSummary()} 单人可以同时承担多个角色；组织采购中角色更可能分离。`
  }
  if (partWantsLoyalty(part)) {
    const hasLoyalty = material.kps.some((kp) => /忠诚/.test(kp.name))
    return hasLoyalty
      ? `${learningLoyaltyStandard()} 反例：只因顺路、价格低而复购，不构成学习，也不必然是品牌忠诚。`
      : '消费者学习强调经验引起的行为或行为潜能变化，关键看下一次的判断规则有没有变；重复购买本身不等于学习。'
  }
  const definitions = material.kps.map((kp) => `${kp.name}：${kp.definition}`).join('；')
  return definitions || `「${part.label}」没有检索到课程定义。`
}

function validatedModelDraft(
  raw: unknown,
  materials: PartMaterial[],
): { drafts: Record<string, ValidatedDraft>; warnings: string[] } {
  const warnings: string[] = []
  const drafts: Record<string, ValidatedDraft> = {}
  const source = raw as { parts?: unknown } | undefined
  if (!source || !Array.isArray(source.parts)) return { drafts, warnings: ['模型返回的结构不合法，已使用教学示例。'] }

  for (const item of source.parts as ModelDraftPart[]) {
    if (typeof item !== 'object' || item === null) continue
    const partId = typeof item.partId === 'string' ? item.partId : ''
    const material = materials.find((entry) => entry.part.id === partId)
    if (!material) {
      warnings.push(`模型返回了未知问题块 ${partId || '(empty)'}，已丢弃。`)
      continue
    }
    const kpIds = strings(item.kpIds).filter((id) => material.kps.some((kp) => kp.id === id))
    const caseMapping = typeof item.caseMapping === 'string' ? item.caseMapping.trim() : ''
    const takeaway = typeof item.takeaway === 'string' ? item.takeaway.trim() : ''
    const boundary = typeof item.boundary === 'string' ? item.boundary.trim() : ''
    const checkQuestion = typeof item.checkQuestion === 'string' ? item.checkQuestion.trim() : ''
    const dialogue = Array.isArray(item.dialogue)
      ? item.dialogue
          .map((turn) => {
            const row = turn as { role?: unknown; text?: unknown }
            if (row.role !== 'student' && row.role !== 'mentor') return undefined
            if (typeof row.text !== 'string' || row.text.trim().length === 0) return undefined
            return { role: row.role, text: row.text.trim() }
          })
          .filter((turn): turn is { role: 'student' | 'mentor'; text: string } => turn !== undefined)
      : []
    const evidenceRefs = Array.isArray(item.evidence)
      ? item.evidence
          .map((ref) => {
            const row = ref as { sourceId?: unknown; quote?: unknown }
            if (typeof row.sourceId !== 'string' || typeof row.quote !== 'string') return undefined
            const evidence = material.evidence.find((candidate) => candidate.sourceId === row.sourceId)
            if (!evidence) return undefined
            const located = locateQuote(evidence.text, row.quote)
            if (!located) return undefined
            return { ...evidence, quote: located.quote }
          })
          .filter((ref): ref is MaterialEvidence => ref !== undefined)
      : []
    const quotesInProse = [caseMapping, takeaway, boundary, checkQuestion, ...dialogue.map((turn) => turn.text)]
      .flatMap((text) => [...text.matchAll(/“([^”]{4,})”/g)].map((match) => match[1] ?? ''))
    const proseQuotesValid = quotesInProse.every((quote) =>
      material.evidence.some((evidence) => locateQuote(evidence.text, quote) !== undefined)
      || material.kps.some((kp) => kp.definition.includes(quote)),
    )

    if (
      caseMapping.length < 20
      || takeaway.length === 0
      || boundary.length === 0
      || dialogue.length < 4
      || dialogue[0]?.role !== 'student'
      || !dialogue.some((turn) => turn.role === 'mentor')
      || !proseQuotesValid
    ) {
      warnings.push(`模型对「${material.part.label}」的生成未通过结构或引文校验，已改用教学示例。`)
      continue
    }
    drafts[partId] = { caseMapping, dialogue, takeaway, boundary, checkQuestion, evidence: evidenceRefs, kpIds }
  }
  return { drafts, warnings }
}

async function modelDraft(
  ctx: Context,
  query: string,
  materials: PartMaterial[],
): Promise<{ drafts: Record<string, ValidatedDraft>; warnings: string[] }> {
  // This package does not depend on the LLM type package; the service is optional at runtime.
  const ctxWithLlm = ctx as unknown as { llm?: { stream: (input: unknown) => AsyncIterable<unknown> } }
  const llm = ctxWithLlm.llm
  if (!llm) return { drafts: {}, warnings: [] }

  const prompt = [
    '你正在为一门市场营销课准备案例精讲材料。只输出一个 JSON 对象，不要 Markdown，不要解释。',
    '要求：逐块回答用户问题；不得编造新闻事实；引文必须从给定证据中原样复制；没有证据的判断写成教学推断。',
    '对话必须是教学示例的示例对话，第一句由示例学生提问，4–8 轮。',
    '',
    `用户问题：${query}`,
    '',
    '问题块：',
    ...materials.map((material) => [
      `- id=${material.part.id} | 类型=${material.part.kind} | 标题=${material.part.label}`,
      `  子问题=${material.part.question}`,
      `  知识点=${material.kps.map((kp) => `${kp.id}:${kp.name}:${kp.definition}`).join(' || ') || '无'}`,
      `  可用证据=${material.evidence.map((item) => `${item.sourceId} :: ${item.quote}`).join(' || ') || '无'}`,
    ].join('\n')),
    '',
    '输出 schema：',
    '{"parts":[{"partId":"...","kpIds":["..."],"caseMapping":"...","dialogue":[{"role":"student","text":"..."},{"role":"mentor","text":"..."}],"takeaway":"...","boundary":"...","checkQuestion":"...","evidence":[{"sourceId":"...","quote":"..."}]}]}',
  ].join('\n')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 7_000)
  try {
    const chunks: string[] = []
    for await (const chunk of llm.stream({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      system: '你是严谨的营销课程助教。只依据给定知识点和证据写案例材料，证据必须原样引用，不得编造。只输出 JSON。',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: 3_500,
      signal: controller.signal,
    })) {
      const value = chunk as { type?: string; text?: string }
      if (value.type === 'text-delta' && typeof value.text === 'string') chunks.push(value.text)
    }
    const text = chunks.join('').trim()
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) {
      return { drafts: {}, warnings: ['模型没有返回可解析的案例结构，已使用教学示例。'] }
    }
    const validated = validatedModelDraft(JSON.parse(text.slice(start, end + 1)), materials)
    if (Object.keys(validated.drafts).length === 0) {
      validated.warnings.push('模型没有给出通过校验的案例部分，已使用教学示例。')
    }
    return validated
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      drafts: {},
      warnings: [
        /abort|timeout/i.test(message)
          ? '模型生成超时，已使用教学示例。'
          : `模型不可用，已使用教学示例：${message}`,
      ],
    }
  } finally {
    clearTimeout(timer)
  }
}

function partStatus(material: PartMaterial): 'covered' | 'partial' | 'missing' {
  if (material.part.kind === 'counterexample' || material.part.id === 'counterexample') return 'covered'
  if (material.kps.length === 0) return 'missing'
  if (material.kps.every((kp) => kp.definition.trim().length === 0)) return 'missing'
  return 'covered'
}

export class CaseCoachAgent {
  constructor(private readonly ctx: Context) {}

  async run(step: TurnStep, context: StepContext): Promise<SubagentResult> {
    const input = step.input
    const query = typeof input.query === 'string' && input.query.trim().length > 0
      ? input.query
      : context.message
    const chapterId = typeof input.chapterId === 'string' && input.chapterId.length > 0
      ? input.chapterId
      : context.chapterId || 'ch04'
    const coverageInput = coverageFrom(input)
    const focusPartIds = strings(coverageInput?.focusPartIds)
    const partLevelFocus = focusPartIds.length > 0
    const focusKpIds = new Set([
      ...strings(input.focusKpIds),
      ...focusPartIds.filter((id) => id.startsWith('kp_')),
    ])
    const parts = parseParts(input, query)
    const applyKpFocus = !partLevelFocus && parts.length === 1
    const originalPartCount = rawCoveragePartCount(input) ?? parts.length
    const supermarket = /胖东来|永辉|步步高|商超|超市/.test(`${query} ${parts.map((part) => part.label).join(' ')}`)
    const mentionedCompanies = SUPERMARKET_META.companies.filter((company) => query.includes(company))
    const companies = supermarket
      ? mentionedCompanies.length > 0 ? mentionedCompanies : SUPERMARKET_META.companies
      : []
    const built = buildPartMaterials(this.ctx, chapterId, parts, query, companies)
    const warnings = [...built.warnings]
    const { drafts, warnings: modelWarnings } = await modelDraft(this.ctx, query, built.materials)
    warnings.push(...modelWarnings)

    const content: CaseStudyContent = {
      case: supermarket
        ? {
            ...SUPERMARKET_META,
            title: `${companies.join('、')} · ${parts.map((part) => part.label).join('、')}`,
            subtitle: '按本轮问题组织的教学示例',
            summary: `本轮聚焦「${parts.map((part) => part.label).join('、')}」：先核对定义，再区分情境中的假设、可核对的原文与判断边界。`,
            companies,
            sourceNote: SUPERMARKET_META.sourceNote,
          }
        : {
            id: 'case_current_question',
            title: `${topicLabel(query)} · 课程材料精讲`,
            subtitle: '课程知识点 + 教材原文 + 判断边界',
            summary: `围绕你问的「${query.slice(0, 60)}」，先给课程定义，再放回情境，最后用原文证据和边界检验。`,
            companies: [],
            sourceNote: `材料来自课程知识点、教材原文与已验证新闻句；没有原文证据的地方标为教学推断。${demoNote()}`,
          },
      knowledgePoints: [],
      transfer: [],
      boundaries: [],
      usageNote: `${demoNote()} 先读定义，再看“案例对应”，最后用对话检验自己能不能把定义用回情境。${modelWarnings.length > 0 ? '本稿部分内容由教学示例生成，未通过来源校验的模型内容已丢弃。' : ''}`,
    }

    const citations: Citation[] = []
    const sourceRefs: string[] = []
    const seenCitation = new Set<string>()
    const coverage: Array<{
      partId: string
      label: string
      status: 'covered' | 'partial' | 'missing'
      summary: string
      citationIds: string[]
    }> = []
    const coverageNotes: string[] = []

    const addCitation = (citation: Citation): void => {
      const key = `${citation.sourceType}:${citation.sourceId}:${citation.quote}`
      if (seenCitation.has(key)) return
      seenCitation.add(key)
      citations.push(citation)
      if (!sourceRefs.includes(citation.sourceId)) sourceRefs.push(citation.sourceId)
    }

    for (const material of built.materials) {
      const part = material.part
      const draft = drafts[part.id]
      if (part.kind === 'counterexample' || part.id === 'counterexample') {
        const text = draft?.boundary || draft?.caseMapping || counterexampleText()
        if (!content.boundaries.includes(text)) content.boundaries.push(text)
        const summary = draft?.caseMapping || counterexampleText()
        coverage.push({
          partId: part.id,
          label: part.label,
          status: 'covered',
          summary,
          citationIds: [...new Set(material.evidence.map((item) => item.sourceId))],
        })
        continue
      }

      const partCitationIds: string[] = []
      const cardsBefore = content.knowledgePoints.length
      const partFocus = applyKpFocus
        ? new Set([...focusKpIds].filter((id) => material.kps.some((kp) => kp.id === id || kp.name === id)))
        : new Set<string>()
      for (const kp of material.kps) {
        if (partFocus.size > 0 && !partFocus.has(kp.id) && !partFocus.has(kp.name)) continue
        const definitionSource = material.supplemental.some((item) => item.id === kp.id)
          ? kp.source
          : chapterKpLabel(this.ctx.learningDb, chapterId, kp)
        addCitation({
          sourceType: 'kp',
          sourceId: kp.id,
          quote: kp.definition,
          locator: { name: kp.name, chapterId, definitionSource },
        })
        partCitationIds.push(kp.id)

        const evidence = material.evidence.filter((item) => item.kpIds.includes(kp.id))
        const modelEvidence = draft && material.kps[0]?.id === kp.id ? draft.evidence : []
        const mergedEvidence = [...evidence, ...modelEvidence].filter(
          (item, index, all) =>
            all.findIndex((candidate) => candidate.sourceId === item.sourceId && candidate.quote === item.quote) === index,
        )
        for (const item of mergedEvidence) {
          addCitation({
            sourceType: item.sourceType === 'textbook' ? 'textbook' : 'news',
            sourceId: item.sourceId,
            quote: item.quote,
            locator: {
              ...item.locator,
              sourceTitle: item.sourceTitle,
              title: item.locator.title ?? item.sourceTitle,
            },
          })
          if (!partCitationIds.includes(item.sourceId)) partCitationIds.push(item.sourceId)
        }

        const isFirst = material.kps[0]?.id === kp.id
        const caseMapping = isFirst && draft ? draft.caseMapping : caseMappingForKp(material, kp, supermarket)
        const dialogue = isFirst && draft ? draft.dialogue : dialogueForKp(material, kp, supermarket)
        const takeaway = isFirst && draft ? draft.takeaway : takeawayForKp(material, kp)
        const boundary = isFirst && draft ? draft.boundary : boundaryForKp(material, kp)
        const checkQuestion = isFirst && draft ? draft.checkQuestion : checkQuestionForKp(material, kp)

        content.knowledgePoints.push({
          id: kp.id,
          name: kp.name,
          definition: kp.definition,
          definitionSource,
          caseMapping,
          evidence: mergedEvidence.map((item) => ({
            quote: item.quote,
            sourceId: item.sourceId,
            sourceTitle: item.sourceTitle,
            sourceType: item.sourceType,
          })),
          dialogue,
          takeaway,
          boundary,
          checkQuestion,
        })
      }

      const visibleMaterial = partFocus.size > 0
        ? {
            ...material,
            kps: material.kps.filter((kp) => partFocus.has(kp.id) || partFocus.has(kp.name)),
          }
        : material
      const status = content.knowledgePoints.length === cardsBefore ? 'missing' : partStatus(visibleMaterial)
      if (status === 'missing') {
        coverageNotes.push(`「${part.label}」缺少可用课程材料，未强行生成结论。`)
      }
      const summary = draft?.caseMapping || coverageSummary(visibleMaterial, supermarket)
      coverage.push({
        partId: part.id,
        label: part.label,
        status,
        summary,
        citationIds: [...new Set(partCitationIds)],
      })
      if (material.evidence.length === 0) {
        coverageNotes.push(`「${part.label}」未检索到可核对原文，只给课程定义与判断标准。`)
      }
    }

    content.knowledgePoints = content.knowledgePoints.filter(
      (point, index, all) =>
        all.findIndex((candidate) => candidate.id === point.id || candidate.name === point.name) === index,
    )

    for (const material of built.materials) {
      const partFocus = applyKpFocus
        ? new Set([...focusKpIds].filter((id) => material.kps.some((kp) => kp.id === id || kp.name === id)))
        : new Set<string>()
      for (const kp of material.kps) {
        if (partFocus.size > 0 && !partFocus.has(kp.id) && !partFocus.has(kp.name)) continue
        const takeaway = takeawayForKp(material, kp)
        if (!content.transfer.includes(takeaway)) content.transfer.push(takeaway)
        const boundary = boundaryForKp(material, kp)
        if (!content.boundaries.includes(boundary)) content.boundaries.push(boundary)
      }
    }
    if (!content.boundaries.some((item) => item.includes('反例'))) {
      content.boundaries.push(counterexampleText())
    }
    if (content.transfer.length > 6) content.transfer = content.transfer.slice(0, 6)

    const missingRequired = coverage.filter((item) => {
      const part = parts.find((candidate) => candidate.id === item.partId)
      return item.status === 'missing' && part?.required !== false
    })
    if (missingRequired.length > 0) {
      coverageNotes.push(`未覆盖：${missingRequired.map((item) => item.label).join('、')}。`)
    }

    const firstCheck = content.knowledgePoints
      .map((point) => point.checkQuestion)
      .find((question) => question.length > 0)
      ?? '换一个情境，这个判断还成立吗？哪条证据会推翻它？'

    const draft: ArtifactDraft = {
      type: 'case_study',
      title: supermarket ? `案例精讲 · ${SUPERMARKET_META.title}` : `案例精讲 · ${topicLabel(query)}`,
      schemaVersion: 'CaseStudy@1',
      contentJson: content,
      markdownFallback: caseStudyMarkdown(content),
      sourceRefs,
      evidenceIds: [],
    }

    return {
      stepId: step.id,
      agent: 'case',
      status: missingRequired.length > 0 ? 'partial' : 'ok',
      schema: 'CaseStudy@1',
      content: {
        summary: content.case.summary,
        caseTitle: content.case.title,
        focusKpIds: applyKpFocus && focusKpIds.size > 0
          ? content.knowledgePoints.filter((point) => focusKpIds.has(point.id) || focusKpIds.has(point.name)).map((point) => point.id)
          : [],
        followUp: parts.length < originalPartCount
          || (partLevelFocus && focusPartIds.length < originalPartCount),
        knowledgePoints: content.knowledgePoints.map((point) => ({
          id: point.id,
          name: point.name,
          definition: point.definition,
          caseMapping: point.caseMapping,
          takeaway: point.takeaway,
        })),
        checkQuestion: firstCheck,
        coverage,
        coverageNotes: [...new Set(coverageNotes)],
        supermarket,
      },
      citations,
      evidenceCandidates: [],
      artifactDraft: draft,
      warnings: [...new Set(warnings)],
      usage: { ms: 0, tokens: 0 },
    }
  }
}
