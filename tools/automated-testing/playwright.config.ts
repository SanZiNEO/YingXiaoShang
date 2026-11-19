import { defineConfig } from '@playwright/test'

const workers = Number(process.env.YXS_WORKERS ?? '1')
const retries = Number(process.env.YXS_RETRIES ?? '0')

export default defineConfig({
  testDir: './src/scenarios',
  outputDir: './.artifacts',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: Number.isFinite(workers) && workers > 0 ? workers : 1,
  retries: Number.isFinite(retries) && retries >= 0 ? retries : 0,
  reporter: [['list'], ['./src/evidence/reporter.ts']],
  use: {
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    { name: 'p0', testMatch: /p0-[\w-]+\.spec\.ts$/ },
    { name: 'p1', testMatch: /p1-[\w-]+\.spec\.ts$/ },
  ],
})
