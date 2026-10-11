// 双网络最小间距计算。
//
// 将 Gerber 图元 / ODB++ 图元统一分解为三种“填充形状”：
//   circle   —— 圆盘（焊盘/过孔）
//   capsule  —— 线段 + 半宽的胶囊（走线/圆弧近似）
//   poly     —— 填充多边形（矩形/八角焊盘、铜箔铺铜，可含内孔）
// 然后求两个网络在同一层上的形状集合之间的最小间距与最近点对。
//
// 单位：mm（与 odb.ts / nets.ts 约定一致）。

import type { Net } from './nets'
import type { OdbLayer, OdbFeature, OdbSymbol } from './odb'
import type { ParsedLayer } from './gerberParse'

export interface SpacingResult {
  layerId: string
  layerName: string
  /** 最小间距（mm） */
  distance: number
  /** 网络 A 上最近点（板坐标 mm） */
  pA: [number, number]
  /** 网络 B 上最近点（板坐标 mm） */
  pB: [number, number]
}

type Pt = [number, number]

export type SpShape =
  | { t: 'c'; x: number; y: number; r: number }
  | { t: 's'; x0: number; y0: number; x1: number; y1: number; r: number }
  | { t: 'p'; pts: Pt[]; holes?: Pt[][] }

interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

// ---------- 图元 → 形状 ----------

/** 将 ODB++ 图元（按 net.primitiveIdxs 索引 layer.features）分解为形状 */
export function odbNetShapes(layer: OdbLayer, net: Net): SpShape[] {
  const out: SpShape[] = []
  const feats = layer.features
  const syms = layer.symbols
  for (const i of net.primitiveIdxs) {
    const f = feats[i]
    if (f) pushOdbFeature(out, f, syms)
  }
  return out
}

/** 将 Gerber 图元（按 net.primitiveIdxs 索引 parsed.primitives）分解为形状 */
export function gerberNetShapes(parsed: ParsedLayer, net: Net): SpShape[] {
  const out: SpShape[] = []
  const prims = parsed.primitives
  for (const i of net.primitiveIdxs) {
    const pr = prims[i]
    if (!pr) continue
    for (const o of pr.obs) {
      if (o.type === 'c') out.push({ t: 'c', x: o.x, y: o.y, r: o.r })
      else out.push({ t: 's', x0: o.x0, y0: o.y0, x1: o.x1, y1: o.y1, r: o.w })
    }
  }
  return out
}

function pushOdbFeature(out: SpShape[], f: OdbFeature, syms: Record<number, OdbSymbol>) {
  const sym = syms[f.symbol]
  if (f.kind === 'pad' && f.x != null && f.y != null) {
    if (!sym) return
    const x = f.x
    const y = f.y
    switch (sym.kind) {
      case 'round':
      case 'donut':
      case 'unknown':
        out.push({ t: 'c', x, y, r: (sym.d ?? sym.w) / 2 })
        break
      case 'oval':
        out.push({ t: 'c', x, y, r: Math.max(sym.w, sym.h) / 2 })
        break
      case 'square':
      case 'rect': {
        const w = sym.w
        const h = sym.h
        out.push({
          t: 'p',
          pts: [
            [x - w / 2, y - h / 2],
            [x + w / 2, y - h / 2],
            [x + w / 2, y + h / 2],
            [x - w / 2, y + h / 2],
          ],
        })
        break
      }
      case 'oct': {
        const w = sym.w / 2
        const h = sym.h / 2
        const cw = w * 0.7071
        const ch = h * 0.7071
        out.push({
          t: 'p',
          pts: [
            [x - w + cw, y - h],
            [x + w - cw, y - h],
            [x + w, y - h + ch],
            [x + w, y + h - ch],
            [x + w - cw, y + h],
            [x - w + cw, y + h],
            [x - w, y + h - ch],
            [x - w, y - h + ch],
          ],
        })
        break
      }
    }
  } else if (f.kind === 'line' && f.x1 != null) {
    const w = sym?.d ?? Math.min(sym?.w ?? 1, sym?.h ?? 1)
    out.push({ t: 's', x0: f.x1, y0: f.y1!, x1: f.x2!, y1: f.y2!, r: w / 2 })
  } else if (f.kind === 'arc' && f.x1 != null && f.cx != null) {
    const w = sym?.d ?? Math.min(sym?.w ?? 1, sym?.h ?? 1)
    const r = Math.hypot(f.x1 - f.cx, f.y1! - f.cy!)
    if (r < 1e-6) {
      out.push({ t: 'c', x: f.x1, y: f.y1!, r: w / 2 })
    } else {
      const a1 = Math.atan2(f.y1! - f.cy!, f.x1 - f.cx!)
      const a2 = Math.atan2(f.y2! - f.cy!, f.x2! - f.cx!)
      let da = a2 - a1
      while (da > Math.PI) da -= 2 * Math.PI
      while (da < -Math.PI) da += 2 * Math.PI
      const steps = 24
      let px = f.x1
      let py = f.y1!
      for (let s = 1; s <= steps; s++) {
        const a = a1 + (da * s) / steps
        const nx = f.cx + Math.cos(a) * r
        const ny = f.cy! + Math.sin(a) * r
        out.push({ t: 's', x0: px, y0: py, x1: nx, y1: ny, r: w / 2 })
        px = nx
        py = ny
      }
    }
  } else if (f.kind === 'surface' && f.poly && f.poly.length >= 3) {
    const p: SpShape =
      f.holes && f.holes.length
        ? { t: 'p', pts: f.poly as Pt[], holes: f.holes as Pt[][] }
        : { t: 'p', pts: f.poly as Pt[] }
    out.push(p)
  }
}

