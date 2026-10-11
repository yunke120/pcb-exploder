// 验证种子点绑定：各铜层焊盘匹配情况、铜箔网名正确性
import { build } from 'esbuild'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'

const ROOT = process.argv[2] || 'odb'
const OUT = join(process.env.TMP || '/tmp', 'odb_verify2.mjs')

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
await build({ entryPoints: ['src/lib/odb.ts'], bundle: true, format: 'esm', platform: 'node', outfile: OUT, logLevel: 'error' })
const { parseOdb } = await import(pathToFileURL(OUT).href)
const design = await parseOdb(entries)

// 独立交叉验证：点在内判定（与源码一致）
function pip(poly, x, y) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
function inSurf(f, x, y) {
  if (!f.poly || f.poly.length < 3) return false
  if (!pip(f.poly, x, y)) return false
  if (f.holes) for (const h of f.holes) if (h.length >= 3 && pip(h, x, y)) return false
  return true
}

for (const layer of design.layers) {
  if (!layer.nets) continue
  const primToNet = new Map()
  for (const net of layer.nets) for (const pi of net.primitiveIdxs) primToNet.set(pi, net.name)
  const pads = [], surfs = [], traces = []
  layer.features.forEach((f, i) => {
    if (f.kind === 'pad') pads.push(i)
    else if (f.kind === 'surface') surfs.push(i)
    else traces.push(i)
  })
  const padsNamed = pads.filter((i) => primToNet.get(i) && !primToNet.get(i).startsWith('Net ')).length
  const surfNamed = surfs.filter((i) => primToNet.get(i) && !primToNet.get(i).startsWith('Net ')).length
  const explicit = layer.nets.filter((n) => n.explicit).length
  console.log(
    `层 ${layer.name.padEnd(10)} | 网络 ${String(layer.nets.length).padStart(4)} (显式 ${explicit}) | 焊盘 ${String(pads.length).padStart(4)} (绑真名 ${padsNamed}) | 铜箔 ${String(surfs.length).padStart(4)} (绑真名 ${surfNamed}) | 走线 ${traces.length}`,
  )
}

// 交叉验证：每个铜箔的网名应等于“落在其内部焊盘”的众数网名（同源，主要查一致性）
// 更关键：统计铜箔内部焊盘网名与其铜箔网名不一致的数量（应为 0，因众数即取此值）
let surfMismatch = 0
for (const layer of design.layers) {
  if (!layer.nets) continue
  const primToNet = new Map()
  for (const net of layer.nets) for (const pi of net.primitiveIdxs) primToNet.set(pi, net.name)
  layer.features.forEach((f, si) => {
    if (f.kind !== 'surface') return
    const sn = primToNet.get(si)
    if (!sn) return
    const counts = new Map()
    layer.features.forEach((g, gi) => {
      if (g.kind !== 'pad' || g.x == null) return
      const gn = primToNet.get(gi)
      if (!gn) return
      if (inSurf(f, g.x, g.y)) counts.set(gn, (counts.get(gn) || 0) + 1)
    })
    let best = null, bestC = -1
    for (const [k, c] of counts) if (c > bestC) { bestC = c; best = k }
    if (best && best !== sn) surfMismatch++
  })
}
console.log(`\n铜箔内部焊盘众数网名与铜箔网名不一致的铜箔数: ${surfMismatch}`)

