// 网络连通性分析：将相互接触（重叠/相切）的 Gerber 图元归并为同一网络。
// 显式 %TO.N 网络名优先；否则按几何连通性反推。

import type { ParsedLayer, Primitive } from './gerberParse'

const TOL = 0.1 // mm，额外连通容差

interface Sample {
  x: number
  y: number
  r: number // 半径（圆=孔径/2；线段=半宽）
  p: number // primitive index
}

interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function segSamples(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  w: number,
  out: Sample[],
) {
  const len = Math.hypot(x1 - x0, y1 - y0)
  const steps = Math.max(1, Math.min(64, Math.ceil(len / 0.4)))
  for (let s = 0; s <= steps; s++) {
    const t = s / steps
    out.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, r: w, p: -1 })
  }
}

function primSamples(pr: Primitive, out: Sample[]) {
  for (const o of pr.obs) {
    if (o.type === 'c') out.push({ x: o.x, y: o.y, r: o.r, p: -1 })
    else segSamples(o.x0, o.y0, o.x1, o.y1, o.w, out)
  }
}

function primBBox(pr: Primitive): BBox {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const o of pr.obs) {
    if (o.type === 'c') {
      minX = Math.min(minX, o.x - o.r)
      maxX = Math.max(maxX, o.x + o.r)
      minY = Math.min(minY, o.y - o.r)
      maxY = Math.max(maxY, o.y + o.r)
    } else {
      for (const [x, y] of [
        [o.x0, o.y0],
        [o.x1, o.y1],
      ]) {
        minX = Math.min(minX, x - o.w)
        maxX = Math.max(maxX, x + o.w)
        minY = Math.min(minY, y - o.w)
        maxY = Math.max(maxY, y + o.w)
      }
    }
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  return { minX, minY, maxX, maxY }
}

export interface Net {
  id: number
  name: string
  primitiveIdxs: number[]
  explicit: boolean
}

export function computeNets(parsed: ParsedLayer): Net[] {
  const prims = parsed.primitives
  const n = prims.length
  if (n === 0) return []

  // 采样点云（每个图元 -> 圆盘采样点）
  const samples: Sample[] = []
  const byPrim: Sample[][] = prims.map(() => [])
  for (let i = 0; i < n; i++) {
    const list: Sample[] = []
    primSamples(prims[i], list)
    byPrim[i] = list
    for (const s of list) samples.push({ ...s, p: i })
  }

  // 空间网格加速
  const CELL = 2 // mm
  const grid = new Map<string, number[]>()
  const key = (cx: number, cy: number) => `${Math.floor(cx / CELL)},${Math.floor(cy / CELL)}`
  for (let si = 0; si < samples.length; si++) {
    const s = samples[si]
    const k = key(s.x, s.y)
    if (!grid.has(k)) grid.set(k, [])
    grid.get(k)!.push(si)
  }

  const bboxes = prims.map(primBBox)

  // 并查集
  const parent = new Array(n).fill(0).map((_, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }

  const connected = (a: number, b: number): boolean => {
    const A = byPrim[a]
    for (const sa of A) {
      const cx = Math.floor(sa.x / CELL)
      const cy = Math.floor(sa.y / CELL)
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const bucket = grid.get(`${gx},${gy}`)
          if (!bucket) continue
          for (const si of bucket) {
            if (samples[si].p !== b) continue
            const sb = samples[si]
            if (Math.hypot(sa.x - sb.x, sa.y - sb.y) - sa.r - sb.r <= TOL) return true
          }
        }
      }
    }
    return false
  }

  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const A = bboxes[a]
      const B = bboxes[b]
      if (A.maxX + TOL < B.minX || B.maxX + TOL < A.minX) continue
      if (A.maxY + TOL < B.minY || B.maxY + TOL < A.minY) continue
      if (connected(a, b)) union(a, b)
    }
  }

  // 聚合
  const groups = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r)!.push(i)
  }

  const nets: Net[] = []
  let id = 0
  for (const [, idxs] of groups) {
    const names = new Set(idxs.map((i) => prims[i].netName).filter(Boolean))
    let name = ''
    let explicit = false
    if (names.size === 1) {
      name = [...names][0]
      explicit = true
    }
    nets.push({ id: id++, name, primitiveIdxs: idxs, explicit })
  }

  // 大网络优先
  nets.sort((a, b) => b.primitiveIdxs.length - a.primitiveIdxs.length)
  // 合成网络重命名
  let synth = 1
  for (const net of nets) {
    if (!net.explicit) net.name = `Net ${synth++}`
  }
  return nets
}
