// 验证图纸导出的原生 PDF 生成：
// 1) 纯矢量（无 Image XObject / 无 JPEG），页数正确；
// 2) 底层丝印 rotate180 在内容流中生成 180° 旋转 cm 矩阵（-1 0 0 -1 ...）；
// 3) 负片层（polarity=NEGATIVE）用 evenodd `f*` 把板框挖掉空隙；
// 4) 正片层正常输出焊盘/走线/铺铜运算符。
import { build } from 'esbuild'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { inflateSync } from 'zlib'
import { writeFileSync, mkdirSync } from 'fs'

const TMP = join(process.env.TMP || '/tmp', 'pdf_export')

await build({ entryPoints: ['src/lib/pdfExport.ts'], bundle: true, format: 'esm', platform: 'node', outfile: TMP + '.mjs', logLevel: 'error' })
const { buildPdfFromLayers } = await import(pathToFileURL(TMP + '.mjs').href)

const g = { minX: 0, minY: 0, w: 100, h: 60 }

const roundSym = { kind: 'round', w: 1, h: 1, d: 1 }
const mkPad = (x, y) => ({ kind: 'pad', symbol: 1, polarity: 'P', x, y })
const mkSurface = (poly, holes) => ({ kind: 'surface', symbol: 0, polarity: 'P', poly, holes })

// 顶层铜箔：焊盘 + 铺铜（带内孔）
const topCopper = {
  name: 'top', type: 'SIGNAL', row: 0, polarity: 'POSITIVE',
  meta: { kind: 'topCopper', name: 'TOP', color: '#e08a3c', order: 100, renderable: true },
  symbols: { 1: roundSym },
  features: [
    mkPad(10, 10),
    mkSurface([[0, 0], [60, 0], [60, 40], [0, 40]], [[[20, 10], [30, 10], [30, 20], [20, 20]]]),
  ],
  vb: { minX: 0, minY: 0, w: 100, h: 60 },
}
// 底层丝印（rotate180）：焊盘放在 (70,40)，翻转后应出现在 (30,20)（板中心对称）
const bottomSilk = {
  name: 'silk_bot', type: 'SILK_SCREEN', row: 0, polarity: 'POSITIVE',
  meta: { kind: 'bottomSilkscreen', name: 'BOT SILK', color: '#dcdcdc', order: 10, renderable: true },
  symbols: { 1: roundSym },
  features: [mkPad(70, 40)],
  vb: { minX: 0, minY: 0, w: 100, h: 60 },
}
// 负片内层（电源平面）：空隙用 surface 表示，铜箔=板框-空隙
const negPlane = {
  name: 'pwr', type: 'POWER_GROUND', row: 2, polarity: 'NEGATIVE',
  meta: { kind: 'innerCopper', name: 'PWR', color: '#b06a28', order: 42, renderable: true },
  symbols: {},
  features: [mkSurface([[30, 20], [50, 20], [50, 40], [30, 40]])],
  vb: { minX: 0, minY: 0, w: 100, h: 60 },
}

const layers = [
  { color: '#e08a3c', odb: topCopper },
  { color: '#dcdcdc', odb: bottomSilk, rotate180: true },
  { color: '#b06a28', odb: negPlane },
]

const pdf = await buildPdfFromLayers(layers, g, 'perPage')

const asStr = (buf) => Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('latin1')
const s = asStr(pdf)

// 页数与结构
const pages = (s.match(/\/Type \/Page\b/g) || []).length
const hasImage = s.includes('/Subtype /Image')
const noJpeg = !s.includes('DCTDecode')
const hasFlate = s.includes('FlateDecode')

// 解压所有内容流
function streams(buf) {
  const t = asStr(buf)
  const out = []
  let i = 0
  while ((i = t.indexOf('stream\n', i)) !== -1) {
    const head = t.slice(Math.max(0, i - 100), i)
    const lm = head.match(/\/Length\s+(\d+)/)
    if (!lm) { i += 7; continue }
    const len = parseInt(lm[1], 10)
    const start = i + 7
    try { out.push(inflateSync(Buffer.from(t.slice(start, start + len), 'latin1')).toString('latin1')) } catch {}
    i = start + len
  }
  return out
}
const contents = streams(pdf)

const check = (cond, msg) => {
  if (!cond) { console.log('FAIL:', msg); process.exit(1) }
  console.log('PASS:', msg)
}

check(pages === 3, `页数 = 3（实际 ${pages}）`)
check(!hasImage, '无 Image XObject（纯矢量）')
check(noJpeg, '无 JPEG/DCTDecode')
check(hasFlate, '含 FlateDecode 压缩')
check(contents.length === 3, `3 个内容流（实际 ${contents.length}）`)

// 运算符出现在行尾（如 "... c"、"... m"）或独立成行（如 "f"、"f*"、"h"、"q"、"Q"）
const lineEnd = (txt, o) => new RegExp('\\s' + o.replace('*', '\\*') + '(\\n|$)').test(txt)
const alone = (txt, o) => new RegExp('(^|\\n)' + o.replace('*', '\\*') + '(\\n|$)').test(txt)

// 第 1 页：顶层铜箔（含焊盘椭圆 f、铺铜 evenodd f*）
const c0 = contents[0]
check(lineEnd(c0, 'c') && alone(c0, 'f'), '顶层铜箔含贝塞尔圆/椭圆填充')
check(alone(c0, 'f*'), '顶层铜箔铺铜含内孔 evenodd f*')

// 第 2 页：底层丝印 rotate180 → cm 矩阵
const c1 = contents[1]
check(alone(c1, 'q') && alone(c1, 'Q'), '底层丝印 rotate180 有 q/Q 变换括号')
check(/-1 0 0 -1 [\d.]+ [\d.]+ cm/.test(c1), '底层丝印含 180° 旋转 cm 矩阵（-1 0 0 -1 ...）')
check(c1.includes('0.3 0.3 0.3 rg'), '底层丝印用深灰导出（0.3 0.3 0.3）')

// 第 3 页：负片平面 → 板框 + 空隙 evenodd
const c2 = contents[2]
check(alone(c2, 'f*'), '负片层用 evenodd f* 填充')
check(lineEnd(c2, 'm') && alone(c2, 'h'), '负片层含板框矩形路径')

// 保存产物供 pymupdf 目视检查
mkdirSync('scripts/.shots', { recursive: true })
writeFileSync('scripts/.shots/export-mock.pdf', pdf)
console.log('saved scripts/.shots/export-mock.pdf (' + pdf.length + ' bytes)')
console.log('OK')
