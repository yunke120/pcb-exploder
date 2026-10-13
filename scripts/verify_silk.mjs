// 验证丝印层在 PDF 白底导出时使用深色（而非 3D 视图的浅色 #eaeaea/#dcdcdc）
import { build } from 'esbuild'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { inflateSync } from 'zlib'

const ROOT = process.argv[2] || 'odb'
const TMP = join(process.env.TMP || '/tmp', 'pdf_silk')

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

await build({ entryPoints: ['src/lib/pdfExport.ts'], bundle: true, format: 'esm', platform: 'node', outfile: TMP + '_pdf.mjs', logLevel: 'error' })
const { buildPdfFromLayers } = await import(pathToFileURL(TMP + '_pdf.mjs').href)
await build({ entryPoints: ['src/lib/odb.ts'], bundle: true, format: 'esm', platform: 'node', outfile: TMP + '_odb.mjs', logLevel: 'error' })
const { parseOdb } = await import(pathToFileURL(TMP + '_odb.mjs').href)

const design = await parseOdb(entries)
const renderable = design.layers.filter((l) => l.meta.renderable && l.features.length > 0)
const vbs = renderable.map((l) => l.vb)
if (design.profile) vbs.push(design.profile)
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
for (const v of vbs) { minX = Math.min(minX, v.minX); minY = Math.min(minY, v.minY); maxX = Math.max(maxX, v.minX + v.w); maxY = Math.max(maxY, v.minY + v.h) }
const g = { minX, minY, w: maxX - minX, h: maxY - minY }

const silks = renderable.filter((l) => l.meta.kind === 'topSilkscreen' || l.meta.kind === 'bottomSilkscreen')
console.log('丝印层数量:', silks.length, silks.map((l) => `${l.name}(${l.meta.kind}) 3D色=${l.meta.color}`).join(' | '))

function firstFillColor(buf) {
  const s = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('latin1')
  let i = 0
  while ((i = s.indexOf('stream\n', i)) !== -1) {
    const head = s.slice(Math.max(0, i - 80), i)
    const lm = head.match(/\/Length\s+(\d+)/)
    if (!lm) { i += 7; continue }
    const len = parseInt(lm[1], 10)
    const start = i + 'stream\n'.length
    const raw = Buffer.from(s.slice(start, start + len), 'latin1')
    try {
      const txt = inflateSync(raw).toString('latin1')
      const m = txt.match(/([\d.]+) ([\d.]+) ([\d.]+) rg/)
      if (m) return `${m[1]} ${m[2]} ${m[3]}`
    } catch { /* skip */ }
    i = start + len
  }
  return null
}

for (const l of silks) {
  const pdf = await buildPdfFromLayers([{ color: l.meta.color, odb: l }], g, 'perPage')
  const col = firstFillColor(pdf)
  console.log(`${l.meta.kind} → PDF 填充色: ${col}`)
}

// 断言：丝印层 PDF 颜色必须是深色（分量 < 0.5），不能是 3D 的浅色 ~0.92
let pass = true
for (const l of silks) {
  const pdf = await buildPdfFromLayers([{ color: l.meta.color, odb: l }], g, 'perPage')
  const col = firstFillColor(pdf)
  const v = parseFloat(col.split(' ')[0])
  if (v >= 0.5) { console.log('FAIL: 颜色仍偏浅', l.meta.kind, col); pass = false }
}
console.log(pass ? 'PASS: 丝印层已用深色导出' : 'FAILED')
process.exit(pass ? 0 : 1)
