import { Context } from '@deepseek-ai/cordis'
import LearningDb from '@learning-agent/db'
import { Matcher } from '@learning-agent/matcher'
import { QuestionSmith } from '@learning-agent/questions'
import { ResearchService } from '@learning-agent/research'
import { BpService } from '@learning-agent/bp'
import { ProfileService } from '@learning-agent/profile'
import { ArtifactService } from '@learning-agent/artifacts'
import { NewsService } from '@learning-agent/news'
import { AgentService } from '@learning-agent/agent'
import { AuthStore } from './auth/store.js'
import type { Env } from './env.js'
import type { Logger } from './log.js'
import type { Metrics } from './metrics.js'
import type { Services } from './services.js'
import { createMockLlm } from './llm/mock.js'
import { createDeepSeekLlm } from './llm/deepseek.js'
import { createMeteredLlm } from './llm/metered.js'

/**
 * The server is just another host for the same service graph the Electron main
 * process builds. Anything missing here must fail at startup, not at first use.
 */
export async function buildContext(env: Env, metrics: Metrics, log: Logger): Promise<Services> {
  const ctx = new Context()

  // The agent reads prompt markdown from disk at call time, so the resolved
  // directory has to be visible in the environment it reads (packages/agent/src/prompts.ts).
  process.env.LEARNING_AGENT_PROMPTS_DIR = env.promptsDir

  const baseLlm = env.llm === 'mock'
    ? createMockLlm({ script: process.env.YXS_MOCK_SCRIPT ?? '' })
    : createDeepSeekLlm({
      apiKey: env.deepseekKey,
      model: env.deepseekModel,
      baseUrl: env.deepseekBaseUrl,
    })
  const llm = createMeteredLlm(baseLlm, metrics)
  ctx.provide('llm', llm as unknown as Context['llm'])

  const db = new LearningDb(ctx, { appHome: env.home, path: env.dbPath })
  const matcher = new Matcher(ctx)
  const questionSmith = new QuestionSmith(ctx)
  const research = new ResearchService(ctx)
  const bp = new BpService(ctx)
  const profile = new ProfileService(ctx)
  const artifacts = new ArtifactService(ctx, {
    appHome: env.home,
    templatesDir: env.templatesDir,
  })
  const news = new NewsService(ctx, { baseUrl: env.newsBaseUrl })
  const agent = new AgentService(ctx)
  const auth = new AuthStore(env.authDbPath)

  log.info({ code: 'context-ready' })

  return {
    ctx,
    env,
    db,
    matcher,
    questionSmith,
    research,
    bp,
    profile,
    artifacts,
    news,
    agent,
    auth,
    metrics,
    log,
  }
}