// 正确的 ground truth 验证：焊盘绑定。
// 网表种子点 = (netref, drill, x, y)，其中 (x,y) 是焊盘/过孔中心。
// 对每个铜层的每个焊盘，若存在距离 < 0.15mm 的种子点，则焊盘应绑定到该种子的网名。
import { readFileSync as _r } from 'fs'
const _buf = _r('odb/steps/pcb/netlists/cadnet/netlist')
let netlistRaw
try {
  netlistRaw = new TextDecoder('utf-8', { fatal: true }).decode(_buf)
} catch {
  try {
    netlistRaw = new TextDecoder('gbk').decode(_buf)
  } catch {
    netlistRaw = _buf.toString('utf-8')
  }
}
const lines2 = netlistRaw.split(/\r?\n/)
const netNames2 = []
const seedsByNet = new Map() // netref -> {x,y}[]
let inPoints2 = false
for (const raw of lines2) {
  const line = raw.trim()
  if (line.startsWith('#')) {
    if (/netlist points/i.test(line)) inPoints2 = true
    continue
  }
  if (/^\$\d+/.test(line)) {
    const idx = parseInt(line.slice(1).trim(), 10)
    netNames2[idx] = line.replace(/^\$\d+\s+/, '').trim()
    continue
  }
  if (inPoints2) {
    const p = line.split(/\s+/)
    if (p.length < 4) continue
    const netref = parseInt(p[0], 10)
    const x = parseFloat(p[2]) * 25.4
    const y = parseFloat(p[3]) * 25.4
    if (!isFinite(x) || !isFinite(y)) continue
    if (!seedsByNet.has(netref)) seedsByNet.set(netref, [])
    seedsByNet.get(netref).push({ x, y })
  }
}
// 建立种子空间网格（按层独立做，但种子全局）
const allSeeds = []
for (const [netref, pts] of seedsByNet) for (const p of pts) allSeeds.push({ netref, ...p })
const seedGrid = new Map()
for (let i = 0; i < allSeeds.length; i++) {
  const s = allSeeds[i]
  const k = `${Math.floor(s.x / 1)},${Math.floor(s.y / 1)}`
  if (!seedGrid.has(k)) seedGrid.set(k, [])
  seedGrid.get(k).push(i)
}
const findSeed = (x, y, tol) => {
  let best = -1
  let bestD = tol
  const cx = Math.floor(x / 1), cy = Math.floor(y / 1)
  for (let gx = -1; gx <= 1; gx++) for (let gy = -1; gy <= 1; gy++) {
    const b = seedGrid.get(`${cx + gx},${cy + gy}`)
    if (!b) continue
    for (const si of b) {
      const s = allSeeds[si]
      const d = Math.hypot(s.x - x, s.y - y)
      if (d < bestD) { bestD = d; best = s.netref }
    }
  }
  return best
}

let padTotal = 0
let padSeeded = 0
let padWrong = 0
const padWrongExamples = []
for (const layer of design.layers) {
  if (!layer.nets) continue
  const primToNet = new Map()
  for (const net of layer.nets) for (const pi of net.primitiveIdxs) primToNet.set(pi, net.name)
  layer.features.forEach((f, i) => {
    if (f.kind !== 'pad' || f.x == null) return
    padTotal++
    const nr = findSeed(f.x, f.y, 0.15)
    if (nr <= 0) return
    padSeeded++
    const expect = netNames2[nr]
    const got = primToNet.get(i)
    if (got !== expect) {
      padWrong++
      if (padWrongExamples.length < 10) padWrongExamples.push({ layer: layer.name, expect, got, x: f.x, y: f.y })
    }
  })
}
console.log(`\n=== 焊盘绑定验证（ground truth）===`)
console.log(`焊盘总数: ${padTotal} | 有种子点的焊盘: ${padSeeded} | 绑定错误的焊盘: ${padWrong}`)
for (const e of padWrongExamples) console.log(`  [${e.layer}] 期望 ${e.expect} / 实际 ${e.got} @(${e.x.toFixed(2)},${e.y.toFixed(2)})`)
console.log(padWrong === 0 ? '\n✅ 所有有种子点的焊盘均绑定正确网名' : '\n⚠️ 仍存在焊盘绑定错误')

// 不变量检查：任何 primitive 不得出现在多个网络中（“勾选不同网络高亮同一块铜箔”的根源）
let overlap = 0
let surfOverlap = 0
for (const layer of design.layers) {
  if (!layer.nets) continue
  const primToNets = new Map()
  const surfIdx = new Set()
  layer.features.forEach((f, i) => { if (f.kind === 'surface') surfIdx.add(i) })
  for (const net of layer.nets) for (const pi of net.primitiveIdxs) {
    if (!primToNets.has(pi)) primToNets.set(pi, [])
    primToNets.get(pi).push(net.name)
  }
  for (const [pi, names] of primToNets) if (names.length > 1) {
    overlap++
    if (surfIdx.has(pi)) surfOverlap++
  }
}
console.log(`\n=== 不变量检查 ===`)
console.log(`被多个网络共享的 primitive: ${overlap} | 其中铜箔: ${surfOverlap}`)
console.log(overlap === 0 ? '✅ 每个图元(含铜箔)恰好属于一个网络' : '⚠️ 仍存在跨网络共享')
