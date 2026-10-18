// ODB++ 输入支持：解析 ODB++ 目录树（来自 zip 或文件夹拖入），
// 将各层渲染为与 Gerber 管线兼容的 three.js 纹理，并复用几何连通性算法重建网络。
//
// 单位约定（本样例）：坐标以“英寸”存储，符号(孔径)尺寸以“mils(千分之一英寸)”存储。
// 解析时统一换算为 mm：坐标 ×25.4，符号尺寸 ×0.0254，从而可直接复用 nets.ts 的
// TOL=0.1mm / CELL=2mm 连通性参数。

import * as THREE from 'three'
import { layerColor, type LayerKind, type LayerMeta } from './layers'
import type { Net } from './nets'
import type { GlobalBox, ViewBox } from './geometry'

const INCH_TO_MM = 25.4
const MIL_TO_MM = 0.0254

// ODB++ 网表（netlist）常为 GBK 编码，浏览器默认按 UTF-8 读取会产生乱码。
// 这里先按 UTF-8 严格解码；若字节序列非法（即并非 UTF-8，很可能是 GBK），
// 再改用 GBK 解码。清单/features 等纯 ASCII 文件不受影响。
const utf8Strict = new TextDecoder('utf-8', { fatal: true })
const utf8Loose = new TextDecoder('utf-8')
const gbkdec = (() => {
  try {
    return new TextDecoder('gbk')
  } catch {
    return null
  }
})()
function decodeText(bytes: Uint8Array): string {
  try {
    return utf8Strict.decode(bytes)
  } catch {
    if (gbkdec) return gbkdec.decode(bytes)
    return utf8Loose.decode(bytes)
  }
}

// ---------- 类型 ----------
export type OdbSymKind = 'rect' | 'round' | 'oval' | 'oct' | 'donut' | 'square' | 'unknown'
export interface OdbSymbol {
  kind: OdbSymKind
  w: number // mm
  h: number // mm
  r?: number // 圆角半径 mm（rect）
  d?: number // 直径 mm（round/donut）
  inner?: number // 内径 mm（donut）
}

export type OdbFeatKind = 'pad' | 'line' | 'arc' | 'surface'
export interface OdbFeature {
  kind: OdbFeatKind
  symbol: number
  polarity: 'P' | 'N'
  x?: number
  y?: number
  x1?: number
  y1?: number
  x2?: number
  y2?: number
  cx?: number
  cy?: number
  poly?: number[][] // 外轮廓点 [x,y] mm
  holes?: number[][][] // 内孔轮廓
}

export interface OdbLayer {
  name: string
  type: string
  row: number
  polarity: 'POSITIVE' | 'NEGATIVE'
  meta: LayerMeta
  symbols: Record<number, OdbSymbol>
  features: OdbFeature[]
  vb: ViewBox
  /** ODB++ 数据中 #Layer_Color 定义的颜色（#RRGGBB）；未定义时为 undefined */
  color?: string
  /** 铜层重建出的网络（含真实网名）；非铜层为空 */
  nets?: Net[]
}

export interface OdbDesign {
  layers: OdbLayer[]
  profile?: ViewBox
  netNames: string[]
}

export interface FileEntry {
  path: string
  bytes: () => Promise<Uint8Array>
}

// ---------- 符号解析 ----------
function parseSymbol(def: string): OdbSymbol {
  const s = def.trim()
  // rectWxHxrR / rectWxH
  let m = s.match(/^rect([\d.]+)x([\d.]+)(?:xr([\d.]+))?$/i)
  if (m) {
    return { kind: 'rect', w: parseFloat(m[1]) * MIL_TO_MM, h: parseFloat(m[2]) * MIL_TO_MM, r: m[3] ? parseFloat(m[3]) * MIL_TO_MM : 0 }
  }
  // squareWxH / squareW
  m = s.match(/^square([\d.]+)(?:x([\d.]+))?$/i)
  if (m) {
    const w = parseFloat(m[1]) * MIL_TO_MM
    return { kind: 'square', w, h: m[2] ? parseFloat(m[2]) * MIL_TO_MM : w }
  }
  // ovalWxH
  m = s.match(/^oval([\d.]+)x([\d.]+)$/i)
  if (m) return { kind: 'oval', w: parseFloat(m[1]) * MIL_TO_MM, h: parseFloat(m[2]) * MIL_TO_MM }
  // octWxHxS
  m = s.match(/^oct([\d.]+)x([\d.]+)(?:x([\d.]+))?$/i)
  if (m) return { kind: 'oct', w: parseFloat(m[1]) * MIL_TO_MM, h: parseFloat(m[2]) * MIL_TO_MM }
  // donutDxDi / donutD
  m = s.match(/^donut([\d.]+)(?:x([\d.]+))?$/i)
  if (m) {
    const d = parseFloat(m[1]) * MIL_TO_MM
    return { kind: 'donut', w: d, h: d, d, inner: m[2] ? parseFloat(m[2]) * MIL_TO_MM : d * 0.5 }
  }
  // rD （圆，直径）
  m = s.match(/^r([\d.]+)$/i)
  if (m) {
    const d = parseFloat(m[1]) * MIL_TO_MM
    return { kind: 'round', w: d, h: d, d }
  }
  // 退化：尝试提取首个数字作为圆直径
  const num = s.match(/[\d.]+/)
  const d = num ? parseFloat(num[0]) * MIL_TO_MM : 1
  return { kind: 'unknown', w: d, h: d, d }
}

