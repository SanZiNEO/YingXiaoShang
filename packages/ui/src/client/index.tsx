import type { Context } from '@deepseek-ai/cordis'
import type { ReactElement } from 'react'
import type { ClientContext } from './client-context.js'
import { BpPage, KnowledgePage, LearningSettings, QuestionPage, ResearchPage } from './pages.js'
import { learningRemote } from './remote.js'

export const inject = ['slots', 'layout', 'uiWorkspace', 'remote']

interface PanelDefinition {
  id: 'knowledge' | 'question' | 'research' | 'bp'
  label: string
  order: number
  component: () => ReactElement
}

export function apply(ctx: Context) {
  // The browser Context augmentation is owned by the client remote package.
  const client = ctx as unknown as ClientContext
  const remote = (ctx as unknown as { remote?: { $mount?: (info: typeof learningRemote) => Promise<unknown> } }).remote
  if (remote?.$mount) {
    void remote.$mount(learningRemote).catch((error: unknown) => {
      console.warn('learning remote mount failed', error)
    })
  }

  const panels: PanelDefinition[] = [
    {
      id: 'knowledge',
      label: '知识库·新闻',
      order: 10,
      component: () => <KnowledgePage client={client} />,
    },
    {
      id: 'question',
      label: '出题',
      order: 20,
      component: () => <QuestionPage client={client} />,
    },
    {
      id: 'research',
      label: '调研',
      order: 30,
      component: () => <ResearchPage client={client} />,
    },
    {
      id: 'bp',
      label: '商业计划书',
      order: 40,
      component: () => <BpPage client={client} />,
    },
  ]

  for (const panel of panels) {
    client.slots.inject('sidebar.panellist', () =>
      client.slots.register(
        {
          name: 'sidebar.panellist',
          id: panel.id,
          order: panel.order,
          label: panel.label,
        },
        panel.component,
      ),
    )
    client.slots.inject('main', () =>
      client.slots.register(
        {
          name: 'main',
          key: panel.id,
        },
        panel.component,
      ),
    )
  }

  client.slots.inject('settings.section', () =>
    client.slots.register(
      {
        name: 'settings.section',
        id: 'learning',
        order: 80,
        label: '学习',
      },
      LearningSettings,
    ),
  )
}
