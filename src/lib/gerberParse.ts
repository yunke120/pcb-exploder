// 轻量 RS-274X(Gerber) 图元解析器，用于从铜层几何反推"网络"。
// 目标不是完整渲染（渲染仍交给 gerber-to-svg），而是：
//  1) 提取每个图元（焊盘/走线/圆弧/铺铜区）的几何与所属命令块索引；
//  2) 支持 %TO.N 显式网络属性；
//  3) 提供 buildSubset() 由网络图元重建可独立渲染的 Gerber 子集文本，
//     以便复用 gerber-to-svg 渲染高亮（与底层完美对齐）。

export type Obstacle =
  | { type: 'c'; x: number; y: number; r: number } // 圆（焊盘）
  | { type: 's'; x0: number; y0: number; x1: number; y1: number; w: number } // 线段（走线/圆弧近似）

export interface Primitive {
  kind: 'flash' | 'draw' | 'arc' | 'region'
  aperture: string
  /** 光圈尺寸（直径或 X 向尺寸，mm），用于连通性宽度；未知为 0 */
  size: number
  /** 几何障碍（mm），用于连通性判断 */
  obs: Obstacle[]
  /** 在 blocks 中的命令块索引区间（含端点），region 跨多块 */
  spanStart: number
  spanEnd: number
  /** 显式网络名（来自 %TO.N），无则为空 */
  netName: string
  // 调试/展示用
  x?: number
  y?: number
}

export interface ParsedLayer {
  /** 全部命令块（含 %...% 参数块与 * 结尾命令块），按原始顺序 */
  blocks: string[]
  /** 参数块索引：FS / MO / ADD / TF / TA（子集重建时必须保留） */
  setupIdx: number[]
  /** 非区域模式块索引：G74/G75 等（子集重建时保留） */
  modeIdx: number[]
  /** 光圈选择块索引：独立 D10+ 选择指令（子集重建时保留） */
  apertureSelectIdx: number[]
  /** 末尾 M02/M00 块（完整文本） */
  endBlock: string
  primitives: Primitive[]
}

interface Format {
  zeroSuppress: 'L' | 'T'
  notation: 'A' | 'I'
  xInt: number
  xDec: number
  yInt: number
  yDec: number
  unit: 'MM' | 'IN'
}

const DEFAULT_FMT: Format = {
  zeroSuppress: 'L',
  notation: 'A',
  xInt: 2,
  xDec: 5,
  yInt: 2,
  yDec: 5,
  unit: 'MM',
}

function decodeCoord(raw: string, f: Format, axis: 'x' | 'y'): number {
  let sign = 1
  let s = raw
  if (s[0] === '+') s = s.slice(1)
  else if (s[0] === '-') {
    sign = -1
    s = s.slice(1)
  }
  const intD = axis === 'x' ? f.xInt : f.yInt
  const decD = axis === 'x' ? f.xDec : f.yDec
  const total = intD + decD
  if (f.zeroSuppress === 'L') s = s.padStart(total, '0')
  else s = s.padEnd(total, '0')
  const intPart = s.slice(0, intD) || '0'
  const decPart = s.slice(intD) || '0'
  let val = parseFloat(intPart + '.' + decPart) * sign
  if (f.unit === 'IN') val *= 25.4 // inch -> mm
  return val
}

