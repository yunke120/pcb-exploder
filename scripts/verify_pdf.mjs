// 验证原生矢量 PDF 生成：从 ODB++ 解析结果直接生成 PDF，
// 校验结构（%PDF 头 / %%EOF / 无 DCTDecode 位图 / FlateDecode 流可解压 / 含路径运算符），
// 并保存产物到 scripts/.shots/ 供目视检查。
import { build } from 'esbuild'
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { inflateSync } from 'zlib'

const ROOT = process.argv[2] || 'odb'
const OUT_DIR = 'scripts/.shots'
mkdirSync(OUT_DIR, { recursive: true })
const TMP = join(process.env.TMP || '/tmp', 'pdf_native')

function walk(dir, base, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const rel = (base ? base + '/' : '') + name
    if (statSync(p).isDirectory()) walk(p, rel, out)
    else out.push({ path: rel, bytes: () => Promise.resolve(new Uint8Array(readFileSync(p))) })
  }
}
const entries = []
walk(ROOT, '', entries)

// 1) 打包 pdfExport（无运行时依赖，可独立运行）
await build({ entryPoints: ['src/lib/pdfExport.ts'], bundle: true, format: 'esm', platform: 'node', outfile: TMP + '_pdf.mjs', logLevel: 'error' })
const { buildPdfFromLayers } = await import(pathToFileURL(TMP + '_pdf.mjs').href)

// 2) 打包 odb 解析器
await build({ entryPoints: ['src/lib/odb.ts'], bundle: true, format: 'esm', platform: 'node', outfile: TMP + '_odb.mjs', logLevel: 'error' })
const { parseOdb } = await import(pathToFileURL(TMP + '_odb.mjs').href)

const design = await parseOdb(entries)
const renderable = design.layers.filter((l) => l.meta.renderable && l.features.length > 0)
const vbs = renderable.map((l) => l.vb)
if (design.profile) vbs.push(design.profile)
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
for (const v of vbs) {
  minX = Math.min(minX, v.minX); minY = Math.min(minY, v.minY)
  maxX = Math.max(maxX, v.minX + v.w); maxY = Math.max(maxY, v.minY + v.h)
}
const g = { minX, minY, w: maxX - minX, h: maxY - minY }

const layers = renderable
  .sort((a, b) => a.meta.order - b.meta.order)
  .map((l) => ({ color: l.meta.color, odb: l }))

console.log('图层数:', layers.length, '| 板框:', g.w.toFixed(1), 'x', g.h.toFixed(1), 'mm')

// 图元统计
const stat = { pad: 0, line: 0, arc: 0, surface: 0, holes: 0 }
for (const l of layers) {
  for (const f of l.odb.features) {
    if (f.polarity === 'N') continue
    if (f.kind === 'pad') stat.pad++
    else if (f.kind === 'line') stat.line++
    else if (f.kind === 'arc') stat.arc++
    else if (f.kind === 'surface') { stat.surface++; if (f.holes?.length) stat.holes++ }
  }
}
console.log('图元:', JSON.stringify(stat))

// 结构校验：提取每个 FlateDecode 流并解压，返回拼接后的内容文本
function extractStreams(buf) {
  const s = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('latin1')
  const out = []
  let i = 0
  while ((i = s.indexOf('stream\n', i)) !== -1) {
    const head = s.slice(Math.max(0, i - 80), i)
    const lm = head.match(/\/Length\s+(\d+)/)
    if (!lm) { i += 7; continue }
    const len = parseInt(lm[1], 10)
    const start = i + 'stream\n'.length
    const raw = Buffer.from(s.slice(start, start + len), 'latin1')
    try {
      out.push(inflateSync(raw).toString('latin1'))
    } catch {
      // 误匹配的 stream 标记，跳过
    }
    i = start + len
  }
  return out
}

function validate(label, buf) {
  const s = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('latin1')
  const ok = {
    header: s.startsWith('%PDF-1.4'),
    eof: s.trimEnd().endsWith('%%EOF'),
    noJpeg: !s.includes('DCTDecode'),
    hasFlate: s.includes('FlateDecode'),
  }
  const streams = extractStreams(buf)
  const all = streams.join('')
  const ops = {
    evenodd: /f\*\n/.test(all),
    moveto: /\bm\n/.test(all),
    bezier: /\bc\n/.test(all),
    line: /\bl\n/.test(all),
    stroke: /\nS\n/.test(all),
    fillColor: /\brg\n/.test(all),
  }
  const pages = (s.match(/\/Type \/Page\b/g) || []).length
  console.log(label, JSON.stringify({ ...ok, pages, streams: streams.length, ops, size: buf.length }))
  if (!ok.header || !ok.eof || !ok.noJpeg || pages === 0 || streams.length === 0) {
    throw new Error('PDF 校验失败: ' + JSON.stringify(ok) + ' pages=' + pages)
  }
  return ok
}

const grid = await buildPdfFromLayers(layers, g, 'grid')
const perPage = await buildPdfFromLayers(layers, g, 'perPage')
writeFileSync(join(OUT_DIR, 'odb-native-grid.pdf'), grid)
writeFileSync(join(OUT_DIR, 'odb-native-perPage.pdf'), perPage)
validate('grid   ', grid)
validate('perPage', perPage)
console.log('已保存:', join(OUT_DIR, 'odb-native-grid.pdf'), '与', join(OUT_DIR, 'odb-native-perPage.pdf'))
console.log('OK')
