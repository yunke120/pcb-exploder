// 验证 ODB++ 铜皮(铺铜)与网络的绑定准确性。
// 用 esbuild 把 odb.ts 打包后，对真实 odb/ 目录运行 parseOdb，
// 交叉检查：落在铺铜内部(排除内孔)的过孔/焊盘，是否与铺铜归属同一网络。
import { build } from 'esbuild'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { pathToFileURL } from 'url'

const ROOT = process.argv[2] || 'odb'
const OUT = join(process.env.TMP || '/tmp', 'odb_bundle.mjs')

// 1) 收集 odb 目录树为 FileEntry[]
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

// 2) 打包 odb.ts（含其依赖）为可在 node 运行的 ESM
await build({
  entryPoints: ['src/lib/odb.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: OUT,
  logLevel: 'error',
})
const { parseOdb } = await import(pathToFileURL(OUT).href)

const design = await parseOdb(entries)

// 3) 与 odb.ts 中一致的点在多边形判定（用于交叉验证）
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
function reps(f) {
  if (f.kind === 'pad' && f.x != null) return [[f.x, f.y]]
  if (f.kind === 'line' && f.x1 != null) return [[f.x1, f.y1], [(f.x1 + f.x2) / 2, (f.y1 + f.y2) / 2], [f.x2, f.y2]]
  if (f.kind === 'arc' && f.x1 != null) return [[(f.x1 + f.x2) / 2, (f.y1 + f.y2) / 2]]
  return []
}

let totalSurfaces = 0
let totalInsideFeatures = 0
let mismatched = 0
const mismatches = []

for (const layer of design.layers) {
  if (!layer.nets) continue
  // 图元索引 -> 网络名
  const primToNet = new Map()
  for (const net of layer.nets) for (const pi of net.primitiveIdxs) primToNet.set(pi, net.name)

  // 找出所有铜箔
  const surfIdx = []
  layer.features.forEach((f, i) => {
    if (f.kind === 'surface') surfIdx.push(i)
  })
  totalSurfaces += surfIdx.length

  // 对每个非铜箔图元，若其代表点落在某铜箔内部 -> 应和该铜箔同网
  for (let j = 0; j < layer.features.length; j++) {
    const f = layer.features[j]
    if (f.kind === 'surface') continue
    const pts = reps(f)
    if (!pts.length) continue
    for (const si of surfIdx) {
      const sf = layer.features[si]
      let inside = false
      for (const [x, y] of pts) {
        if (x < 1e9) {
          // 粗筛：包围盒
          let inBox = true
          // 用 surf 包围盒快筛
          if (inSurf(sf, x, y)) { inside = true; break }
        }
      }
      if (!inside) continue
      totalInsideFeatures++
      const surfNet = primToNet.get(si)
      const featNet = primToNet.get(j)
      if (surfNet !== featNet) {
        mismatched++
        if (mismatches.length < 20)
          mismatches.push({
            layer: layer.name,
            surfNet: surfNet ?? '(none)',
            featNet: featNet ?? '(none)',
            featKind: f.kind,
          })
      }
      break
    }
  }
  const explicit = layer.nets.filter((n) => n.explicit).length
  const synth = layer.nets.length - explicit
  // 绑定到“真实网名”的铜箔数（铜箔所在网络为显式网）
  let surfExplicit = 0
  for (const si of surfIdx) {
    const nm = primToNet.get(si)
    if (nm && !nm.startsWith('Net ')) surfExplicit++
  }
  console.log(
    `层 ${layer.name.padEnd(10)} | 网络 ${String(layer.nets.length).padStart(4)} (显式 ${String(explicit).padStart(4)} / 合成 ${synth}) | 铜箔 ${String(surfIdx.length).padStart(4)} (绑真实网名 ${surfExplicit})`,
  )
}

console.log('\n=== 交叉验证汇总 ===')
console.log(`铜箔总数: ${totalSurfaces}`)
console.log(`落在铜箔内部(排除内孔)的图元数: ${totalInsideFeatures}`)
console.log(`与所属铜箔网络不一致的图元数: ${mismatched}`)
if (mismatches.length) {
  console.log('示例不一致:')
  for (const m of mismatches) console.log(`  [${m.layer}] 铜箔网=${m.surfNet}  图元(${m.featKind})网=${m.featNet}`)
}
console.log(mismatched === 0 ? '\n✅ 所有铺铜内部图元均与铺铜同网（绑定准确）' : '\n⚠️ 仍存在绑定不一致')
