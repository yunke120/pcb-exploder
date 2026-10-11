// ODB++ 输入支持：解析 ODB++ 目录树（来自 zip 或文件夹拖入），
// 将各层渲染为与 Gerber 管线兼容的 three.js 纹理，并复用几何连通性算法重建网络。
//
// 单位约定（本样例）：坐标以“英寸”存储，符号(孔径)尺寸以“mils(千分之一英寸)”存储。
// 解析时统一换算为 mm：坐标 ×25.4，符号尺寸 ×0.0254，从而可直接复用 nets.ts 的
// TOL=0.1mm / CELL=2mm 连通性参数。

import * as THREE from 'three'
import { layerColor, type LayerKind, type LayerMeta } from './layers'
import type { ParsedLayer, Primitive } from './gerberParse'
import type { Net } from './nets'
import { computeNets } from './nets'
import type { GlobalBox, ViewBox } from './gerber'

const INCH_TO_MM = 25.4
const MIL_TO_MM = 0.0254
const NET_TOL = 0.15 // mm，连通容差

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
  text: () => Promise<string>
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
}

function parseFeatures(text: string): ParsedFeatures {
  const symbols: Record<number, OdbSymbol> = {}
  const features: OdbFeature[] = []
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

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
    // 其它定义（@ & #）跳过
    if (line[0] === '@' || line[0] === '&' || line[0] === '#') {
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
      // 表面（填充多边形）：S polarity [window] 随后 OB/OS.../OE (可选 OH.../OE) / SE
      const pol = parts[1] === 'N' ? 'N' : 'P'
      const outer: number[][] = []
      const holes: number[][][] = []
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
        if (l2.startsWith('OB')) {
          const pp = l2.split(/\s+/)
          const x = parseFloat(pp[1]) * INCH_TO_MM
          const y = parseFloat(pp[2]) * INCH_TO_MM
          outer.push([x, y])
          cur = outer
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
        if (l2.startsWith('OH')) {
          const pp = l2.split(/\s+/)
          const x = parseFloat(pp[1]) * INCH_TO_MM
          const y = parseFloat(pp[2]) * INCH_TO_MM
          const hole: number[][] = [[x, y]]
          holes.push(hole)
          cur = hole
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
      if (outer.length >= 3) {
        const f: OdbFeature = { kind: 'surface', symbol: 0, polarity: pol, poly: outer }
        if (holes.length) f.holes = holes
        features.push(f)
        for (const p of outer) touch(p[0], p[1])
        for (const h of holes) for (const p of h) touch(p[0], p[1])
      }
      continue
    }
    // 其余（TO 文本对象等）跳过
    i++
  }

  if (!isFinite(minX)) return { symbols, features, vb: { minX: 0, minY: 0, w: 1, h: 1 } }
  return { symbols, features, vb: { minX, minY, w: maxX - minX, h: maxY - minY } }
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

// ---------- 几何连通性（复用 nets.ts） ----------
interface Sample {
  x: number
  y: number
  r: number
  p: number
}
function primSamples(pr: Primitive, out: Sample[]) {
  for (const o of pr.obs) {
    if (o.type === 'c') out.push({ x: o.x, y: o.y, r: o.r, p: -1 })
    else {
      const len = Math.hypot(o.x1 - o.x0, o.y1 - o.y0)
      const steps = Math.max(1, Math.min(64, Math.ceil(len / 0.4)))
      for (let s = 0; s <= steps; s++) {
        const t = s / steps
        out.push({ x: o.x0 + (o.x1 - o.x0) * t, y: o.y0 + (o.y1 - o.y0) * t, r: o.w, p: -1 })
      }
    }
  }
}

type Obstacle =
  | { type: 'c'; x: number; y: number; r: number }
  | { type: 's'; x0: number; y0: number; x1: number; y1: number; w: number }

function featuresToPrimitives(layer: OdbLayer): Primitive[] {
  const prims: Primitive[] = []
  for (const f of layer.features) {
    const obs: Obstacle[] = []
    const sym = layer.symbols[f.symbol]
    const half = (sym?.d ?? Math.min(sym?.w ?? 1, sym?.h ?? 1)) / 2
    if (f.kind === 'pad' && f.x != null && f.y != null) {
      obs.push({ type: 'c', x: f.x, y: f.y, r: half })
    } else if (f.kind === 'line' && f.x1 != null) {
      obs.push({ type: 's', x0: f.x1, y0: f.y1!, x1: f.x2!, y1: f.y2!, w: half })
    } else if (f.kind === 'arc' && f.x1 != null && f.cx != null) {
      const r = Math.hypot(f.x1 - f.cx, f.y1! - f.cy!)
      if (r < 1e-6) {
        obs.push({ type: 'c', x: f.x1, y: f.y1!, r: half })
      } else {
        const a1 = Math.atan2(f.y1! - f.cy!, f.x1 - f.cx!)
        const a2 = Math.atan2(f.y2! - f.cy!, f.x2! - f.cx!)
        const steps = 24
        let da = a2 - a1
        while (da > Math.PI) da -= 2 * Math.PI
        while (da < -Math.PI) da += 2 * Math.PI
        for (let s = 0; s <= steps; s++) {
          const a = a1 + (da * s) / steps
          obs.push({ type: 'c', x: f.cx + Math.cos(a) * r, y: f.cy! + Math.sin(a) * r, r: half })
        }
      }
    } else if (f.kind === 'surface' && f.poly) {
      // 沿多边形边界以 ~1mm 步长细分采样，并保留 0.1mm 半径，
      // 使铜箔填充区（surface）能与落在边缘的焊盘/走线相连。
      for (let k = 0; k < f.poly.length - 1; k++) {
        const [x0, y0] = f.poly[k]
        const [x1, y1] = f.poly[k + 1]
        const len = Math.hypot(x1 - x0, y1 - y0)
        const steps = Math.max(1, Math.min(256, Math.ceil(len)))
        for (let s = 0; s <= steps; s++) {
          const t = s / steps
          const px = x0 + (x1 - x0) * t
          const py = y0 + (y1 - y0) * t
          obs.push({ type: 's', x0: px, y0: py, x1: px, y1: py, w: 0.1 })
        }
      }
    }
    const pkind: Primitive['kind'] =
      f.kind === 'pad' ? 'flash' : f.kind === 'line' ? 'draw' : f.kind === 'arc' ? 'arc' : 'region'
    prims.push({ kind: pkind, aperture: '', size: 0, obs: obs as Obstacle[], spanStart: 0, spanEnd: 0, netName: '', x: f.x, y: f.y })
  }
  return prims
}

interface OdbNetResult {
  nets: Net[]
  primToComp: number[]
  samples: Sample[]
  grid: Map<string, number[]>
}

function computeOdbNets(layer: OdbLayer): OdbNetResult {
  const prims = featuresToPrimitives(layer)
  const parsed: ParsedLayer = { blocks: [], setupIdx: -1, modeIdx: -1, apertureSelectIdx: -1, endBlock: -1, primitives: prims } as unknown as ParsedLayer
  const components = computeNets(parsed)

  const primToComp = new Array(prims.length).fill(-1)
  components.forEach((net, ci) => net.primitiveIdxs.forEach((pi) => (primToComp[pi] = ci)))

  // 采样点云 + 空间网格（用于网表 seed 匹配）
  const samples: Sample[] = []
  const grid = new Map<string, number[]>()
  const CELL = 2
  const key = (cx: number, cy: number) => `${Math.floor(cx / CELL)},${Math.floor(cy / CELL)}`
  prims.forEach((pr, i) => {
    const list: Sample[] = []
    primSamples(pr, list)
    for (const s of list) samples.push({ ...s, p: i })
  })
  for (let si = 0; si < samples.length; si++) {
    const k = key(samples[si].x, samples[si].y)
    if (!grid.has(k)) grid.set(k, [])
    grid.get(k)!.push(si)
  }
  return { nets: components, primToComp, samples, grid }
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

  const matrix = parseMatrix(await matrixEntry.text())
  const netlist = netlistEntry ? parseNetlist(await netlistEntry.text()) : { netNames: [], seeds: [] }
  const profile = profileEntry ? parseProfile(await profileEntry.text()) : undefined

  const layers: OdbLayer[] = []
  for (const ml of matrix) {
    const fe = layerFeatures(ml.name)
    if (!fe) continue
    const parsed = parseFeatures(await fe.text())
    const meta = odbMeta(ml.type, ml.name, ml.row, ml.polarity)
    const layer: OdbLayer = {
      name: ml.name,
      type: ml.type,
      row: ml.row,
      polarity: ml.polarity,
      meta,
      symbols: parsed.symbols,
      features: parsed.features,
      vb: parsed.vb,
    }
    // 铜层重建网络（按网表 seed 标注真实网名）
    if (meta.kind === 'topCopper' || meta.kind === 'bottomCopper' || meta.kind === 'innerCopper') {
      const { nets, primToComp, grid, samples } = computeOdbNets(layer)
      const CELL = 2
      // 为每个真实网名收集其命中的 component
      const netToComps = new Map<number, Set<number>>()
      for (const seed of netlist.seeds) {
        if (seed.netref <= 0) continue
        let hit = -1
        for (let gx = -1; gx <= 1; gx++)
          for (let gy = -1; gy <= 1; gy++) {
            const bucket = grid.get(`${Math.floor(seed.x / CELL) + gx},${Math.floor(seed.y / CELL) + gy}`)
            if (!bucket) continue
            for (const si of bucket) {
              const s = samples[si]
              if (Math.hypot(s.x - seed.x, s.y - seed.y) - s.r <= NET_TOL) {
                hit = s.p
                break
              }
            }
            if (hit >= 0) break
          }
        if (hit >= 0) {
          const comp = primToComp[hit]
          if (!netToComps.has(seed.netref)) netToComps.set(seed.netref, new Set())
          netToComps.get(seed.netref)!.add(comp)
        }
      }
      // 组装最终 Net[]
      const finalNets: Net[] = []
      const consumed = new Set<number>()
      let id = 0
      for (const [netref, compSet] of netToComps) {
        const idxs: number[] = []
        for (const ci of compSet) {
          consumed.add(ci)
          idxs.push(...nets[ci].primitiveIdxs)
        }
        const name = netlist.netNames[netref] || `Net ${netref}`
        finalNets.push({ id: id++, name, primitiveIdxs: idxs, explicit: true })
      }
      // 未被网表标注的连通分量 → 合成名
      let synth = 1
      nets.forEach((net, ci) => {
        if (consumed.has(ci)) return
        finalNets.push({ id: id++, name: `Net ${synth++}`, primitiveIdxs: net.primitiveIdxs, explicit: false })
      })
      finalNets.sort((a, b) => b.primitiveIdxs.length - a.primitiveIdxs.length)
      layer.nets = finalNets
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
  const maxTex = 1024
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