// ---------- 基础几何 ----------

function bboxOf(s: SpShape): BBox {
  if (s.t === 'c') return { minX: s.x - s.r, minY: s.y - s.r, maxX: s.x + s.r, maxY: s.y + s.r }
  if (s.t === 's') {
    return {
      minX: Math.min(s.x0, s.x1) - s.r,
      minY: Math.min(s.y0, s.y1) - s.r,
      maxX: Math.max(s.x0, s.x1) + s.r,
      maxY: Math.max(s.y0, s.y1) + s.r,
    }
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const consider = (pts: Pt[]) => {
    for (const [x, y] of pts) {
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }
  consider(s.pts)
  if (s.holes) for (const h of s.holes) consider(h)
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  return { minX, minY, maxX, maxY }
}

/** 点到线段距离 */
function pointSegDist(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0
  const dy = y1 - y0
  const L2 = dx * dx + dy * dy
  let t = 0
  if (L2 > 0) t = ((px - x0) * dx + (py - y0) * dy) / L2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t))
}

/** 点到线段最近点 */
function pointSegClosest(px: number, py: number, x0: number, y0: number, x1: number, y1: number): Pt {
  const dx = x1 - x0
  const dy = y1 - y0
  const L2 = dx * dx + dy * dy
  let t = 0
  if (L2 > 0) t = ((px - x0) * dx + (py - y0) * dy) / L2
  t = Math.max(0, Math.min(1, t))
  return [x0 + dx * t, y0 + dy * t]
}

/** 两条线段最近点对（Ericson 实时光线碰撞检测算法） */
function segSegClosestPoints(
  p1: Pt,
  p2: Pt,
  p3: Pt,
  p4: Pt,
): [Pt, Pt] {
  const EPS = 1e-9
  const d1x = p2[0] - p1[0]
  const d1y = p2[1] - p1[1]
  const d2x = p4[0] - p3[0]
  const d2y = p4[1] - p3[1]
  const rx = p1[0] - p3[0]
  const ry = p1[1] - p3[1]
  const a = d1x * d1x + d1y * d1y
  const e = d2x * d2x + d2y * d2y
  const f = d2x * rx + d2y * ry
  let s = 0
  let t = 0
  if (a <= EPS && e <= EPS) {
    return [p1, p3]
  }
  if (a <= EPS) {
    s = 0
    t = clamp(f / e, 0, 1)
  } else {
    const c = d1x * rx + d1y * ry
    if (e <= EPS) {
      t = 0
      s = clamp(-c / a, 0, 1)
    } else {
      const b = d1x * d2x + d1y * d2y
      const denom = a * e - b * b
      s = denom > EPS ? clamp((b * f - c * e) / denom, 0, 1) : 0
      t = (b * s + f) / e
      if (t < 0) {
        t = 0
        s = clamp(-c / a, 0, 1)
      } else if (t > 1) {
        t = 1
        s = clamp((b - c) / a, 0, 1)
      }
    }
  }
  return [
    [p1[0] + d1x * s, p1[1] + d1y * s],
    [p3[0] + d2x * t, p3[1] + d2y * t],
  ]
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** 点是否在多边形内（射线法，偶奇规则） */
function pointInPoly(pts: Pt[], x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0]
    const yi = pts[i][1]
    const xj = pts[j][0]
    const yj = pts[j][1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** 点是否落在形状内部（poly 含孔洞判定） */
function pointInShape(s: SpShape, x: number, y: number): boolean {
  if (s.t === 'c') return Math.hypot(x - s.x, y - s.y) <= s.r
  if (s.t === 's') return pointSegDist(x, y, s.x0, s.y0, s.x1, s.y1) <= s.r
  if (!pointInPoly(s.pts, x, y)) return false
  if (s.holes) for (const h of s.holes) if (pointInPoly(h, x, y)) return false
  return true
}

/** 多边形全部边界边（外轮廓 + 内孔） */
function polyEdges(p: Extract<SpShape, { t: 'p' }>): [Pt, Pt][] {
  const edges: [Pt, Pt][] = []
  const add = (pts: Pt[]) => {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % pts.length]
      edges.push([a, b])
    }
  }
  add(p.pts)
  if (p.holes) for (const h of p.holes) if (h.length >= 3) add(h)
  return edges
}