// ---------- features 文件解析 ----------
interface ParsedFeatures {
  symbols: Record<number, OdbSymbol>
  features: OdbFeature[]
  vb: ViewBox
  /** 由 #Layer_Color 解析出的图层颜色（#RRGGBB）；数据未定义时为 undefined */
  color?: string
}

/**
 * 解析 ODB++ 的 `#Layer_Color=<十进制>` 属性为 #RRGGBB。
 *
 * ODB++ 以十进制整数存放颜色，字节序为 0xBBGGRR（非通常的 RRGGBB）。
 * 佐证：本类数据中 TOP 层为 255（0x0000FF）→ 蓝色分量 0、红色分量 255 = 红；
 * BOTTOM 层为 16711680（0xFF0000）→ 红分量 0、蓝分量 255 = 蓝，
 * 与 PCB 行业“顶层红、底层蓝”的惯例一致，故按 BBGGRR 解读。
 */
function parseLayerColor(raw: string): string | undefined {
  const n = parseInt(raw.trim(), 10)
  if (!Number.isFinite(n) || n < 0 || n > 0xffffff) return undefined
  const r = n & 0xff
  const g = (n >> 8) & 0xff
  const b = (n >> 16) & 0xff
  const hex = (v: number) => v.toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

function parseFeatures(text: string): ParsedFeatures {
  const symbols: Record<number, OdbSymbol> = {}
  const features: OdbFeature[] = []
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let color: string | undefined

  const touch = (x: number, y: number, r = 0) => {
    minX = Math.min(minX, x - r)
    minY = Math.min(minY, y - r)
    maxX = Math.max(maxX, x + r)
    maxY = Math.max(maxY, y + r)
  }

  const lines = text.split(/\r?\n/)
  let i = 0
  const n = lines.length
  while (i < n) {
    let line = lines[i]
    // 去掉行内注释
    const semi = line.indexOf(';')
    if (semi >= 0) line = line.slice(0, semi)
    line = line.trim()
    if (!line) {
      i++
      continue
    }
    // 符号定义 $N def
    let m = line.match(/^\$(\d+)\s+(.+)$/)
    if (m) {
      symbols[parseInt(m[1], 10)] = parseSymbol(m[2])
      i++
      continue
    }
    // 其它定义（@ & #）跳过；# 行中若含 Layer_Color 则记录该层颜色
    if (line[0] === '@' || line[0] === '&' || line[0] === '#') {
      if (line[0] === '#' && color === undefined) {
        const mc = line.match(/Layer_Color\s*=\s*(\d+)/i)
        if (mc) color = parseLayerColor(mc[1])
      }
      i++
      continue
    }
    const parts = line.split(/\s+/)
    const code = parts[0]
    if (code === 'P' && parts.length >= 5) {
      const x = parseFloat(parts[1]) * INCH_TO_MM
      const y = parseFloat(parts[2]) * INCH_TO_MM
      const sym = parseInt(parts[3], 10)
      const pol = parts[4] === 'N' ? 'N' : 'P'
      features.push({ kind: 'pad', symbol: sym, polarity: pol, x, y })
      const sy = symbols[sym]
      const r = (sy?.d ?? sy?.w ?? 1) / 2
      touch(x, y, r)
      i++
      continue
    }
    if (code === 'L' && parts.length >= 7) {
      const x1 = parseFloat(parts[1]) * INCH_TO_MM
      const y1 = parseFloat(parts[2]) * INCH_TO_MM
      const x2 = parseFloat(parts[3]) * INCH_TO_MM
      const y2 = parseFloat(parts[4]) * INCH_TO_MM
      const sym = parseInt(parts[5], 10)
      const pol = parts[6] === 'N' ? 'N' : 'P'
      features.push({ kind: 'line', symbol: sym, polarity: pol, x1, y1, x2, y2 })
      const sy = symbols[sym]
      const r = (sy?.d ?? Math.min(sy?.w ?? 1, sy?.h ?? 1)) / 2
      touch(x1, y1, r)
      touch(x2, y2, r)
      i++
      continue
    }
    if (code === 'A' && parts.length >= 9) {
      const x1 = parseFloat(parts[1]) * INCH_TO_MM
      const y1 = parseFloat(parts[2]) * INCH_TO_MM
      const x2 = parseFloat(parts[3]) * INCH_TO_MM
      const y2 = parseFloat(parts[4]) * INCH_TO_MM
      const cx = parseFloat(parts[5]) * INCH_TO_MM
      const cy = parseFloat(parts[6]) * INCH_TO_MM
      const sym = parseInt(parts[7], 10)
      const pol = parts[8] === 'N' ? 'N' : 'P'
      features.push({ kind: 'arc', symbol: sym, polarity: pol, x1, y1, x2, y2, cx, cy })
      const sy = symbols[sym]
      const r = (sy?.d ?? Math.min(sy?.w ?? 1, sy?.h ?? 1)) / 2
      touch(x1, y1, r)
      touch(x2, y2, r)
      touch(cx, cy, r)
      i++
      continue
    }
    if (code === 'S') {
      // 表面（填充多边形）：S polarity [window] 随后逐条轮廓，每条以 OB 起始、OS 续点、OE 结束；
      // 同一条 S 内第一个 OB 为外轮廓，后续 OB（铜箔灌铜中的焊盘/过孔隔离环等）为内孔。
      // 每条轮廓都是独立多边形，渲染时以 evenodd 规则填充（外填内空）。
      const pol = parts[1] === 'N' ? 'N' : 'P'
      const contours: number[][][] = []
      let cur: number[][] | null = null
      i++
      while (i < n) {
        let l2 = lines[i]
        const semi2 = l2.indexOf(';')
        if (semi2 >= 0) l2 = l2.slice(0, semi2)
        l2 = l2.trim()
        if (!l2) {
          i++
          continue
        }
        if (l2.startsWith('OB') || l2.startsWith('OH')) {
          // 开始一条新轮廓（外轮廓或内孔）；OH 也为部分导出器的孔内轮廓起点
          const pp = l2.split(/\s+/)
          const x = parseFloat(pp[1]) * INCH_TO_MM
          const y = parseFloat(pp[2]) * INCH_TO_MM
          const c: number[][] = [[x, y]]
          contours.push(c)
          cur = c
          i++
          continue
        }
        if (l2.startsWith('OS')) {
          const pp = l2.split(/\s+/)
          const x = parseFloat(pp[1]) * INCH_TO_MM
          const y = parseFloat(pp[2]) * INCH_TO_MM
          if (cur) cur.push([x, y])
          i++
          continue
        }
        if (l2.startsWith('OE')) {
          cur = null
          i++
          continue
        }
        if (l2.startsWith('SE')) {
          i++
          break
        }
        i++
      }
      if (contours.length > 0 && contours[0].length >= 3) {
        const f: OdbFeature = { kind: 'surface', symbol: 0, polarity: pol, poly: contours[0] }
        if (contours.length > 1) f.holes = contours.slice(1)
        features.push(f)
        for (const c of contours) for (const p of c) touch(p[0], p[1])
      }
      continue
    }
    // 其余（TO 文本对象等）跳过
    i++
  }

  if (!isFinite(minX)) return { symbols, features, vb: { minX: 0, minY: 0, w: 1, h: 1 }, color }
  return { symbols, features, vb: { minX, minY, w: maxX - minX, h: maxY - minY }, color }
}

// ---------- matrix 解析 ----------
interface MatrixLayer {
  row: number
  type: string
  name: string
  polarity: 'POSITIVE' | 'NEGATIVE'
}
function parseMatrix(text: string): MatrixLayer[] {
  const out: MatrixLayer[] = []
  const blocks = text.split(/\}\s*LAYER\s*\{/i)
  // 第一个块是 STEP，跳过；其余每个是 LAYER
  for (let b = 1; b < blocks.length; b++) {
    const body = blocks[b]
    const get = (k: string) => {
      const m = body.match(new RegExp(k + '\\s*=\\s*([^\\n]+)', 'i'))
      return m ? m[1].trim() : ''
    }
    const row = parseInt(get('ROW'), 10)
    const type = get('TYPE')
    const name = get('NAME')
    const pol = get('POLARITY') === 'NEGATIVE' ? 'NEGATIVE' : 'POSITIVE'
    if (name) out.push({ row, type, name, polarity: pol })
  }
  return out
}

// ---------- netlist 解析 ----------
interface Netlist {
  netNames: string[]
  seeds: { netref: number; x: number; y: number }[]
}
function parseNetlist(text: string): Netlist {
  const netNames: string[] = []
  const seeds: { netref: number; x: number; y: number }[] = []
  const lines = text.split(/\r?\n/)
  let inPoints = false
  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith('#')) {
      if (/netlist points/i.test(line)) inPoints = true
      continue
    }
    if (/^\$\d+/.test(line)) {
      const idx = parseInt(line.slice(1).trim(), 10)
      const name = line.replace(/^\$\d+\s+/, '').trim()
      netNames[idx] = name
      continue
    }
    if (inPoints) {
      const p = line.split(/\s+/)
      if (p.length < 4) continue
      const netref = parseInt(p[0], 10)
      const x = parseFloat(p[2]) * INCH_TO_MM
      const y = parseFloat(p[3]) * INCH_TO_MM
      if (!isFinite(x) || !isFinite(y)) continue
      seeds.push({ netref, x, y })
    }
  }
  return { netNames, seeds }
}