export function parseGerber(text: string): ParsedLayer {
  // 1) 切块：%...% 参数块整体原子捕获（内部可能含 *）；其余按 * 拆命令块，且遇 % 即止
  const blocks: string[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '%') {
      const end = text.indexOf('%', i + 1)
      if (end === -1) break
      blocks.push(text.slice(i, end + 1))
      i = end + 1
      continue
    }
    if (c === '*' || c === '\r' || c === '\n') {
      i++
      continue
    }
    let j = i
    while (j < text.length && text[j] !== '*' && text[j] !== '%') j++
    if (j > i) blocks.push(text.slice(i, j))
    i = j
  }

  const fmt: Format = { ...DEFAULT_FMT }
  const apertureSizes = new Map<string, number>() // id -> mm
  const primitives: Primitive[] = []
  const setupIdx: number[] = []
  const modeIdx: number[] = []
  const apertureSelectIdx: number[] = []
  let endBlock = 'M02*'

  let curAperture = ''
  let curX = 0
  let curY = 0
  let prevX = 0
  let prevY = 0
  let interp: 'G01' | 'G02' | 'G03' = 'G01'
  let arcMode: 'single' | 'multi' = 'single'
  let inRegion = false
  let regionPts: [number, number][] = []
  let regionStartIdx = -1
  let regionAperture = ''
  let pendingNet = '' // 来自 %TO.N 的对象属性
  // 宏光圈尺寸：从上一个 G04:AMPARAMS 解析 XSize(mils)
  let lastMacroSize = 0

  for (let bi = 0; bi < blocks.length; bi++) {
    const raw = blocks[bi]
    const block = raw.replace(/^%/, '').replace(/%$/, '').replace(/\*$/, '')

    // ---- 参数块 ----
    if (raw.startsWith('%')) {
      if (/^FS/.test(block)) {
        const m = block.match(/FS([LT])([AI])X(\d)(\d)Y(\d)(\d)/)
        if (m) {
          fmt.zeroSuppress = m[1] as 'L' | 'T'
          fmt.notation = m[2] as 'A' | 'I'
          fmt.xInt = +m[3]
          fmt.xDec = +m[4]
          fmt.yInt = +m[5]
          fmt.yDec = +m[6]
        }
        setupIdx.push(bi)
      } else if (/^MO/.test(block)) {
        fmt.unit = block.includes('MM') ? 'MM' : 'IN'
        setupIdx.push(bi)
      } else if (/^ADD/.test(block)) {
        const m = block.match(/^ADD(\d+)([A-Za-z_]*)[,]?(.*)$/)
        if (m) {
          const id = m[1]
          const tmpl = m[2].toUpperCase()
          const params = m[3]
          let size = 0
          if (tmpl === 'C') {
            const d = parseFloat(params)
            if (!isNaN(d)) size = fmt.unit === 'IN' ? d * 25.4 : d
          } else if (tmpl === 'R' || tmpl === 'O') {
            const ds = params.split(/[xX,]/).map(parseFloat).filter((n) => !isNaN(n))
            if (ds.length) size = Math.min(ds[0], ds[1] ?? ds[0])
            if (fmt.unit === 'IN') size *= 25.4
          } else {
            // 宏光圈：使用上一条 G04:AMPARAMS 的 XSize(mils)
            size = lastMacroSize
          }
          apertureSizes.set(id, size)
        }
        setupIdx.push(bi)
      } else if (/^TF|^TA/.test(block)) {
        setupIdx.push(bi)
      } else if (/^TO/.test(block)) {
        // 对象属性：%TO.N,NetName* 或 %TO.C,Comp*
        const nm = block.match(/\.N,([^*,]+)/)
        pendingNet = nm ? nm[1].trim() : ''
      }
      continue
    }

    // ---- G04 注释：可能含 AMPARAMS（宏光圈真实尺寸） ----
    if (/^G04/.test(block)) {
      const am = block.match(/AMPARAMS\|[^|]*\|XSize=([\d.]+)mil/i)
      if (am) lastMacroSize = parseFloat(am[1]) * 0.0254
      continue
    }

    // ---- 末块 ----
    if (/^M0[02]/.test(block)) {
      endBlock = raw.includes('*') ? raw : raw + '*'
      continue
    }

    // ---- 模式/选择类指令 ----
    if (/^G0?4|^G7[45]/.test(block)) {
      // G74/G75 圆弧象限模式
      if (/G75/.test(block)) arcMode = 'multi'
      else if (/G74/.test(block)) arcMode = 'single'
      if (!(inRegion && /^G3[67]/.test(block))) modeIdx.push(bi)
      continue
    }
    if (!inRegion && /^D(\d{2,})\*?$/.test(block)) {
      const code = parseInt(block.match(/^D(\d+)/)![1], 10)
      if (code >= 10) {
        curAperture = String(code)
        apertureSelectIdx.push(bi)
        continue
      }
    }

    // ---- 区域起止 ----
    if (/^G36/.test(block)) {
      inRegion = true
      regionPts = []
      regionStartIdx = bi
      regionAperture = curAperture
      continue
    }
    if (/^G37/.test(block)) {
      inRegion = false
      if (regionPts.length >= 3) {
        const size = apertureSizes.get(regionAperture) ?? 0
        const TOL = 0.1
        const obs: Obstacle[] = []
        // 用轮廓边近似（铺铜按轮廓连接）
        const edges = regionPts.length
        for (let k = 0; k < edges; k++) {
          const a = regionPts[k]
          const b = regionPts[(k + 1) % edges]
          obs.push({ type: 's', x0: a[0], y0: a[1], x1: b[0], y1: b[1], w: TOL })
        }
        primitives.push({
          kind: 'region',
          aperture: regionAperture,
          size,
          obs,
          spanStart: regionStartIdx,
          spanEnd: bi,
          netName: pendingNet,
        })
      }
      regionPts = []
      continue
    }

    // ---- 坐标与操作 ----
    const xm = block.match(/X(-?[\d.]+)/)
    const ym = block.match(/Y(-?[\d.]+)/)
    const im = block.match(/I(-?[\d.]+)/)
    const jm = block.match(/J(-?[\d.]+)/)
    if (xm) curX = decodeCoord(xm[1], fmt, 'x')
    if (ym) curY = decodeCoord(ym[1], fmt, 'y')

    // 插值模式
    if (/G0?1/.test(block)) interp = 'G01'
    else if (/G0?2/.test(block)) interp = 'G02'
    else if (/G0?3/.test(block)) interp = 'G03'

    const dMatch = block.match(/D0?([123])\*?$/)
    if (!dMatch) continue // 无操作码，仅更新坐标/模式
    const d = dMatch[1]

    if (d === '2') {
      // move
      prevX = curX
      prevY = curY
      continue
    }
    if (d === '3') {
      // flash 焊盘
      const size = apertureSizes.get(curAperture) ?? 0
      primitives.push({
        kind: 'flash',
        aperture: curAperture,
        size,
        obs: [{ type: 'c', x: curX, y: curY, r: size / 2 }],
        spanStart: bi,
        spanEnd: bi,
        netName: pendingNet,
        x: curX,
        y: curY,
      })
      prevX = curX
      prevY = curY
      continue
    }
    // d === '1'：draw / arc
    const size = apertureSizes.get(curAperture) ?? 0
    const hw = size / 2
    if (interp === 'G01') {
      primitives.push({
        kind: 'draw',
        aperture: curAperture,
        size,
        obs: [{ type: 's', x0: prevX, y0: prevY, x1: curX, y1: curY, w: hw }],
        spanStart: bi,
        spanEnd: bi,
        netName: pendingNet,
      })
    } else {
      // 圆弧：采样为折线
      const ix = im ? decodeCoord(im[1], fmt, 'x') : 0
      const jy = jm ? decodeCoord(jm[1], fmt, 'y') : 0
      const cx = prevX + ix
      const cy = prevY + jy
      const r = Math.hypot(prevX - cx, prevY - cy)
      if (r < 1e-6) {
        primitives.push({
          kind: 'draw',
          aperture: curAperture,
          size,
          obs: [{ type: 's', x0: prevX, y0: prevY, x1: curX, y1: curY, w: hw }],
          spanStart: bi,
          spanEnd: bi,
          netName: pendingNet,
        })
      } else {
        let a0 = Math.atan2(prevY - cy, prevX - cx)
        let a1 = Math.atan2(curY - cy, curX - cx)
        let delta = a1 - a0
        const cw = interp === 'G02'
        if (arcMode === 'multi') {
          // 多象限：按方向补齐到 ±2π 内
          if (cw && delta > 0) delta -= 2 * Math.PI
          if (!cw && delta < 0) delta += 2 * Math.PI
        } else {
          // 单象限：取最短弧
          while (delta > Math.PI) delta -= 2 * Math.PI
          while (delta < -Math.PI) delta += 2 * Math.PI
          if (cw && delta > 0) delta -= 2 * Math.PI
          if (!cw && delta < 0) delta += 2 * Math.PI
        }
        const steps = Math.max(2, Math.ceil((Math.abs(delta) * r) / 0.5))
        const obs: Obstacle[] = []
        let px = prevX
        let py = prevY
        for (let s = 1; s <= steps; s++) {
          const a = a0 + (delta * s) / steps
          const nx = cx + r * Math.cos(a)
          const ny = cy + r * Math.sin(a)
          obs.push({ type: 's', x0: px, y0: py, x1: nx, y1: ny, w: hw })
          px = nx
          py = ny
        }
        primitives.push({
          kind: 'arc',
          aperture: curAperture,
          size,
          obs,
          spanStart: bi,
          spanEnd: bi,
          netName: pendingNet,
        })
      }
    }
    prevX = curX
    prevY = curY
  }

  return {
    blocks,
    setupIdx,
    modeIdx,
    apertureSelectIdx,
    endBlock,
    primitives,
  }
}

/** 由选中图元的索引区间重建可独立渲染的 Gerber 子集文本 */
export function buildSubset(parsed: ParsedLayer, selectedPrimitiveIdxs: number[]): string {
  const include = new Set<number>()
  for (const idx of parsed.setupIdx) include.add(idx)
  for (const idx of parsed.modeIdx) include.add(idx)
  for (const idx of parsed.apertureSelectIdx) include.add(idx)
  for (const pi of selectedPrimitiveIdxs) {
    const p = parsed.primitives[pi]
    for (let b = p.spanStart; b <= p.spanEnd; b++) include.add(b)
  }
  const idxs = [...include].sort((a, b) => a - b)
  let out = ''
  for (const idx of idxs) out += parsed.blocks[idx] + (parsed.blocks[idx].endsWith('*') ? '' : '*')
  out += parsed.endBlock
  return out
}
