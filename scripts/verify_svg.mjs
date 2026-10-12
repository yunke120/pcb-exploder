// 验证 ODB++ → 矢量 SVG 生成：元素数量、viewBox、无 NaN、evenodd surface。
import { build } from 'esbuild'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'

const ROOT = 'odb'
const OUT = join(process.env.TMP || '/tmp', 'pdf_export_bundle.mjs')

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

await build({
  entryPoints: ['src/lib/pdfExport.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: OUT,
  logLevel: 'error',
  external: ['jspdf', 'svg2pdf.js'],
})
const { renderOdbToSvg } = await import(pathToFileURL(OUT).href)

await build({ entryPoints: ['src/lib/odb.ts'], bundle: true, format: 'esm', platform: 'node', outfile: OUT.replace('.mjs', '_odb.mjs'), logLevel: 'error' })
const { parseOdb } = await import(pathToFileURL(OUT.replace('.mjs', '_odb.mjs')).href)
const design = await parseOdb(entries)

const vbs = design.layers.filter(l => l.meta.renderable && l.features.length).map(l => l.vb)
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
for (const v of vbs) { minX = Math.min(minX, v.minX); minY = Math.min(minY, v.minY); maxX = Math.max(maxX, v.minX + v.w); maxY = Math.max(maxY, v.minY + v.h) }
const g = { minX, minY, w: maxX - minX, h: maxY - minY }

let total = { circle: 0, rect: 0, ellipse: 0, line: 0, path: 0, evenodd: 0 }
let nan = 0
for (const layer of design.layers.filter(l => l.meta.renderable && l.features.length)) {
  const svg = renderOdbToSvg(layer, g, layer.meta.color)
  if (!/viewBox=/.test(svg)) { console.log('NO viewBox:', layer.name); continue }
  if (/NaN/.test(svg)) nan++
  total.circle += (svg.match(/<circle/g) || []).length
  total.rect += (svg.match(/<rect/g) || []).length
  total.ellipse += (svg.match(/<ellipse/g) || []).length
  total.line += (svg.match(/<line/g) || []).length
  total.path += (svg.match(/<path/g) || []).length
  total.evenodd += (svg.match(/evenodd/g) || []).length
  if (layer.name === 'top') writeFileSync('scripts/.shots/top.svg', svg)
}

console.log(JSON.stringify({ g: { w: +g.w.toFixed(2), h: +g.h.toFixed(2) }, total, nan }, null, 2))
