// 验证双网络最小间距计算：
// 1) 基础几何单元测试（已知结果的圆/胶囊/多边形距离）；
// 2) 用真实 odb/ 数据取两个有共同层的显式网络，计算每层最小间距，
//    校验有限、对称、最近点对与距离一致。
import { build } from 'esbuild'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'odb'

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

async function bundle(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
  })
  const code = result.outputFiles[0].text
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
}

const odb = await bundle('src/lib/odb.ts')
const sp = await bundle('src/lib/spacing.ts')

// ---------- 1) 基础几何单元测试 ----------
let unitFailed = 0
function expect(desc, got, want, tol = 1e-6) {
  const ok = Math.abs(got - want) <= tol
  if (!ok) unitFailed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${desc}: got ${got.toFixed(6)} want ${want.toFixed(6)}`)
}
console.log('=== 基础几何单元测试 ===')
// 圆-圆
expect('circle-circle', sp.minSpacing([{ t: 'c', x: 0, y: 0, r: 1 }], [{ t: 'c', x: 5, y: 0, r: 1 }]).distance, 3)
expect('circle-circle overlap', sp.minSpacing([{ t: 'c', x: 0, y: 0, r: 1 }], [{ t: 'c', x: 1, y: 0, r: 1 }]).distance, 0)
// 胶囊-胶囊（平行）
expect(
  'capsule-capsule',
  sp.minSpacing(
    [{ t: 's', x0: 0, y0: 0, x1: 0, y1: 4, r: 0.5 }],
    [{ t: 's', x0: 3, y0: 0, x1: 3, y1: 4, r: 0.5 }],
  ).distance,
  2,
)
// 圆-胶囊
expect(
  'circle-capsule',
  sp.minSpacing([{ t: 'c', x: 0, y: 0, r: 0.5 }], [{ t: 's', x0: 3, y0: 0, x1: 3, y1: 4, r: 0.5 }]).distance,
  2,
)
// 圆-多边形
expect(
  'circle-poly',
  sp.minSpacing(
    [{ t: 'c', x: 0, y: 0.5, r: 0 }],
    [{ t: 'p', pts: [[2, 0], [3, 0], [3, 1], [2, 1]] }],
  ).distance,
  2,
)
// 多边形-多边形
expect(
  'poly-poly',
  sp.minSpacing(
    [{ t: 'p', pts: [[0, 0], [1, 0], [1, 1], [0, 1]] }],
    [{ t: 'p', pts: [[3, 0], [4, 0], [4, 1], [3, 1]] }],
  ).distance,
  2,
)
// 圆在多边形内部 → 0
expect(
  'circle-inside-poly',
  sp.minSpacing([{ t: 'c', x: 2.5, y: 0.5, r: 0 }], [{ t: 'p', pts: [[2, 0], [3, 0], [3, 1], [2, 1]] }]).distance,
  0,
)
// 带孔多边形：圆在孔内（应到孔边界距离，非 0）
const ring = { t: 'p', pts: [[0, 0], [10, 0], [10, 10], [0, 10]], holes: [[[4, 4], [6, 4], [6, 6], [4, 6]]] }
expect('circle-in-hole', sp.minSpacing([{ t: 'c', x: 5, y: 5, r: 0 }], [ring]).distance, 1)

console.log(unitFailed === 0 ? '单元测试全部通过 ✅' : `单元测试失败 ${unitFailed} 项 ❌`)

// ---------- 2) 真实数据：两显式网络跨层最小间距 ----------
console.log('\n=== 真实数据验证 ===')
const design = await odb.parseOdb(entries)

// 统计每个显式网名出现的层
const netLayers = new Map()
for (const layer of design.layers) {
  if (!layer.nets) continue
  for (const n of layer.nets) {
    if (!n.explicit) continue
    if (!netLayers.has(n.name)) netLayers.set(n.name, new Set())
    netLayers.get(n.name).add(layer.name)
  }
}
// 选两个有共同层的显式网络
const candidates = [...netLayers.entries()].filter(([, ls]) => ls.size >= 1)
let a = null
let b = null
outer: for (let i = 0; i < candidates.length; i++) {
  for (let j = i + 1; j < candidates.length; j++) {
    const common = [...candidates[i][1]].filter((x) => candidates[j][1].has(x))
    if (common.length >= 1) {
      a = candidates[i][0]
      b = candidates[j][0]
      break outer
    }
  }
}
if (!a || !b) {
  console.error('未找到两个有共同层的显式网络')
  process.exit(1)
}
console.log(`选择网络: 「${a}」 vs 「${b}」`)

let checked = 0
let fail = 0
for (const layer of design.layers) {
  if (!layer.nets) continue
  const na = layer.nets.find((n) => n.explicit && n.name === a)
  const nb = layer.nets.find((n) => n.explicit && n.name === b)
  if (!na || !nb) continue // 该层只有其中一个网络 → 跳过（符合需求）
  const shapesA = sp.odbNetShapes(layer, na)
  const shapesB = sp.odbNetShapes(layer, nb)
  const r = sp.minSpacing(shapesA, shapesB)
  checked++
  if (!r || !isFinite(r.distance)) {
    console.error(`  FAIL ${layer.name}: 结果无效`)
    fail++
    continue
  }
  // 对称性
  const r2 = sp.minSpacing(shapesB, shapesA)
  const symOk = Math.abs(r.distance - r2.distance) < 1e-6
  // 最近点对距离与报告一致
  const pd = Math.hypot(r.pA[0] - r.pB[0], r.pA[1] - r.pB[1])
  const ptOk = Math.abs(pd - r.distance) < 1e-6
  const posOk = r.distance > 0
  if (!symOk || !ptOk || !posOk) fail++
  console.log(
    `  ${layer.name.padEnd(10)} 图元 ${String(shapesA.length).padStart(4)}/${String(shapesB.length).padStart(4)} → 最小间距 ${r.distance.toFixed(4)} mm  ` +
      `最近点 (${r.pA[0].toFixed(2)},${r.pA[1].toFixed(2)}) ~ (${r.pB[0].toFixed(2)},${r.pB[1].toFixed(2)})` +
      `${symOk ? '' : ' [对称性不一致]'}${ptOk ? '' : ' [点距不一致]'}${posOk ? '' : ' [距离≤0]'}`,
  )
}

console.log(`\n共计算 ${checked} 个共同层（仅两网同时出现的层）`)
console.log(fail === 0 ? 'SPACING PASS ✅' : `SPACING FAIL（${fail} 项）❌`)
process.exit(unitFailed === 0 && fail === 0 ? 0 : 1)
