import { test, expect } from '../fixtures/test.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pragma, queryRows } from '../client/db-probe.js'
import { startupHealth } from '../../../../apps/desktop/src/main/health.js'

/**
 * 依赖：PKG-05（缺失 extraResources 源的打包行为待验证）、DATA-07（seed 基线对照）、
 * LEG-13（体检规则纯函数）、BOOT-01（启动就绪信号）。
 *
 * 代码事实（冲突以代码为准，apps/desktop/src/main/index.ts:71-81）：
 * - 种子候选固定为 `<process.resourcesPath>/seed/learning.db` 与 `<app.getAppPath()>/seed/learning.db`，
 *   源码不读任何种子路径环境变量；extraEnv 无法把种子目录指到别处。
 * - dev/out 启动时 resourcesPath 指向 electron dist/resources（实测仅 default_app.asar），
 *   getAppPath() 指向 apps/desktop（实测无 seed/ 目录），两个候选都缺失，
 *   因此「无 seed 可复制 → LearningDb 构造器建空库 → 跑空 SCHEMA」分叉在 dev/out 真实可达。
 * - packaged release 的 resources/seed/learning.db 存在，首启必然复制种子；
 *   打包侧「缺种子产物」分叉属 PKG-05 重新打包验证，本轮不在自动化范围内（人工项）。
 */
test.use({ seedMode: 'empty' })

test('TC-P1-17 无种子空库首启健康告警分叉', async ({ app, client, home }, testInfo) => {
  // --- 纯函数分叉（LEG-13，不依赖运行态） ---
  const empty = startupHealth({ chapters: 0, knowledgePoints: 0, newsArticles: 0 })
  expect(empty.ok).toBe(false)
  expect(empty.warnings.join('\n')).toContain('课程章节')
  // 章节为 0 时，新闻为空不单独出 notice（notice 条件要求 chapters > 0）。
  expect(empty.notices).toEqual([])

  const seedLike = startupHealth({ chapters: 13, knowledgePoints: 228, newsArticles: 0 })
  expect(seedLike.ok).toBe(true)
  expect(seedLike.warnings).toEqual([])
  expect(seedLike.notices.join('\n')).toContain('本地新闻库')

  const kpMissing = startupHealth({ chapters: 13, knowledgePoints: 0, newsArticles: 134 })
  expect(kpMissing.ok).toBe(false)

  const healthy = startupHealth({ chapters: 13, knowledgePoints: 228, newsArticles: 134 })
  expect(healthy.ok).toBe(true)
  expect(healthy.warnings).toEqual([])
  expect(healthy.notices).toEqual([])

  // --- 运行态：dev/out 空库首启（BOOT-01 / CH-06） ---
  expect(home.seedMode).toBe('empty')

  const health = await client.health()
  expect(health.appHome).toBe(home.home)
  expect(health.ok).toBe(false)
  expect(health.warnings.some((warning) => warning.includes('课程章节'))).toBe(true)
  // 空库章节为 0：新闻 0 不触发「本地新闻库为空」notice，与纯函数规则一致。
  expect(health.notices).toEqual([])

  const newsStatus = await client.newsStatus()
  expect(Number(newsStatus.count)).toBe(0)
  expect(typeof newsStatus.newestFetchedAt).toBe('string')
  expect(newsStatus.newestFetchedAt).toBe('')

  // --- 库层事实：node:sqlite 只读打开 home.dbPath ---
  const dbPath = home.dbPath
  expect(pragma(dbPath, 'user_version')).toBe(7)
  expect(pragma(dbPath, 'application_id')).toBe(1280201284)

  const tables = queryRows<{ name: string }>(
    dbPath,
    "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'",
  )
  const tableNames = tables.map((row) => row.name)
  for (const required of ['chapters', 'knowledge_points', 'news_articles', 'chat_sessions']) {
    expect(tableNames).toContain(required)
  }

  const countOf = (table: string): number => {
    const rows = queryRows<{ c: number }>(dbPath, `select count(*) as c from ${table}`)
    return Number(rows[0]?.c ?? 0)
  }
  expect(countOf('chapters')).toBe(0)
  expect(countOf('knowledge_points')).toBe(0)
  expect(countOf('news_articles')).toBe(0)

  // 空库照样开窗：只看窗口会漏判不完整安装包，health 告警才是主信号。
  const windows = await app.windows()
  expect(windows).toHaveLength(1)
  expect(windows[0]?.visible).toBe(true)

  // 取证：health 返回、库计数与种子候选事实落盘。
  mkdirSync(testInfo.outputDir, { recursive: true })
  writeFileSync(
    join(testInfo.outputDir, 'health-empty-db.json'),
    JSON.stringify(
      {
        health,
        newsStatus,
        counts: {
          chapters: countOf('chapters'),
          knowledgePoints: countOf('knowledge_points'),
          newsArticles: countOf('news_articles'),
        },
        windows: windows.length,
        seedCandidates: {
          note: '种子路径固定为 resourcesPath/seed 与 getAppPath/seed，无环境变量覆盖；dev/out 两候选均缺失。',
          resourcesPathSeed: '缺失（electron dist/resources 仅 default_app.asar）',
          appPathSeed: '缺失（apps/desktop/seed 不存在）',
          packagedSeed: 'release/win-unpacked/resources/seed/learning.db 存在，打包侧空库分叉本轮不可达（PKG-05 人工项）',
        },
      },
      null,
      2,
    ),
    'utf8',
  )
})