// ---------- profile 解析（板框轮廓） ----------
function parseProfile(text: string): ViewBox | undefined {
  const pts: number[][] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('OS') || line.startsWith('OB')) {
      const p = line.split(/\s+/)
      if (p.length >= 3) pts.push([parseFloat(p[1]) * INCH_TO_MM, parseFloat(p[2]) * INCH_TO_MM])
    }
  }
  if (pts.length < 3) return undefined
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of pts) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  return { minX, minY, w: maxX - minX, h: maxY - minY }
}

// ---------- 图层类型 → LayerMeta ----------
function odbMeta(type: string, name: string, row: number, polarity: string): LayerMeta {
  const lower = name.toLowerCase()
  const isBot = /bot|comp_\+_bot|overlay_bot/i.test(lower)
  const make = (kind: LayerKind, label: string, order: number, renderable = true): LayerMeta => ({
    kind,
    name: label,
    color: layerColor(kind),
    order,
    renderable,
  })
  void polarity
  switch (type.toUpperCase()) {
    case 'SIGNAL':
      if (/top/.test(lower)) return make('topCopper', '顶层铜箔 (Top Copper)', 100)
      if (/bot/.test(lower)) return make('bottomCopper', '底层铜箔 (Bottom Copper)', 30)
      return make('innerCopper', `内层铜箔 ${name}`, 40 + (row % 20))
    case 'POWER_GROUND':
    case 'PLANE':
      // 电源/地平面层（通常为负片）：作为内层铜箔参与印制板图导出
      return make('innerCopper', `内层铜箔 ${name}`, 40 + (row % 20))
    case 'SOLDER_MASK':
      return make(isBot ? 'bottomSolderMask' : 'topSolderMask', isBot ? '底层阻焊 (Bottom Solder Mask)' : '顶层阻焊 (Top Solder Mask)', isBot ? 20 : 110)
    case 'SOLDER_PASTE':
      return make(isBot ? 'bottomPaste' : 'topPaste', isBot ? '底层钢网 (Bottom Paste)' : '顶层钢网 (Top Paste)', isBot ? 25 : 130)
    case 'SILK_SCREEN':
      return make(isBot ? 'bottomSilkscreen' : 'topSilkscreen', isBot ? '底层丝印 (Bottom Silkscreen)' : '顶层丝印 (Top Silkscreen)', isBot ? 10 : 120)
    case 'COMPONENT':
      return make('component', `元件层 ${name}`, 135)
    case 'DRILL':
      return make('drill', '钻孔 (Drill)', -1, false)
    case 'DOCUMENT':
      // 机械/尺寸/标注等文档层不展开渲染（与 Gerber 的 outline 处理一致）；
      // 仅 Keep-out 作为可高亮层保留。
      if (/keepout/i.test(lower)) return make('keepout', '禁止布线层 (Keep-out)', 60)
      return make('mechanical', `机械层 ${name}`, 140, false)
    default:
      return make('unknown', name, 150)
  }
}

