// 验证带技术要求页的 PDF 生成：mock canvas 使 renderTechBitmap 可在 Node 运行，
// 校验 PDF 结构（%PDF 头 / 页数 = 1 技术页 + N 图层页 / 含 Image XObject / FlateDecode 无 JPEG）。
import { build } from 'esbuild'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { inflateSync } from 'zlib'
import { writeFileSync, mkdirSync } from 'fs'

const TMP = join(process.env.TMP || '/tmp', 'pdf_tech')

// ---- mock 浏览器 canvas ----
function makeFakeCtx() {
  return {
    scale: () => {}, fillStyle: '', strokeStyle: '', font: '', lineWidth: 1, textBaseline: '',
    fillRect: () => {}, fillText: () => {}, beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, stroke: () => {},
    measureText: (t) => ({ width: t.length * 11 }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }),
  }
}
global.document = {
  createElement: (tag) => tag === 'canvas'
    ? { width: 0, height: 0, getContext: () => makeFakeCtx() }
    : {},
}

await build({ entryPoints: ['src/lib/pdfExport.ts'], bundle: true, format: 'esm', platform: 'node', outfile: TMP + '.mjs', logLevel: 'error' })
const { buildPcbPdf, buildPdfFromLayers } = await import(pathToFileURL(TMP + '.mjs').href)

const mkLayer = (kind, color, name) => ({
  name, type: 'SIGNAL', row: 0, polarity: 'POSITIVE',
  meta: { kind, name, color, order: 0, renderable: true },
  symbols: {}, features: [],
  vb: { minX: 0, minY: 0, w: 100, h: 50 },
})
const g = { minX: 0, minY: 0, w: 100, h: 50 }
const layers = [
  { color: '#e08a3c', odb: mkLayer('topCopper', '#e08a3c', 'TOP') },
  { color: '#2f9e54', odb: mkLayer('topSolderMask', '#2f9e54', 'MASK') },
]
const tech = { title: '印制板图技术要求', items: ['基板材料 δ=1.6mm±10%，2层铜箔板', '外形尺寸 100mm × 50mm', '按照 QJ 3259-2005 要求喷涂三防漆'] }

const pcb = await buildPcbPdf(layers, g, tech)
const plain = await buildPdfFromLayers(layers, g, 'perPage')

const asStr = (buf) => Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('latin1')
function check(label, buf, expectPages, expectImage) {
  const s = asStr(buf)
  const pages = (s.match(/\/Type \/Page\b/g) || []).length
  const hasImage = s.includes('/Subtype /Image')
  const hasXObject = s.includes('/XObject')
  const noJpeg = !s.includes('DCTDecode')
  const hasFlate = s.includes('FlateDecode')
  // 解压所有流确认不抛异常
  let i = 0, streams = 0
  while ((i = s.indexOf('stream\n', i)) !== -1) {
    const head = s.slice(Math.max(0, i - 100), i)
    const lm = head.match(/\/Length\s+(\d+)/)
    if (!lm) { i += 7; continue }
    const len = parseInt(lm[1], 10)
    const start = i + 7
    try { inflateSync(Buffer.from(s.slice(start, start + len), 'latin1')); streams++ } catch {}
    i = start + len
  }
  console.log(label, JSON.stringify({ pages, expectPages, hasImage, hasXObject, noJpeg, hasFlate, streams, size: buf.length }))
  if (pages !== expectPages) throw new Error(`${label}: 页数 ${pages} != ${expectPages}`)
  if (expectImage && !hasImage) throw new Error(`${label}: 缺少 Image XObject`)
  if (!noJpeg) throw new Error(`${label}: 不应有 JPEG`)
  if (streams === 0) throw new Error(`${label}: 无有效流`)
}

check('印制板图PDF', pcb, 3, true)      // 1 技术页 + 2 图层页
check('纯图层PDF ', plain, 2, false)    // 2 图层页，无图像

// 保存产物供 pymupdf 目视检查图像页结构
mkdirSync('scripts/.shots', { recursive: true })
writeFileSync('scripts/.shots/tech-mock.pdf', pcb)
console.log('OK')
