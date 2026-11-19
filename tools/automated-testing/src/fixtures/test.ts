import { test as base, expect, type TestInfo } from '@playwright/test'
import { createClient, LearningClient } from '../client/learning-client.js'
import { launchElectron, type DriverHandle } from '../driver/electron-driver.js'
import { allocatePort } from '../driver/ports.js'
import type { TargetKind } from '../driver/paths.js'
import { createHome, removeHome, type HomeContext, type SeedMode } from './home.js'
import { AppShell } from '../pages/app-shell.js'
import { Evidence, tcOf } from '../evidence/evidence.js'
import { depsOf } from '../scenarios/dependencies.js'

export interface TestOptions {
  target: TargetKind
  seedMode: SeedMode
  autostartSidecar: boolean
  extraEnv: Record<string, string | undefined>
}

export interface TestFixtures {
  home: HomeContext
  app: DriverHandle
  client: LearningClient
  ui: AppShell
  evidence: Evidence
  deps: void
}

export const test = base.extend<TestFixtures & TestOptions>({
  target: ['out', { option: true }],
  seedMode: ['seed', { option: true }],
  autostartSidecar: [false, { option: true }],
  extraEnv: [{}, { option: true }],

  deps: [
    async ({}, use, testInfo: TestInfo) => {
      const tc = tcOf(testInfo.title)
      if (tc.length > 0) {
        testInfo.annotations.push({ type: 'deps', description: depsOf(tc).join(',') })
      }
      await use()
    },
    { auto: true },
  ],

  evidence: [
    async ({}, use, testInfo: TestInfo) => {
      const evidence = new Evidence(testInfo)
      await use(evidence)
      await evidence.finalize(testInfo.status)
    },
    { auto: true },
  ],

  home: async ({ seedMode }, use, testInfo) => {
    const home = createHome(testInfo, seedMode)
    try {
      await use(home)
    } finally {
      removeHome(home)
    }
  },

  app: async ({ evidence, home, target, autostartSidecar, extraEnv }, use) => {
    const newsPort = await allocatePort()
    const driver = await launchElectron({
      kind: target,
      home: home.home,
      userDataDir: home.userDataDir,
      newsPort,
      autostartSidecar,
      extraEnv,
    })
    evidence.bind(driver)
    try {
      await use(driver)
    } finally {
      await evidence.captureLive()
      const report = await driver.close()
      evidence.setCloseReport(report)
      evidence.captureDb()
    }
  },

  client: async ({ app, evidence }, use) => {
    const client = await createClient(app.page)
    evidence.bindClient(client)
    await use(client)
  },

  ui: async ({ app }, use) => {
    const ui = new AppShell(app.page)
    await ui.waitReady()
    await use(ui)
  },
})

export { expect }
