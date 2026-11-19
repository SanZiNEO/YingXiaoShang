import { readFileSync, writeFileSync } from 'node:fs'
import { test, expect } from '../fixtures/test.js'
import { createClient } from '../client/learning-client.js'
import { launchElectron } from '../driver/electron-driver.js'

/**
 * 依赖：CH-07（settings.get）、CH-08（settings.set）、DATA-10（settings.json 位置）、
 * UI-05（设置入口）、LEG-11（密钥来源与坏文件修复）。
 * 补充：SVC-19（设置存储）、CH-18/CH-19（settings 通道）、DATA-13（设置文件位置）。
 * 环境变量在驱动层注入；仓库根 `.env` 会被应用自己加载，因此本机环境来源恒为 env。
 * 该用例重点覆盖 settings.json 的写入/坏文件修复，以及 env 优先与 clearApiKey 语义。
 */
test.use({ extraEnv: { DEEPSEEK_API_KEY: '', DEEPSEEK_MODEL: '' } })

test('TC-P1-01 设置读取/写入与坏文件修复', async ({ app, client, home }) => {
  // 源码事实：应用启动会 loadDotEnv 仓库根 .env；本机该文件存在真实 DEEPSEEK_API_KEY，
  // 因此“无 Key”分支在仓库内不可达，初始来源必须是 env。隔离的是 settings.json，不是 .env。
  const initial = await client.settingsGet()
  expect(initial.hasApiKey).toBe(true)
  expect(initial.apiKeySource).toBe('env')
  expect(initial.model).toBe('deepseek-chat')
  expect(initial.configError).toBeUndefined()

  const savedModel = await client.settingsSet({ model: 'p1-test-model' })
  // 读取视图仍被 .env 的 DEEPSEEK_MODEL 覆盖；文件必须已经写入新值。
  expect(savedModel.model).toBe('deepseek-chat')

  const afterModel = JSON.parse(readFileSync(home.settingsPath, 'utf8')) as { model?: string }
  expect(afterModel.model).toBe('p1-test-model')
  // 写入必须无 BOM，才能被 JSON.parse 直接读取。
  expect(readFileSync(home.settingsPath)[0]).toBe(0x7b)

  const savedKey = await client.settingsSet({ apiKey: 'sk-p1-stored' })
  expect(savedKey.hasApiKey).toBe(true)
  expect(savedKey.apiKeySource).toBe('env')
  expect(savedKey.model).toBe('deepseek-chat')
  // 文件层必须真的写入，才能证明 set 的持久化路径；env 优先只影响读取视图。
  const storedFile = JSON.parse(readFileSync(home.settingsPath, 'utf8')) as { apiKey?: string }
  expect(storedFile.apiKey).toBe('sk-p1-stored')

  // 外部写坏（带 BOM 的非法 JSON）：读取要报 configError 且回默认，而不是假装“没配置”。
  writeFileSync(home.settingsPath, '\uFEFF{bad json', 'utf8')
  const broken = await client.settingsGet()
  expect(broken.hasApiKey).toBe(true)
  expect(broken.apiKeySource).toBe('env')
  expect(broken.model).toBe('deepseek-chat')
  expect(broken.configError ?? '').toContain('不是合法的 JSON')

  // 下一次写入必须修好文件、清掉 configError，并保留非密钥字段。
  const repaired = await client.settingsSet({ apiKey: 'sk-p1-repaired' })
  expect(repaired.configError).toBeUndefined()
  expect(repaired.hasApiKey).toBe(true)
  expect(repaired.apiKeySource).toBe('env')
  expect(readFileSync(home.settingsPath)[0]).toBe(0x7b)
  const repairedFile = JSON.parse(readFileSync(home.settingsPath, 'utf8')) as { apiKey?: string; model?: string }
  expect(repairedFile.apiKey).toBe('sk-p1-repaired')
  // 源码事实：settingsSet 用 read() 的当前值回填，env 的 DEEPSEEK_MODEL 会覆盖并写回文件。
  expect(repairedFile.model).toBe('deepseek-chat')

  // 同一 userData 二次启动，环境变量优先于文件；clearApiKey 不能抹掉环境变量。
  await app.close()
  const second = await launchElectron({
    kind: 'out',
    home: home.home,
    userDataDir: home.userDataDir,
    newsPort: app.newsPort,
    extraEnv: { DEEPSEEK_API_KEY: 'sk-p1-env', DEEPSEEK_MODEL: 'env-model' },
  })
  try {
    const envClient = await createClient(second.page)
    const fromEnv = await envClient.settingsGet()
    expect(fromEnv.hasApiKey).toBe(true)
    expect(fromEnv.apiKeySource).toBe('env')
    expect(fromEnv.model).toBe('env-model')

    const cleared = await envClient.settingsSet({ clearApiKey: true })
    expect(cleared.hasApiKey).toBe(true)
    expect(cleared.apiKeySource).toBe('env')
  } finally {
    await second.close()
  }
})
