import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { test, expect } from '../fixtures/test.js'

/**
 * 依赖：UI-13（本地文件预览视图）、IPC-36（files.preview）、IPC-37（files.openDialog）、SVC-27（沙箱 FS containment 基线）。
 *
 * 源码口径（apps/desktop/src/main/index.ts 的 previewFile）：
 * - .md/.markdown → markdown（text/markdown）；.docx → mammoth 转 html；.html/.htm → html（text/html）；
 *   .txt/.csv/.json → text（text/plain）；.png/.jpg/.jpeg/.webp/.gif/.svg → image（base64 data URL）；
 *   .pdf → pdf（application/pdf，base64 data URL）；其余扩展名 → unsupported，content 为空串，mime application/octet-stream。
 *
 * 自动化边界（人工项，不在本用例伪造）：
 * - files.openDialog 走原生 dialog.showOpenDialog，无法脚本化选择文件或触发取消，取消返回 undefined 的路径属人工验收项。
 * - .docx 分支需要真实 OOXML（zip 容器）；harness 无 zip 写入能力，不伪造二进制，mammoth 转换结果列入人工项。
 */

interface FilePreview {
  path: string
  name: string
  kind: string
  content: string
  mime: string
}

/** 1×1 合法 PNG（最小合法图像字节，base64 解码后写入）。 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

/** 手写最小合法 PDF：%PDF-1.4 开头，含 xref / trailer / startxref / %%EOF。 */
const MINIMAL_PDF = [
  '%PDF-1.4',
  '1 0 obj',
  '<< /Type /Catalog /Pages 2 0 R >>',
  'endobj',
  '2 0 obj',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  'endobj',
  '3 0 obj',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
  'endobj',
  'xref',
  '0 4',
  '0000000000 65535 f',
  '0000000009 00000 n',
  '0000000058 00000 n',
  '0000000115 00000 n',
  'trailer',
  '<< /Size 4 /Root 1 0 R >>',
  'startxref',
  '190',
  '%%EOF',
  '',
].join('\n')

interface Sample {
  fileName: string
  bytes: Buffer | string
  kind: string
  mime: string
  encoded: boolean
}

const SAMPLES: Sample[] = [
  { fileName: 'a.md', bytes: '# 本地预览样本\n正文一行', kind: 'markdown', mime: 'text/markdown', encoded: false },
  { fileName: 'b.html', bytes: '<h1>预览 HTML</h1>', kind: 'html', mime: 'text/html', encoded: false },
  { fileName: 'h.htm', bytes: '<p>htm 扩展样本</p>', kind: 'html', mime: 'text/html', encoded: false },
  { fileName: 'c.txt', bytes: '纯文本内容\n第二行', kind: 'text', mime: 'text/plain', encoded: false },
  { fileName: 'g.csv', bytes: 'name,level\n甲,A', kind: 'text', mime: 'text/plain', encoded: false },
  { fileName: 'd.png', bytes: PNG_1X1, kind: 'image', mime: 'image/png', encoded: true },
  { fileName: 'i.svg', bytes: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>', kind: 'image', mime: 'image/svg+xml', encoded: true },
  { fileName: 'e.pdf', bytes: MINIMAL_PDF, kind: 'pdf', mime: 'application/pdf', encoded: true },
  { fileName: 'f.unknown', bytes: 'not-a-known-extension', kind: 'unsupported', mime: 'application/octet-stream', encoded: false },
]

test('TC-P1-14 本地文件预览：扩展名映射、data URL 与缺失路径上抛', async ({ client, home }) => {
  const filesDir = join(home.home, 'files')
  mkdirSync(filesDir, { recursive: true })

  for (const sample of SAMPLES) {
    writeFileSync(join(filesDir, sample.fileName), sample.bytes)
  }

  for (const sample of SAMPLES) {
    const filePath = join(filesDir, sample.fileName)
    const preview = await client.invoke<FilePreview>('files.preview', { path: filePath })

    // 返回的 path/name 必须与传入一致。
    expect(preview.path).toBe(filePath)
    expect(preview.name).toBe(basename(filePath))
    expect(preview.kind).toBe(sample.kind)
    expect(preview.mime).toBe(sample.mime)

    if (sample.kind === 'unsupported') {
      expect(preview.content).toBe('')
    } else if (sample.encoded) {
      expect(preview.content.startsWith(`data:${sample.mime};base64,`)).toBe(true)
    } else {
      expect(preview.content).toBe(sample.bytes.toString('utf8'))
    }
  }

  // 不存在路径：readFile 上抛，IPC reject，不静默返回空预览。
  const missing = join(filesDir, 'does-not-exist.md')
  await expect(client.invoke('files.preview', { path: missing })).rejects.toThrow()
})
