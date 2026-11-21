import type { Context } from '@deepseek-ai/cordis'
import type LearningDb from '@learning-agent/db'
import type { Matcher } from '@learning-agent/matcher'
import type { QuestionSmith } from '@learning-agent/questions'
import type { ResearchService } from '@learning-agent/research'
import type { BpService } from '@learning-agent/bp'
import type { ProfileService } from '@learning-agent/profile'
import type { ArtifactService } from '@learning-agent/artifacts'
import type { NewsService } from '@learning-agent/news'
import type { AgentService } from '@learning-agent/agent'
import type { AuthStore } from './auth/store.js'
import type { Env } from './env.js'
import type { Logger } from './log.js'
import type { Metrics } from './metrics.js'

/** Everything the HTTP layer is allowed to touch. */
export interface Services {
  ctx: Context
  env: Env
  db: LearningDb
  matcher: Matcher
  questionSmith: QuestionSmith
  research: ResearchService
  bp: BpService
  profile: ProfileService
  artifacts: ArtifactService
  news: NewsService
  agent: AgentService
  auth: AuthStore
  metrics: Metrics
  log: Logger
}