/** 点到填充多边形最近边界点（点在内部则返回自身，表示距离 0） */
function closestPolyBoundary(p: Extract<SpShape, { t: 'p' }>, px: number, py: number): Pt {
  if (pointInShape(p, px, py)) return [px, py]
  let best: Pt = [px, py]
  let bestD = Infinity
  for (const [a, b] of polyEdges(p)) {
    const q = pointSegClosest(px, py, a[0], a[1], b[0], b[1])
    const d = Math.hypot(q[0] - px, q[1] - py)
    if (d < bestD) {
      bestD = d
      best = q
    }
  }
  return best
}

// ---------- 两形状最近点对 ----------

/**
 * 返回两个填充形状之间最近点对（若重叠/相切则两点重合，距离为 0）。
 * 语义：返回的 [pA, pB] 是两形状表面上的点，|pA-pB| 即最小间距。
 */
function closestPoints(a: SpShape, b: SpShape): [Pt, Pt] {
  // 统一把 circle 放在前面，减少分支
  if (a.t === 'c' && b.t === 'c') return circleCircle(a, b)
  if (a.t === 'c' && b.t === 's') return circleCapsule(a, b)
  if (a.t === 'c' && b.t === 'p') return circlePoly(a, b)
  if (a.t === 's' && b.t === 'c') {
    const [q, p] = circleCapsule(b, a)
    return [p, q]
  }
  if (a.t === 's' && b.t === 's') return capsuleCapsule(a, b)
  if (a.t === 's' && b.t === 'p') return capsulePoly(a, b)
  if (a.t === 'p' && b.t === 'c') {
    const [q, p] = circlePoly(b, a)
    return [p, q]
  }
  if (a.t === 'p' && b.t === 's') {
    const [q, p] = capsulePoly(b, a)
    return [p, q]
  }
  return polyPoly(a as Extract<SpShape, { t: 'p' }>, b as Extract<SpShape, { t: 'p' }>)
}

function circleCircle(
  a: Extract<SpShape, { t: 'c' }>,
  b: Extract<SpShape, { t: 'c' }>,
): [Pt, Pt] {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const d = Math.hypot(dx, dy)
  if (d <= a.r + b.r) return [[a.x, a.y], [a.x, a.y]] // 重叠 → 距离 0
  const ux = dx / d
  const uy = dy / d
  return [
    [a.x + ux * a.r, a.y + uy * a.r],
    [b.x - ux * b.r, b.y - uy * b.r],
  ]
}

function circleCapsule(
  c: Extract<SpShape, { t: 'c' }>,
  s: Extract<SpShape, { t: 's' }>,
): [Pt, Pt] {
  const t = pointSegClosest(c.x, c.y, s.x0, s.y0, s.x1, s.y1)
  const dx = t[0] - c.x
  const dy = t[1] - c.y
  const d = Math.hypot(dx, dy)
  if (d <= c.r + s.r) return [t, t] // 重叠 → 距离 0
  const ux = dx / d
  const uy = dy / d
  return [
    [c.x + ux * c.r, c.y + uy * c.r],
    [t[0] - ux * s.r, t[1] - uy * s.r],
  ]
}

function circlePoly(
  c: Extract<SpShape, { t: 'c' }>,
  p: Extract<SpShape, { t: 'p' }>,
): [Pt, Pt] {
  if (pointInShape(p, c.x, c.y)) return [[c.x, c.y], [c.x, c.y]]
  const q = closestPolyBoundary(p, c.x, c.y)
  const dx = q[0] - c.x
  const dy = q[1] - c.y
  const d = Math.hypot(dx, dy)
  if (d <= c.r) return [[c.x, c.y], q]
  const ux = dx / d
  const uy = dy / d
  return [
    [c.x + ux * c.r, c.y + uy * c.r],
    q,
  ]
}

