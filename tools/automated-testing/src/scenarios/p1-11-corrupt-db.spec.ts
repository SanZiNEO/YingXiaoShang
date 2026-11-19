import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/test.js'
import { launchElectron } from '../driver/electron-driver.js'
import { allocatePort, delay } from '../driver/ports.js'
import { killTree, listProcesses, type ProcessRow } from '../driver/processes.js'
import { startupFailure } from '../../../../apps/desktop/src/main/health.js'

/**
 * 依赖：BOOT-02（损坏库重置分支）、BOOT-03（权限类不可重置分支）、DATA-03（迁移/版本错误基线）、LEG-12（startupFailure 纯函数复用）。
 *
 * 两层：
 *  1. 纯函数层：直接 import startupFailure，四类错误输入断言 canResetLocalData 分类与标题文案，输入输出落盘证据。
 *  2. 运行态：隔离 home 内把 seed 副本删成非 SQLite 垃圾字节后启动。主进程在原生失败对话框处阻塞、不创建窗口，
 *     Playwright 的 launch 引导连接无法建立而抛错；launchElectron 拒绝返回句柄。
 *     实测机制：launch 阻塞期间用并发轮询按 userDataDir 命令行片段采样进程，证明「进程在、窗口无」；
 *     launch 超时后 Playwright 回收子进程，用 killTree 兜底清理并断言进程表为空。
 *
 * 人工项：对话框「备份旧数据并重置」按钮点击、`.broken-*` 改名与 relaunch 链路无法脚本化（原生模态阻塞），
 * 本用例只观测到阻塞分支；重置后的新库建立属人工验收。
 */
test('TC-P1-11 损坏 DB 启动失败分支（可重置/不可重置）', async ({ home }, testInfo) => {
  // ---------------------------------------------------------------------------
  // 一、纯函数层：四类输入逐条断言，输入输出写入证据目录。
  // ---------------------------------------------------------------------------
  const pureCases = [
    {
      name: 'corrupt-db',
      input: 'SQLITE_CORRUPT: file is not a database — database disk image is malformed',
      expectReset: true,
      titleMatch: /损坏/,
    },
    {
      name: 'disk-full',
      input: 'SQLITE_FULL: ENOSPC: no space left on device',
      expectReset: true,
      titleMatch: null,
    },
    {
      name: 'permission-denied',
      input: 'EACCES: read-only database, unable to open database file',
      expectReset: false,
      titleMatch: null,
    },
    {
      name: 'unknown-error',
      input: 'something unexpected happened at 0xdeadbeef',
      expectReset: false,
      titleMatch: null,
    },
  ] as const

  const pureRecords = pureCases.map((item) => {
    const failure = startupFailure(new Error(item.input))
    expect(failure.canResetLocalData, `${item.name} 分类`).toBe(item.expectReset)
    if (item.titleMatch) {
      expect(failure.title, `${item.name} 标题`).toMatch(item.titleMatch)
    }
    return {
      name: item.name,
      input: item.input,
      output: {
        title: failure.title,
        body: failure.body,
        canResetLocalData: failure.canResetLocalData,
      },
    }
  })

  // ---------------------------------------------------------------------------
  // 二、运行态：启动前把 home 内 DB 三件套写成垃圾字节。
  // ---------------------------------------------------------------------------
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${home.dbPath}${suffix}`, { force: true })
  }
  writeFileSync(home.dbPath, Buffer.from('not a sqlite database — garbage bytes'.repeat(24)), 'utf8')
  expect(existsSync(home.dbPath)).toBe(true)

  const newsPort = await allocatePort()
  const observation: Record<string, unknown> = {
    home: home.home,
    userDataDir: home.userDataDir,
    dbPath: home.dbPath,
    newsPort,
    corruptBytes: existsSync(home.dbPath),
  }

  // 并发轮询：launchElectron 阻塞期间按 userDataDir 片段采样进程（等进程表状态，不做固定延时等待）。
  const samples: Array<{ at: number; rows: ProcessRow[] }> = []
  let polling = true
  const poller = (async () => {
    while (polling) {
      samples.push({ at: Date.now(), rows: listProcesses(home.userDataDir) })
      await delay(300)
    }
  })()

  let launchError: Error | undefined
  try {
    await launchElectron({
      kind: 'out',
      home: home.home,
      userDataDir: home.userDataDir,
      newsPort,
      autostartSidecar: false,
      launchTimeoutMs: 15000,
      readyTimeoutMs: 15000,
    })
  } catch (error) {
    launchError = error instanceof Error ? error : new Error(String(error))
  }
  polling = false
  await poller

  // 预期：原生对话框阻塞、无窗口，launchElectron 在引导连接/首窗等待处抛错（超时或无窗口类错误）。
  expect(launchError, '损坏库启动必须抛错：主进程被原生失败对话框阻塞，未产生可连接窗口').toBeDefined()
  observation.launchError = {
    name: launchError?.name,
    message: launchError?.message,
  }

  // 阻塞窗口内采样到的匹配进程：证明「进程在、窗口无」。
  const observedRows = samples.flatMap((sample) => sample.rows)
  const observedPids = [...new Set(observedRows.map((row) => row.pid))]
  observation.observedPids = observedPids
  observation.sampleCount = samples.length
  observation.observedRows = observedRows.map((row) => ({ pid: row.pid, commandLine: row.commandLine }))
  expect(observedPids.length, '损坏库分支下匹配 userDataDir 的 Electron 进程应在 launch 阻塞期间被观测到').toBeGreaterThan(0)

  // 重置分支需人工点击对话框：此刻不应出现任何 `.broken-*` 改名文件。
  const dataDir = join(home.home, 'data')
  const dataEntries = existsSync(dataDir) ? readdirSync(dataDir) : []
  const brokenEntries = dataEntries.filter((entry) => entry.includes('.broken-'))
  observation.brokenEntries = brokenEntries
  expect(brokenEntries, '未人工触发重置前不得出现 .broken-* 改名文件').toHaveLength(0)

  // 清理：Playwright 超时回收后可能仍有残留子进程；killTree 所有匹配进程，轮询进程表直到为空。
  try {
    const deadline = Date.now() + 8000
    let remaining = listProcesses(home.userDataDir)
    while (remaining.length > 0 && Date.now() < deadline) {
      for (const row of remaining) killTree(row.pid)
      await delay(150)
      remaining = listProcesses(home.userDataDir)
    }
    observation.remainingProcesses = remaining.map((row) => row.pid)
    expect(remaining, '清理后不得残留匹配 userDataDir 的进程').toHaveLength(0)
  } finally {
    // 兜底：即使上面断言失败，也再扫一遍并清掉，避免损坏库用例拖住整体运行。
    for (const row of listProcesses(home.userDataDir)) killTree(row.pid)
  }

  // 纯函数输入输出 + 运行态观测落盘证据。
  mkdirSync(testInfo.outputDir, { recursive: true })
  writeFileSync(
    join(testInfo.outputDir, 'startup-failure.json'),
    JSON.stringify({ pureCases: pureRecords, runtime: observation }, null, 2),
    'utf8',
  )
})