// ---------- 铜箔(填充区)几何辅助 ----------
// 射线法判断点是否在多边形内(偶奇规则，可处理带孔轮廓)。
function pointInPoly(poly: number[][], x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0]
    const yi = poly[i][1]
    const xj = poly[j][0]
    const yj = poly[j][1]
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

// 点是否落在铜箔(surface)内部：在外部轮廓内、且不在任何内孔(隔离环/反焊盘)内。
function pointInSurface(f: OdbFeature, x: number, y: number): boolean {
  if (!f.poly || f.poly.length < 3) return false
  if (!pointInPoly(f.poly, x, y)) return false
  if (f.holes) for (const h of f.holes) if (h.length >= 3 && pointInPoly(h, x, y)) return false
  return true
}

// ---------- 网络重建：种子点直接绑定（不做邻近连通，避免跨安全间距误连） ----------
// ODB++ netlist 的 points 段为每个焊盘/过孔给出 (netref, 直径, x, y) 种子点，
// 即“某位置的焊盘属于某网络”的权威信息。据此：
//   1) 焊盘(pad)      —— 种子点中心匹配，直接绑定网名；
//   2) 铜箔(surface)  —— 由落在其内部(不含内孔)的焊盘/种子点众数确定网名；
//   3) 走线(line/arc) —— 按“端点精确重合”连通到焊盘/走线/铜箔后传播网名。
// 完全不再用边界采样 + 容差的邻近连通（那会把仅隔正常安全间距的不同网络铜箔误连）。
function computeOdbNets(layer: OdbLayer, netlist: Netlist): Net[] {
  const feats = layer.features
  const n = feats.length
  if (n === 0) return []
  const netNames = netlist.netNames
  const seeds = netlist.seeds.filter((s) => s.netref > 0)
  const featNet = new Int32Array(n).fill(-1) // 图元索引 -> netref（-1 未绑定）

  const isTrace = (f: OdbFeature) => f.kind === 'line' || f.kind === 'arc'
  const traceEnds = (f: OdbFeature): [number, number][] => {
    if (f.kind === 'line' && f.x1 != null) return [[f.x1, f.y1!], [f.x2!, f.y2!]]
    if (f.kind === 'arc' && f.x1 != null) return [[f.x1, f.y1!], [f.x2!, f.y2!]]
    return []
  }
  // 走线中心线采样点（用于判断走线是否“穿过”铜箔内部，从而与铜箔同网）
  const traceSamples = (f: OdbFeature): [number, number][] => {
    if (f.kind === 'line' && f.x1 != null) {
      const x0 = f.x1
      const y0 = f.y1!
      const x1 = f.x2!
      const y1 = f.y2!
      const len = Math.hypot(x1 - x0, y1 - y0)
      const steps = Math.max(1, Math.min(48, Math.ceil(len / 1.5)))
      const pts: [number, number][] = []
      for (let s = 0; s <= steps; s++) {
        const t = s / steps
        pts.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t])
      }
      return pts
    }
    if (f.kind === 'arc' && f.x1 != null && f.cx != null) {
      const r = Math.hypot(f.x1 - f.cx, f.y1! - f.cy!)
      const a1 = Math.atan2(f.y1! - f.cy!, f.x1 - f.cx!)
      const a2 = Math.atan2(f.y2! - f.cy!, f.x2! - f.cx!)
      let da = a2 - a1
      while (da > Math.PI) da -= 2 * Math.PI
      while (da < -Math.PI) da += 2 * Math.PI
      const steps = 24
      const pts: [number, number][] = []
      for (let s = 0; s <= steps; s++) {
        const a = a1 + (da * s) / steps
        pts.push([f.cx + Math.cos(a) * r, f.cy! + Math.sin(a) * r])
      }
      return pts
    }
    return []
  }

  // ---- 1) 焊盘：种子点中心匹配直接绑定网名 ----
  const SC = 1 // mm，种子网格粒度
  const seedGrid = new Map<string, number[]>()
  seeds.forEach((s, i) => {
    const k = `${Math.floor(s.x / SC)},${Math.floor(s.y / SC)}`
    if (!seedGrid.has(k)) seedGrid.set(k, [])
    seedGrid.get(k)!.push(i)
  })
  const findSeedNet = (x: number, y: number, tol: number): number => {
    let best = -1
    let bestD = tol
    const cx = Math.floor(x / SC)
    const cy = Math.floor(y / SC)
    for (let gx = -1; gx <= 1; gx++)
      for (let gy = -1; gy <= 1; gy++) {
        const bucket = seedGrid.get(`${cx + gx},${cy + gy}`)
        if (!bucket) continue
        for (const si of bucket) {
          const s = seeds[si]
          const d = Math.hypot(s.x - x, s.y - y)
          if (d < bestD) {
            bestD = d
            best = s.netref
          }
        }
      }
    return best
  }
  for (let i = 0; i < n; i++) {
    const f = feats[i]
    if (f.kind === 'pad' && f.x != null) {
      const nr = findSeedNet(f.x, f.y!, 0.15)
      if (nr > 0) featNet[i] = nr
    }
  }

  // 各图元包围盒（铜箔=多边形 bbox，走线=端点 bbox，焊盘=点）
  const featBox = feats.map((f) => {
    if (f.kind === 'surface' && f.poly) {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const [px, py] of f.poly) {
        minX = Math.min(minX, px)
        minY = Math.min(minY, py)
        maxX = Math.max(maxX, px)
        maxY = Math.max(maxY, py)
      }
      return { minX, minY, maxX, maxY }
    }
    if (f.kind === 'pad' && f.x != null) return { minX: f.x, minY: f.y!, maxX: f.x, maxY: f.y! }
    const ends = traceEnds(f)
    if (ends.length) {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const [x, y] of ends) {
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
      const m = 0.5 // 线宽余量
      return { minX: minX - m, minY: minY - m, maxX: maxX + m, maxY: maxY + m }
    }
    return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  })

  // ---- 2) 连通图（并查集） ----
  const PC = 0.5 // mm，端点网格粒度
  const pointGrid = new Map<string, number[]>()
  const addPoint = (x: number, y: number, fi: number) => {
    const k = `${Math.round(x / PC)},${Math.round(y / PC)}`
    if (!pointGrid.has(k)) pointGrid.set(k, [])
    pointGrid.get(k)!.push(fi)
  }
  for (let i = 0; i < n; i++) {
    const f = feats[i]
    if (f.kind === 'pad' && f.x != null) addPoint(f.x, f.y!, i)
    else if (isTrace(f)) for (const [x, y] of traceEnds(f)) addPoint(x, y, i)
  }

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

  const END_TOL = 0.1 // mm，端点重合容差
  // 2a) 走线端点 ↔ 焊盘/走线（精确重合）
  for (let i = 0; i < n; i++) {
    const f = feats[i]
    if (!isTrace(f)) continue
    for (const [x, y] of traceEnds(f)) {
      const cx = Math.round(x / PC)
      const cy = Math.round(y / PC)
      for (let gx = -1; gx <= 1; gx++)
        for (let gy = -1; gy <= 1; gy++) {
          const bucket = pointGrid.get(`${cx + gx},${cy + gy}`)
          if (!bucket) continue
          for (const j of bucket) {
            if (j === i) continue
            const g = feats[j]
            if (g.kind === 'pad' && g.x != null) {
              if (Math.hypot(g.x - x, g.y! - y) <= END_TOL) union(i, j)
            } else if (isTrace(g)) {
              for (const [ex, ey] of traceEnds(g)) if (Math.hypot(ex - x, ey - y) <= END_TOL) {
                union(i, j)
                break
              }
            }
          }
        }
    }
  }
  // 2b) 图元落在铜箔内部 → 与该铜箔同网（焊盘中心 / 走线中心线采样点）
  for (let i = 0; i < n; i++) {
    const sf = feats[i]
    if (sf.kind !== 'surface') continue
    const box = featBox[i]
    for (let j = 0; j < n; j++) {
      if (j === i) continue
      const g = feats[j]
      const gb = featBox[j]
      if (gb.maxX < box.minX || gb.minX > box.maxX || gb.maxY < box.minY || gb.minY > box.maxY) continue
      let joined = false
      if (g.kind === 'pad' && g.x != null) {
        if (pointInSurface(sf, g.x, g.y!)) joined = true
      } else if (isTrace(g)) {
        for (const [x, y] of traceSamples(g)) {
          if (x < box.minX || x > box.maxX || y < box.minY || y > box.maxY) continue
          if (pointInSurface(sf, x, y)) {
            joined = true
            break
          }
        }
      }
      if (joined) union(i, j)
    }
  }

  // ---- 传播：每个连通分量取其成员已知网名的众数，赋给全体成员 ----
  const compCounts = new Map<number, Map<number, number>>() // root -> netref -> 计数
  for (let i = 0; i < n; i++) {
    const nr = featNet[i]
    if (nr <= 0) continue
    const r = find(i)
    if (!compCounts.has(r)) compCounts.set(r, new Map())
    const m = compCounts.get(r)!
    m.set(nr, (m.get(nr) || 0) + 1)
  }
  const compFinal = new Map<number, number>() // root -> 选定 netref
  for (const [r, m] of compCounts) {
    let bestNr = -1
    let bestC = -1
    for (const [nr, c] of m) if (c > bestC) {
      bestC = c
      bestNr = nr
    }
    compFinal.set(r, bestNr)
  }
  for (let i = 0; i < n; i++) {
    if (featNet[i] > 0) continue
    const nr = compFinal.get(find(i))
    if (nr != null && nr > 0) featNet[i] = nr
  }

  // ---- 组装 Net[]：已绑定网名 → 显式网络；未绑定 → 按连通分量合成网络 ----
  const byNet = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const nr = featNet[i]
    if (nr <= 0) continue
    if (!byNet.has(nr)) byNet.set(nr, [])
    byNet.get(nr)!.push(i)
  }
  const nets: Net[] = []
  let id = 0
  for (const [nr, idxs] of byNet) {
    nets.push({ id: id++, name: netNames[nr] || `Net ${nr}`, primitiveIdxs: idxs, explicit: true })
  }
  const unassignedByRoot = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    if (featNet[i] > 0) continue
    const r = find(i)
    if (!unassignedByRoot.has(r)) unassignedByRoot.set(r, [])
    unassignedByRoot.get(r)!.push(i)
  }
  let synth = 1
  for (const [, idxs] of unassignedByRoot) {
    nets.push({ id: id++, name: `Net ${synth++}`, primitiveIdxs: idxs, explicit: false })
  }
  nets.sort((a, b) => b.primitiveIdxs.length - a.primitiveIdxs.length)
  return nets
}