function capsuleCapsule(
  a: Extract<SpShape, { t: 's' }>,
  b: Extract<SpShape, { t: 's' }>,
): [Pt, Pt] {
  const [p, q] = segSegClosestPoints([a.x0, a.y0], [a.x1, a.y1], [b.x0, b.y0], [b.x1, b.y1])
  const dx = q[0] - p[0]
  const dy = q[1] - p[1]
  const d = Math.hypot(dx, dy)
  if (d <= a.r + b.r) return [p, p] // 重叠 → 距离 0
  const ux = dx / d
  const uy = dy / d
  return [
    [p[0] + ux * a.r, p[1] + uy * a.r],
    [q[0] - ux * b.r, q[1] - uy * b.r],
  ]
}

function capsulePoly(
  s: Extract<SpShape, { t: 's' }>,
  p: Extract<SpShape, { t: 'p' }>,
): [Pt, Pt] {
  // 中心线端点落在多边形内部 → 重叠
  if (pointInShape(p, s.x0, s.y0)) return [[s.x0, s.y0], [s.x0, s.y0]]
  if (pointInShape(p, s.x1, s.y1)) return [[s.x1, s.y1], [s.x1, s.y1]]
  // 中心线与多边形各边最近点（若相交/相切则距离为 0，覆盖穿过情形）
  let bestP: Pt = [s.x0, s.y0]
  let bestQ: Pt = [s.x0, s.y0]
  let bestD = Infinity
  for (const [e0, e1] of polyEdges(p)) {
    const [pp, qq] = segSegClosestPoints([s.x0, s.y0], [s.x1, s.y1], e0, e1)
    const d = Math.hypot(qq[0] - pp[0], qq[1] - pp[1])
    if (d < bestD) {
      bestD = d
      bestP = pp
      bestQ = qq
    }
  }
  if (bestD <= s.r) return [bestQ, bestQ] // 相交/相切 → 距离 0
  const ux = (bestQ[0] - bestP[0]) / bestD
  const uy = (bestQ[1] - bestP[1]) / bestD
  return [
    [bestP[0] + ux * s.r, bestP[1] + uy * s.r],
    bestQ,
  ]
}

function polyPoly(
  a: Extract<SpShape, { t: 'p' }>,
  b: Extract<SpShape, { t: 'p' }>,
): [Pt, Pt] {
  // 重叠判定：任一顶点落入对方（覆盖“一个完全在另一个内部”情形）
  for (const v of a.pts) if (pointInShape(b, v[0], v[1])) return [v, v]
  for (const v of b.pts) if (pointInShape(a, v[0], v[1])) return [v, v]
  let bestP: Pt = a.pts[0]
  let bestQ: Pt = b.pts[0]
  let bestD = Infinity
  for (const [e0, e1] of polyEdges(a)) {
    for (const [f0, f1] of polyEdges(b)) {
      const [p, q] = segSegClosestPoints(e0, e1, f0, f1)
      const d = Math.hypot(q[0] - p[0], q[1] - p[1])
      if (d < bestD) {
        bestD = d
        bestP = p
        bestQ = q
      }
    }
  }
  return [bestP, bestQ]
}

// ---------- 主入口 ----------

export function minSpacing(
  shapesA: SpShape[],
  shapesB: SpShape[],
): { distance: number; pA: Pt; pB: Pt } | null {
  if (shapesA.length === 0 || shapesB.length === 0) return null
  const bA = shapesA.map(bboxOf)
  const bB = shapesB.map(bboxOf)
  const orderB = bB.map((_, i) => i).sort((i, j) => bB[i].minX - bB[j].minX)

  let best = Infinity
  let bestP: Pt = [0, 0]
  let bestQ: Pt = [0, 0]

  for (let ia = 0; ia < shapesA.length; ia++) {
    const A = bA[ia]
    for (let jb = 0; jb < orderB.length; jb++) {
      const ib = orderB[jb]
      const B = bB[ib]
      if (B.minX - A.maxX > best) break // B 按 minX 升序，右侧更远
      if (A.minX - B.maxX > best) continue // B 整体在左侧过远，继续
      if (B.minY - A.maxY > best || A.minY - B.maxY > best) continue
      const [p, q] = closestPoints(shapesA[ia], shapesB[ib])
      const d = Math.hypot(p[0] - q[0], p[1] - q[1])
      if (d < best) {
        best = d
        bestP = p
        bestQ = q
      }
    }
  }

  if (!isFinite(best)) return null
  return { distance: best, pA: bestP, pB: bestQ }
}
