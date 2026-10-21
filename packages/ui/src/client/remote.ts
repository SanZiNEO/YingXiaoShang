import { createTypertRemoteInfo, type TypertRemoteMethodSpec } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'

const anyCodec = {
  mode: 'strict' as const,
  typeSymbol: 'zod.unknown',
  create: () => z.unknown(),
}

function method(description: string): TypertRemoteMethodSpec {
  return {
    service: 'learning',
    invocation: { kind: 'direct' },
    description,
    parameters: [
      {
        name: 'input',
        wire: 'input',
        source: 'json',
        codec: anyCodec,
        strictCodec: anyCodec,
      },
    ],
    result: anyCodec,
  }
}

/**
 * Hand-written client contribution for the LearningRemote host service.
 * The host side uses @Remote; this is the matching mountable descriptor set.
 */
export const learningRemote = createTypertRemoteInfo(
  {
    package: '@learning-agent/api',
    methods: {
      'learning/listChapters': method('List chapters.'),
      'learning/listKps': method('List or search knowledge points.'),
      'learning/getKp': method('Read one knowledge point.'),
      'learning/listIdeology': method('List ideology points.'),
      'learning/listNews': method('List news articles.'),
      'learning/getNews': method('Read one article with matches.'),
      'learning/matchNews': method('Match one article to chapter-4 knowledge points.'),
      'learning/generateQuestions': method('Generate questions from a source.'),
      'learning/listQuestions': method('List questions.'),
      'learning/createResearchProject': method('Create a research project.'),
      'learning/getResearchProject': method('Read a research project.'),
      'learning/listResearchProjects': method('List research projects.'),
      'learning/createBpProject': method('Create a business-plan project.'),
      'learning/getBpProject': method('Read a business-plan project.'),
      'learning/listBpProjects': method('List business-plan projects.'),
      'learning/exportQuestions': method('Export questions.'),
      'learning/exportBp': method('Export a business plan.'),
      'learning/startSession': method('Start an agent session.'),
    },
  },
  z,
)
