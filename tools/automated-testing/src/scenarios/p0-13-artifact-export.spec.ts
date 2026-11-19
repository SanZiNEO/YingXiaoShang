import { test, expect } from '../fixtures/test.js'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * 依赖：IPC-21（artifacts.export）、SVC-16（落库与 containment）、DATA-13a/13b（产物/导出目录）、IPC-20（回读）。
 */
test('TC-P0-13 产物导出文件落盘可回读', async ({ client, home }) => {
  const artifacts = await client.artifactsList()
  const docxArtifact = artifacts.find((artifact) => artifact.format === 'docx' && artifact.type === 'case_study')
  expect(docxArtifact, 'seed 库必须带一份 docx 案例产物').toBeTruthy()
  const id = docxArtifact?.id ?? ''
  const title = docxArtifact?.title ?? ''

  const withinHome = (path: string): boolean =>
    resolve(path).toLowerCase().startsWith(resolve(home.home).toLowerCase())

  const md = await client.artifactsExport(id, 'md')
  expect(md.path.endsWith('.md')).toBe(true)
  expect(withinHome(md.path)).toBe(true)
  expect(existsSync(md.path)).toBe(true)
  expect(statSync(md.path).size).toBeGreaterThan(0)
  const mdText = readFileSync(md.path, 'utf8')
  expect(mdText.length).toBeGreaterThan(0)
  expect(mdText).toContain(title)

  const docx = await client.artifactsExport(id, 'docx')
  expect(docx.path.endsWith('.docx')).toBe(true)
  expect(withinHome(docx.path)).toBe(true)
  expect(existsSync(docx.path)).toBe(true)
  expect(statSync(docx.path).size).toBeGreaterThan(0)
  const signature = readFileSync(docx.path).subarray(0, 4)
  expect(signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true)

  // 源码事实：非 html 产物即使传 'html' 也落到 .md（`packages/artifacts` 的 target 规则）。
  const htmlRequest = await client.artifactsExport(id, 'html')
  expect(htmlRequest.path.endsWith('.md')).toBe(true)
  expect(existsSync(htmlRequest.path)).toBe(true)

  // 非法 format 由主进程 exportFormat 归一为 docx。
  const fallback = await client.invoke<{ path: string }>('artifacts.export', { artifactId: id, format: 'pdf' })
  expect(fallback.path.endsWith('.docx')).toBe(true)
  expect(existsSync(fallback.path)).toBe(true)

  // 真正的 html 产物：导出返回原件，不做二次转换。
  const htmlId = `art_p013_${Date.now().toString(36)}`
  const htmlDir = join(home.home, 'artifacts', 'student_demo', '2026-11')
  mkdirSync(htmlDir, { recursive: true })
  const htmlPath = join(htmlDir, `${htmlId}.html`)
  const htmlContent = '<!doctype html><html><body><h1>HTML 原件</h1></body></html>'
  writeFileSync(htmlPath, htmlContent, 'utf8')
  const createdAt = new Date().toISOString()
  const db = new DatabaseSync(home.dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.prepare(
      `INSERT INTO artifacts (
        id, student_id, session_id, skill_id, template_id, type, title, format,
        path, content, evidence_ids_json, created_at,
        content_json, schema_version, version, status, source_refs_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      htmlId,
      'student_demo',
      '',
      'test-fixture',
      '',
      'case_analysis',
      'HTML 原件回归',
      'html',
      htmlPath,
      htmlContent,
      '[]',
      createdAt,
      '{}',
      'Markdown@1',
      1,
      'ready',
      '[]',
    )
  } finally {
    db.close()
  }

  const html = await client.artifactsExport(htmlId, 'html')
  expect(resolve(html.path).toLowerCase()).toBe(resolve(htmlPath).toLowerCase())
  expect(existsSync(html.path)).toBe(true)
  expect(readFileSync(html.path, 'utf8')).toBe(htmlContent)

  const reloaded = await client.invoke<Array<Record<string, unknown>>>('artifacts.list', { limit: 100 })
  expect(reloaded.some((artifact) => artifact.id === htmlId)).toBe(true)
})