// ---------- 顶层解析 ----------
export async function parseOdb(entries: FileEntry[]): Promise<OdbDesign> {
  const map = new Map<string, FileEntry>()
  for (const e of entries) {
    map.set(e.path.replace(/\\/g, '/').toLowerCase(), e)
  }
  const find = (suffix: string): FileEntry | undefined => {
    for (const [k, v] of map) if (k.endsWith(suffix.toLowerCase())) return v
    return undefined
  }
  const findFirst = (re: RegExp): FileEntry | undefined => {
    for (const [k, v] of map) if (re.test(k)) return v
    return undefined
  }

  const matrixEntry = find('matrix/matrix')
  if (!matrixEntry) throw new Error('未找到 ODB++ matrix/matrix，可能不是 ODB++ 文件')

  const stepMatch = findFirst(/\/steps\/([^/]+)\/layers\//)
  const step = stepMatch ? stepMatch.path.replace(/\\/g, '/').match(/\/steps\/([^/]+)\/layers\//)![1] : 'pcb'

  const layerFeatures = (name: string): FileEntry | undefined => {
    const re = new RegExp(`/${step}/layers/${name.toLowerCase()}/features$`)
    return findFirst(re)
  }
  const netlistEntry = findFirst(/\/netlists\/[^/]+\/netlist$/)
  const profileEntry = find(`${step}/profile`)

  const matrix = parseMatrix(decodeText(await matrixEntry.bytes()))
  const netlist = netlistEntry ? parseNetlist(decodeText(await netlistEntry.bytes())) : { netNames: [], seeds: [] }
  const profile = profileEntry ? parseProfile(decodeText(await profileEntry.bytes())) : undefined

  const layers: OdbLayer[] = []
  for (const ml of matrix) {
    const fe = layerFeatures(ml.name)
    if (!fe) continue
    const parsed = parseFeatures(decodeText(await fe.bytes()))
    const meta = odbMeta(ml.type, ml.name, ml.row, ml.polarity)
    // 注意：meta.color 保持内置预设色（供 3D 爆炸图与图层色块使用）；
    // ODB++ 数据中定义的颜色单独存放在 layer.color，仅在导出图纸 PDF 时使用。
    const layer: OdbLayer = {
      name: ml.name,
      type: ml.type,
      row: ml.row,
      polarity: ml.polarity,
      meta,
      symbols: parsed.symbols,
      features: parsed.features,
      vb: parsed.vb,
      color: parsed.color,
    }
    // 铜层重建网络（种子点直接绑定网名）
    if (meta.kind === 'topCopper' || meta.kind === 'bottomCopper' || meta.kind === 'innerCopper') {
      layer.nets = computeOdbNets(layer, netlist)
    }
    layers.push(layer)
  }

  return { layers, profile, netNames: netlist.netNames }
}

// ---------- Canvas 渲染（与 gerber.ts renderLayerTexture 对齐） ----------
function drawSymbolPath(ctx: CanvasRenderingContext2D, sym: OdbSymbol, x: number, y: number) {
  ctx.beginPath()
  switch (sym.kind) {
    case 'round':
    case 'unknown': {
      const r = (sym.d ?? sym.w) / 2
      ctx.arc(x, y, r, 0, Math.PI * 2)
      break
    }
    case 'square':
    case 'rect': {
      const w = sym.w
      const h = sym.h
      const r = Math.min(sym.r ?? 0, w / 2, h / 2)
      const x0 = x - w / 2
      const y0 = y - h / 2
      if (r <= 0) {
        ctx.rect(x0, y0, w, h)
      } else {
        ctx.moveTo(x0 + r, y0)
        ctx.arcTo(x0 + w, y0, x0 + w, y0 + h, r)
        ctx.arcTo(x0 + w, y0 + h, x0, y0 + h, r)
        ctx.arcTo(x0, y0 + h, x0, y0, r)
        ctx.arcTo(x0, y0, x0 + w, y0, r)
        ctx.closePath()
      }
      break
    }
    case 'oval': {
      ctx.ellipse(x, y, sym.w / 2, sym.h / 2, 0, 0, Math.PI * 2)
      break
    }
    case 'oct': {
      const w = sym.w / 2
      const h = sym.h / 2
      const cw = w * 0.7071
      const ch = h * 0.7071
      ctx.moveTo(-w + cw, -h)
      ctx.lineTo(w - cw, -h)
      ctx.lineTo(w, -h + ch)
      ctx.lineTo(w, h - ch)
      ctx.lineTo(w - cw, h)
      ctx.lineTo(-w + cw, h)
      ctx.lineTo(-w, h - ch)
      ctx.lineTo(-w, -h + ch)
      ctx.closePath()
      break
    }
    case 'donut': {
      const outer = (sym.d ?? sym.w) / 2
      const inner = (sym.inner ?? outer * 0.5) / 2
      ctx.arc(x, y, outer, 0, Math.PI * 2)
      ctx.arc(x, y, inner, 0, Math.PI * 2, true)
      break
    }
  }
}

function drawFeature(ctx: CanvasRenderingContext2D, f: OdbFeature, syms: Record<number, OdbSymbol>, color: string) {
  const neg = f.polarity === 'N'
  ctx.save()
  if (neg) ctx.globalCompositeOperation = 'destination-out'
  else {
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = color
    ctx.strokeStyle = color
  }

  if (f.kind === 'pad' && f.x != null && f.y != null) {
    const sym = syms[f.symbol]
    if (sym) {
      ctx.save()
      ctx.translate(f.x, f.y)
      drawSymbolPath(ctx, sym, 0, 0)
      ctx.restore()
      if (sym.kind === 'donut') ctx.fill('evenodd')
      else ctx.fill()
    }
  } else if (f.kind === 'line' && f.x1 != null) {
    const sym = syms[f.symbol]
    const w = sym?.d ?? Math.min(sym?.w ?? 1, sym?.h ?? 1)
    ctx.lineWidth = w
    ctx.lineCap = sym?.kind === 'round' || sym?.kind === 'oval' ? 'round' : 'butt'
    ctx.beginPath()
    ctx.moveTo(f.x1, f.y1!)
    ctx.lineTo(f.x2!, f.y2!)
    ctx.stroke()
  } else if (f.kind === 'arc' && f.x1 != null && f.cx != null) {
    const sym = syms[f.symbol]
    const w = sym?.d ?? Math.min(sym?.w ?? 1, sym?.h ?? 1)
    const r = Math.hypot(f.x1 - f.cx, f.y1! - f.cy!)
    if (r < 1e-6) {
      drawFeature(ctx, { kind: 'pad', symbol: f.symbol, polarity: f.polarity, x: f.x1, y: f.y1 }, syms, color)
    } else {
      const a1 = Math.atan2(f.y1! - f.cy!, f.x1 - f.cx!)
      const a2 = Math.atan2(f.y2! - f.cy!, f.x2! - f.cx!)
      let da = a2 - a1
      while (da > Math.PI) da -= 2 * Math.PI
      while (da < -Math.PI) da += 2 * Math.PI
      const steps = 32
      ctx.lineWidth = w
      ctx.lineCap = 'round'
      ctx.beginPath()
      for (let s = 0; s <= steps; s++) {
        const a = a1 + (da * s) / steps
        const px = f.cx + Math.cos(a) * r
        const py = f.cy! + Math.sin(a) * r
        if (s === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.stroke()
    }
  } else if (f.kind === 'surface' && f.poly && f.poly.length >= 3) {
    ctx.beginPath()
    ctx.moveTo(f.poly[0][0], f.poly[0][1])
    for (let k = 1; k < f.poly.length; k++) ctx.lineTo(f.poly[k][0], f.poly[k][1])
    ctx.closePath()
    if (f.holes) {
      for (const h of f.holes) {
        if (h.length < 3) continue
        ctx.moveTo(h[0][0], h[0][1])
        for (let k = 1; k < h.length; k++) ctx.lineTo(h[k][0], h[k][1])
        ctx.closePath()
      }
      ctx.fill('evenodd')
    } else ctx.fill()
  }
  ctx.restore()
}

/**
 * 将 ODB++ 图层渲染为 three.js 纹理。
 * 画布尺寸与坐标变换逻辑与 gerber.ts 的 renderLayerTexture 完全一致，
 * 因此与 Gerber 图层可在同一全局板框内精准对齐。
 * indices 指定时仅渲染这些图元（用于网络高亮叠加层）。
 */
export function renderOdbToTexture(
  layer: OdbLayer,
  g: GlobalBox,
  aspect: number,
  color: string,
  indices?: Set<number>,
): THREE.Texture {
  // 纹理分辨率按板框长边自适应：保证每毫米足够像素密度，放大后细节依然清晰。
  // 上限 4096 兼顾显存占用与老 GPU（Win7 常见集成显卡）的 MAX_TEXTURE_SIZE 兼容性。
  const PX_PER_MM = 40
  const maxTex = Math.min(4096, Math.max(1024, Math.round(Math.max(g.w, g.h) * PX_PER_MM)))
  const cw = aspect >= 1 ? maxTex : Math.round(maxTex * aspect)
  const ch = aspect >= 1 ? Math.round(maxTex / aspect) : maxTex
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, cw, ch)

  const scale = cw / g.w
  const dx = (layer.vb.minX - g.minX) * scale
  const dy = (layer.vb.minY - g.minY) * scale
  const dw = layer.vb.w * scale
  const dh = layer.vb.h * scale

  ctx.save()
  ctx.translate(dx, dy + dh)
  ctx.scale(dw / layer.vb.w, -dh / layer.vb.h)
  ctx.translate(-layer.vb.minX, -layer.vb.minY)

  const feats = indices ? layer.features.filter((_, i) => indices.has(i)) : layer.features
  for (const f of feats) drawFeature(ctx, f, layer.symbols, color)
  ctx.restore()

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  tex.needsUpdate = true
  return tex
}
