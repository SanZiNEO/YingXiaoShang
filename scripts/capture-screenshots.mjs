import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = join(repoRoot, 'docs', 'screenshots')
const url = process.env.LEARNING_AGENT_WEB_URL || 'http://127.0.0.1:3083'
mkdirSync(outputDir, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
page.setDefaultTimeout(120_000)
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('text=营小商', { timeout: 90_000 })
await page.waitForTimeout(800)
await page.screenshot({ path: join(outputDir, '01-empty-state.png'), fullPage: false })

const input = page.locator('textarea[placeholder="说说你现在想解决什么…"]')
await input.fill('用胖东来案例讲消费者')
await input.press('Enter')
await page.waitForSelector('text=教学示例', { timeout: 120_000 })
await page.waitForTimeout(800)
await page.screenshot({ path: join(outputDir, '02-case-lesson.png'), fullPage: false })

const workspace = page.locator('aside').last()
const firstPoint = workspace.locator('section').filter({ hasText: '示例对话' }).first()
await firstPoint.screenshot({ path: join(outputDir, '03-case-dialogue.png') })
await page.setViewportSize({ width: 1440, height: 1600 })
const secondPoint = workspace.locator('section').filter({ hasText: '示例对话' }).nth(1)
if (await secondPoint.count() > 0) {
  await secondPoint.screenshot({ path: join(outputDir, '04-learning-dialogue.png') })
}

const text = await workspace.innerText()
for (const expected of ['定义', '示例对话', '教学示例']) {
  if (!text.includes(expected)) throw new Error(`screenshot flow missing: ${expected}`)
}
if (text.includes('##') || text.includes('**')) throw new Error('raw markdown leaked into the case renderer')
if (/kp_[a-z0-9_]/i.test(text)) throw new Error('raw knowledge id leaked into the case renderer')

console.log(JSON.stringify({
  url,
  screenshots: [
    'docs/screenshots/01-empty-state.png',
    'docs/screenshots/02-case-lesson.png',
    'docs/screenshots/03-case-dialogue.png',
    'docs/screenshots/04-learning-dialogue.png',
  ],
}, null, 2))
await browser.close()
