// PDF 导出（原生矢量版）：直接从 ODB++ 解析出的图元生成原生 PDF，
// 不经 SVG / svg2pdf / jsPDF 等中间层——图元以 PDF 路径运算符写入，
// 铺铜内孔用 evenodd 填充（`f*`），焊盘用贝塞尔圆/椭圆，走线/圆弧用带宽度描边。
// 内容流用 FlateDecode 压缩，纯矢量、放大不失真。导出不包含任何文字/技术要求标注。
//
// 坐标系：板坐标（mm，y 轴向上）直接映射到 PDF 用户空间（pt，y 轴向上），
// 与 3D 视图的顶视方向一致、不做镜像。PDF 页默认白底，仅绘制各层图元。
import type { OdbLayer, OdbFeature, OdbSymbol } from './odb'
import type { GlobalBox } from './geometry'
import type { LayerKind } from './layers'
import { DEFAULT_MARGINS, type PdfMargins } from './pdfConfig'

export interface PdfLayer {
  color: string
  odb: OdbLayer
  /** 导出时旋转 180°（用于底层丝印：翻转后按可读方向呈现） */
  rotate180?: boolean
  /**
   * 该层强制使用黑色绘制（忽略 ODB++ 数据色与预设色）。
   * 用于印制板图：工程图纸惯例为单色制图，不按图层着色。
   */
  black?: boolean
}

export type PdfLayout = 'grid' | 'perPage'

const KAPPA = 0.5522847498307936 // 贝塞尔圆近似常数 (4/3)(√2−1)
const MM_TO_PT = 72 / 25.4 // 1mm = 72/25.4 pt，用于 1:1 实际尺寸导出

// ---------- 数字格式化 ----------
// 坐标最多 2 位小数（pt），去掉尾零；2 位小数 ≈ 0.0035mm 精度，远超 PCB 最小特征。
function fmt(n: number): string {
  if (!isFinite(n)) return '0'
  const v = Math.round(n * 100) / 100
  return String(v)
}

/**
 * PDF 白底下的图层配色。3D 视图在深色背景上用浅色模拟真实 PCB（白色丝印），
 * 但 PDF 是白底，浅色丝印/钢网几乎不可见——这里把浅色层替换为深色以保证清晰。
 */
function pdfColorFor(kind: LayerKind, fallback: string): string {
  switch (kind) {
    case 'topSilkscreen':
      return '#1f1f1f' // 近黑（对应顶层丝印）
    case 'bottomSilkscreen':
      return '#4d4d4d' // 深灰（对应底层丝印，稍浅以区分顶层）
    case 'topPaste':
      return '#6b6b6b' // 中深灰（钢网，白底可见）
    case 'bottomPaste':
      return '#7d7d7d'
    default:
      return fallback
  }
}

/** hex 颜色 → [r,g,b] ∈ [0,1] */
function hexToRgb01(hex: string): [number, number, number] {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  if (!isFinite(n)) return [0.6, 0.54, 0.16]
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** 字节序列（显式 ArrayBuffer 后端，满足 Blob/CompressionStream 的 BufferSource 类型） */
type Bytes = Uint8Array<ArrayBuffer>

const TE = new TextEncoder()
const enc = (s: string): Bytes => TE.encode(s) as Bytes

function concat(...arrs: Uint8Array[]): Bytes {
  let len = 0
  for (const a of arrs) len += a.length
  const out = new Uint8Array(len)
  let off = 0
  for (const a of arrs) {
    out.set(a, off)
    off += a.length
  }
  return out
}

// ---------- 绘图上下文（板坐标 mm → PDF pt 的仿射变换 + 运算符缓冲） ----------
class Gfx {
  ops: string[]
  // PDF_x = ax + x*sx，PDF_y = ay + y*sy
  // 横向与纵向缩放分开存储，以支持“固定画幅 + 内缩”布局下的非等比缩放。
  constructor(
    private ax: number,
    private ay: number,
    private sx: number,
    private sy = sx,
    ops?: string[],
  ) {
    this.ops = ops ?? []
  }
  /** 板坐标点 → "x y" */
  P(x: number, y: number): string {
    return `${fmt(this.ax + x * this.sx)} ${fmt(this.ay + y * this.sy)}`
  }
  /** 板坐标点 → PDF 坐标数值 [px, py] */
  pt(x: number, y: number): [number, number] {
    return [this.ax + x * this.sx, this.ay + y * this.sy]
  }
  /** 板坐标长度(mm) → pt 数值（横向口径，用于线宽等标量） */
  W(mm: number): string {
    return fmt(mm * this.sx)
  }
  /** 板坐标长度(mm) → pt 数值（纵向口径） */
  Hy(mm: number): string {
    return fmt(mm * this.sy)
  }
}

// ---------- 基础几何发射器 ----------
/** 一段圆弧（局部坐标系：从角度 0 到 d，半径 r）对应的三次贝塞尔，追加 `c` 运算符。
 *  当前点须已位于该段起点。 */
function emitArcSeg(g: Gfx, cx: number, cy: number, r: number, a0: number, d: number) {
  const alpha = (4 / 3) * Math.tan(d / 4)
  const cd = Math.cos(d)
  const sd = Math.sin(d)
  const p1 = [r, r * alpha]
  const p2 = [r * cd + r * alpha * sd, r * sd - r * alpha * cd]
  const p3 = [r * cd, r * sd]
  const c0 = Math.cos(a0)
  const s0 = Math.sin(a0)
  const R = (px: number, py: number): [number, number] => [
    cx + px * c0 - py * s0,
    cy + px * s0 + py * c0,
  ]
  const [x1, y1] = R(p1[0], p1[1])
  const [x2, y2] = R(p2[0], p2[1])
  const [x3, y3] = R(p3[0], p3[1])
  g.ops.push(`${g.P(x1, y1)} ${g.P(x2, y2)} ${g.P(x3, y3)} c`)
}

/** 一段圆弧（从角度 a0 起扫过 sweep），追加若干 `c`。当前点须已位于弧起点。 */
function emitArcSegs(g: Gfx, cx: number, cy: number, r: number, a0: number, sweep: number) {
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)))
  const ds = sweep / n
  for (let i = 0; i < n; i++) emitArcSeg(g, cx, cy, r, a0 + ds * i, ds)
}

/** 完整椭圆（四段贝塞尔），追加 `m` + 4×`c`，终点回到起点 */
function emitEllipse(g: Gfx, cx: number, cy: number, rx: number, ry: number) {
  const kx = rx * KAPPA
  const ky = ry * KAPPA
  g.ops.push(
    `${g.P(cx + rx, cy)} m`,
    `${g.P(cx + rx, cy + ky)} ${g.P(cx + kx, cy + ry)} ${g.P(cx, cy + ry)} c`,
    `${g.P(cx - kx, cy + ry)} ${g.P(cx - rx, cy + ky)} ${g.P(cx - rx, cy)} c`,
    `${g.P(cx - rx, cy - ky)} ${g.P(cx - kx, cy - ry)} ${g.P(cx, cy - ry)} c`,
    `${g.P(cx + kx, cy - ry)} ${g.P(cx + rx, cy - ky)} ${g.P(cx + rx, cy)} c`,
  )
}

/** 多边形（外轮廓或内孔），追加 `m` + `l`×n + `h` */
function emitPolygon(g: Gfx, pts: number[][]) {
  g.ops.push(`${g.P(pts[0][0], pts[0][1])} m`)
  for (let k = 1; k < pts.length; k++) g.ops.push(`${g.P(pts[k][0], pts[k][1])} l`)
  g.ops.push('h')
}

/** 矩形路径（不含 fill） */
function emitRectPath(g: Gfx, x0: number, y0: number, w: number, h: number) {
  g.ops.push(
    `${g.P(x0, y0)} m`,
    `${g.P(x0 + w, y0)} l`,
    `${g.P(x0 + w, y0 + h)} l`,
    `${g.P(x0, y0 + h)} l`,
    'h',
  )
}

/** 圆角矩形（四角各一段 90° 圆弧贝塞尔），追加整条闭合路径（不含 fill） */
function emitRoundedRect(g: Gfx, x0: number, y0: number, w: number, h: number, r: number) {
  g.ops.push(`${g.P(x0 + r, y0)} m`, `${g.P(x0 + w - r, y0)} l`)
  emitArcSegs(g, x0 + w - r, y0 + r, r, -Math.PI / 2, Math.PI / 2)
  g.ops.push(`${g.P(x0 + w, y0 + h - r)} l`)
  emitArcSegs(g, x0 + w - r, y0 + h - r, r, 0, Math.PI / 2)
  g.ops.push(`${g.P(x0 + r, y0 + h)} l`)
  emitArcSegs(g, x0 + r, y0 + h - r, r, Math.PI / 2, Math.PI / 2)
  g.ops.push(`${g.P(x0, y0 + r)} l`)
  emitArcSegs(g, x0 + r, y0 + r, r, Math.PI, Math.PI / 2)
  g.ops.push('h')
}

/** 八角形（平顶/平底）路径（不含 fill） */
function emitOctagonPath(g: Gfx, cx: number, cy: number, w: number, h: number) {
  const hw = w / 2
  const hh = h / 2
  const cw = hw * 0.7071
  const ch = hh * 0.7071
  emitPolygon(g, [
    [cx - hw + cw, cy - hh],
    [cx + hw - cw, cy - hh],
    [cx + hw, cy - hh + ch],
    [cx + hw, cy + hh - ch],
    [cx + hw - cw, cy + hh],
    [cx - hw + cw, cy + hh],
    [cx - hw, cy + hh - ch],
    [cx - hw, cy - hh + ch],
  ])
}

/** 焊盘符号 → 闭合路径（不含 fill；donut 画内外两圆） */
function emitSymbolPath(g: Gfx, sym: OdbSymbol, x: number, y: number) {
  switch (sym.kind) {
    case 'round':
    case 'unknown': {
      const r = (sym.d ?? sym.w) / 2
      emitEllipse(g, x, y, r, r)
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
        emitRectPath(g, x0, y0, w, h)
      } else {
        emitRoundedRect(g, x0, y0, w, h, r)
      }
      break
    }
    case 'oval':
      emitEllipse(g, x, y, sym.w / 2, sym.h / 2)
      break
    case 'oct':
      emitOctagonPath(g, x, y, sym.w, sym.h)
      break
    case 'donut': {
      const outer = (sym.d ?? sym.w) / 2
      const inner = (sym.inner ?? outer * 0.5) / 2
      emitEllipse(g, x, y, outer, outer)
      emitEllipse(g, x, y, inner, inner)
      break
    }
  }
}

/** 焊盘符号 → 填充路径（donut 用 evenodd `f*`，其余 `f`） */
function emitSymbol(g: Gfx, sym: OdbSymbol, x: number, y: number) {
  emitSymbolPath(g, sym, x, y)
  g.ops.push(sym.kind === 'donut' ? 'f*' : 'f')
}

/** 单个图元 → 路径/描边运算符（负极性 N 图元为挖空，样例中不存在，暂跳过） */
function emitFeature(g: Gfx, f: OdbFeature, syms: Record<number, OdbSymbol>) {
  if (f.polarity === 'N') return
  if (f.kind === 'pad' && f.x != null && f.y != null) {
    const sym = syms[f.symbol]
    if (!sym) return
    emitSymbol(g, sym, f.x, f.y)
  } else if (f.kind === 'line' && f.x1 != null) {
    const sym = syms[f.symbol]
    const w = sym?.d ?? Math.min(sym?.w ?? 1, sym?.h ?? 1)
    const cap = sym?.kind === 'round' || sym?.kind === 'oval' ? 1 : 0
    g.ops.push(
      `${g.W(w)} w`,
      `${cap} J`,
      `${g.P(f.x1, f.y1!)} m`,
      `${g.P(f.x2!, f.y2!)} l`,
      'S',
    )
  } else if (f.kind === 'arc' && f.x1 != null && f.cx != null) {
    const sym = syms[f.symbol]
    const w = sym?.d ?? Math.min(sym?.w ?? 1, sym?.h ?? 1)
    const r = Math.hypot(f.x1 - f.cx, f.y1! - f.cy!)
    if (r < 1e-6) {
      // 退化圆弧：按圆盘绘制
      const rd = w / 2
      emitEllipse(g, f.x1, f.y1!, rd, rd)
      g.ops.push('f')
    } else {
      const a1 = Math.atan2(f.y1! - f.cy!, f.x1 - f.cx!)
      const a2 = Math.atan2(f.y2! - f.cy!, f.x2! - f.cx!)
      let da = a2 - a1
      while (da > Math.PI) da -= 2 * Math.PI
      while (da < -Math.PI) da += 2 * Math.PI
      g.ops.push(`${g.P(f.x1, f.y1!)} m`)
      emitArcSegs(g, f.cx, f.cy!, r, a1, da)
      g.ops.push(`${g.W(w)} w`, '1 J', 'S')
    }
  } else if (f.kind === 'surface' && f.poly && f.poly.length >= 3) {
    emitPolygon(g, f.poly)
    let hasHoles = false
    if (f.holes) {
      for (const h of f.holes) {
        if (h.length >= 3) {
          emitPolygon(g, h)
          hasHoles = true
        }
      }
    }
    g.ops.push(hasHoles ? 'f*' : 'f')
  }
}

/** 图层发射选项 */
interface EmitOpts {
  /** 是否旋转 180°（绕 rotateCenter） */
  rotate180?: boolean
  /** 180° 旋转中心（板坐标），rotate180 时必填 */
  center?: [number, number]
  /** 全局板框（负片层渲染用） */
  board?: GlobalBox
}

interface EmitOpts {
  rotate180?: boolean
  /** 180° 旋转中心（板坐标），rotate180 时必填 */
  center?: [number, number]
  board?: GlobalBox
  /** 强制黑色绘制（印制板图用） */
  black?: boolean
}

/**
 * 把一层图元发射到指定 gfx。
 * - 常规正片层：逐图元填充/描边；
 * - 负片层（layer.polarity === 'NEGATIVE'）：铜箔 = 板框 减去 图元（空隙），
 *   用 evenodd（外框 + 空隙轮廓）一次填充。
 */
function emitLayer(g: Gfx, layer: OdbLayer, color: string, opts: EmitOpts = {}) {
  // 图纸配色优先级：强制黑色（印制板图） > ODB++ 数据色 > 调用方传入的预设色。
  // （3D 爆炸图仍使用预设色，与数据颜色相互独立。）
  const c = opts.black ? '#000000' : pdfColorFor(layer.meta.kind, layer.color ?? color)
  const [r, gg, b] = hexToRgb01(c)

  if (opts.rotate180 && opts.center) {
    const [px, py] = g.pt(opts.center[0], opts.center[1])
    g.ops.push('q', `-1 0 0 -1 ${fmt(2 * px)} ${fmt(2 * py)} cm`)
  }

  g.ops.push(`${fmt(r)} ${fmt(gg)} ${fmt(b)} rg`, `${fmt(r)} ${fmt(gg)} ${fmt(b)} RG`)

  if (layer.polarity === 'NEGATIVE' && opts.board) {
    emitRectPath(g, opts.board.minX, opts.board.minY, opts.board.w, opts.board.h)
    for (const f of layer.features) {
      if (f.kind === 'surface' && f.poly) {
        emitPolygon(g, f.poly)
        if (f.holes) for (const h of f.holes) if (h.length >= 3) emitPolygon(g, h)
      } else if (f.kind === 'pad' && f.x != null && f.y != null) {
        const sym = layer.symbols[f.symbol]
        if (sym) emitSymbolPath(g, sym, f.x, f.y)
      }
    }
    g.ops.push('f*')
  } else {
    for (const f of layer.features) emitFeature(g, f, layer.symbols)
  }

  if (opts.rotate180 && opts.center) g.ops.push('Q')
}

// ---------- 布局 ----------
interface Placed {
  /** 板框原点映射到页面上的 x（pt） */
  ox: number
  /** 板框原点映射到页面上的 y（pt） */
  oy: number
  /** 横向缩放（pt/mm），= MM_TO_PT * sx */
  sx: number
  /** 纵向缩放（pt/mm），= MM_TO_PT * sy */
  sy: number
}

/**
 * 单页布局：固定画幅（页面 = 板框实际尺寸）+ 内缩缩放。
 *
 * 页面尺寸恒等于板框实际尺寸（A2 即 594mm × 420mm，换算为 pt 后为 MediaBox），
 * 不因边距而增大。图形按横向 sx、纵向 sy 缩进页面内侧，四周腾出留白带：
 *
 *   W = g.w * MM_TO_PT（板宽，pt）；H = g.h * MM_TO_PT（板高，pt）
 *   sx = 1 - (left + right) / W
 *   sy = 1 - (top + bottom) / H
 *
 * 边距 m.top/bottom/left/right 的单位是 PDF 用户空间坐标（pt，1pt = 1/72 英寸），
 * 因此四条留白带的实际宽度精确等于配置值。
 *
 * 注意：sx 与 sy 由各自的边距和被除数决定，通常不完全相等（A2 上约差 0.03%），
 * 属于刻意保留的非等比缩放——它保证四边留白严格等于用户设定值。
 */
function perPagePlacements(g: GlobalBox, m: PdfMargins): { pw: number; ph: number; p: Placed } {
  const W = g.w * MM_TO_PT // 板宽 pt
  const H = g.h * MM_TO_PT // 板高 pt

  const ml = m.left
  const mr = m.right
  const mt = m.top
  const mb = m.bottom

  // 留白不得吃到内容：合计超过板宽/高时按比例收窄，避免出现反向缩放
  const clampPair = (a: number, b: number, total: number) => {
    const sum = a + b
    if (sum <= 0 || sum < total) return [a, b] as const
    const k = (total * 0.5) / sum
    return [a * k, b * k] as const
  }
  const [l, r] = clampPair(ml, mr, W)
  const [t, b] = clampPair(mt, mb, H)

  const sx = Math.max(1e-6, 1 - (l + r) / W)
  const sy = Math.max(1e-6, 1 - (t + b) / H)

  // 页面尺寸 = 板框实际尺寸（pt），恒定不变
  const pw = W
  const ph = H

  // 板框原点平移到「左侧留白 + 底部留白」之后
  return { pw, ph, p: { ox: l, oy: b, sx: MM_TO_PT * sx, sy: MM_TO_PT * sy } }
}

// ---------- Flate 压缩 ----------
async function deflate(data: Bytes): Promise<Bytes> {
  const cs = new CompressionStream('deflate')
  const writer = cs.writable.getWriter()
  writer.write(data)
  writer.close()
  const reader = cs.readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const v = value as Uint8Array
    chunks.push(v)
    total += v.length
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/** 一页：内容流（未压缩文本）+ 媒体框 */
interface PdfPageSpec {
  content: Bytes
  mediaBox: [number, number]
}

/** 组装原生 PDF（字节级：对象 + xref + trailer），纯矢量、无文字标注 */
async function buildPdf(pages: PdfPageSpec[]): Promise<Bytes> {
  const compressed: Bytes[] = []
  for (const p of pages) compressed.push(await deflate(p.content))

  const catalogNum = 1
  const pagesNum = 2
  let num = 3
  const pageNums: number[] = []
  const contentNums: number[] = []
  for (let i = 0; i < pages.length; i++) {
    pageNums.push(num++)
    contentNums.push(num++)
  }
  const nObj = num - 1

  const parts: Uint8Array[] = [new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])]
  let len = parts[0].length
  const offsets: number[] = new Array(nObj + 1).fill(0)
  const add = (b: Uint8Array) => {
    parts.push(b)
    len += b.length
  }
  const body = (n: number, b: Uint8Array) => {
    offsets[n] = len
    add(enc(`${n} 0 obj\n`))
    add(b)
    add(enc('\nendobj\n'))
  }

  body(catalogNum, enc(`<< /Type /Catalog /Pages ${pagesNum} 0 R >>`))
  const kids = pageNums.map((n) => `${n} 0 R`).join(' ')
  body(pagesNum, enc(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`))
  for (let i = 0; i < pages.length; i++) {
    const [mw, mh] = pages[i].mediaBox
    body(
      pageNums[i],
      enc(`<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 ${fmt(mw)} ${fmt(mh)}] /Resources << >> /Contents ${contentNums[i]} 0 R >>`),
    )
    body(
      contentNums[i],
      concat(enc(`<< /Length ${compressed[i].length} /Filter /FlateDecode >>\nstream\n`), compressed[i], enc('\nendstream')),
    )
  }

  const xrefOffset = len
  let xref = `xref\n0 ${nObj + 1}\n0000000000 65535 f \n`
  for (let n = 1; n <= nObj; n++) xref += String(offsets[n]).padStart(10, '0') + ' 00000 n \n'
  add(enc(xref))
  add(enc(`trailer\n<< /Size ${nObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`))
  return concat(...parts)
}

/** 由 ODB++ 图层 + 全局板框生成原生矢量 PDF 字节 */
export async function buildPdfFromLayers(
  layers: PdfLayer[],
  g: GlobalBox,
  layout: PdfLayout,
  margins: PdfMargins = DEFAULT_MARGINS,
): Promise<Bytes> {
  const pages: PdfPageSpec[] = []
  const center: [number, number] = [g.minX + g.w / 2, g.minY + g.h / 2]

  if (layout === 'perPage') {
    const { pw, ph, p } = perPagePlacements(g, margins)
    for (const layer of layers) {
      const gfx = new Gfx(p.ox - g.minX * p.sx, p.oy - g.minY * p.sy, p.sx, p.sy)
      emitLayer(gfx, layer.odb, layer.color, {
        rotate180: layer.rotate180,
        center,
        board: g,
        black: layer.black,
      })
      pages.push({ content: enc(gfx.ops.join('\n')), mediaBox: [pw, ph] })
    }
  } else {
    // grid：A4 横向单页，各层按网格排布
    const n = layers.length
    const cols = Math.ceil(Math.sqrt(n))
    const rows = Math.ceil(n / cols)
    const pw = 841.89
    const ph = 595.28
    const margin = 20
    const gap = 10
    const aw = pw - 2 * margin
    const ah = ph - 2 * margin
    const cellW = (aw - (cols - 1) * gap) / cols
    const cellH = (ah - (rows - 1) * gap) / rows
    const s = Math.min(cellW / g.w, cellH / g.h)
    const imgW = g.w * s
    const imgH = g.h * s
    const ops: string[] = []
    for (let i = 0; i < n; i++) {
      const col = i % cols
      const row = Math.floor(i / cols)
      const cellTopY = ph - margin - row * (cellH + gap)
      const imgY = cellTopY - cellH / 2 - imgH / 2
      const imgX = margin + col * (cellW + gap) + (cellW - imgW) / 2
      const gfx = new Gfx(imgX - g.minX * s, imgY - g.minY * s, s, s, ops)
      emitLayer(gfx, layers[i].odb, layers[i].color, {
        rotate180: layers[i].rotate180,
        center,
        board: g,
        black: layers[i].black,
      })
    }
    pages.push({ content: enc(ops.join('\n')), mediaBox: [pw, ph] })
  }

  return buildPdf(pages)
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 导出图层为原生矢量 PDF 并触发下载（无技术要求标注） */
export async function exportLayersPdf(
  layers: PdfLayer[],
  opts: { g: GlobalBox; layout: PdfLayout; prefix?: string; margins?: PdfMargins },
): Promise<void> {
  if (layers.length === 0) return
  const pdf = await buildPdfFromLayers(layers, opts.g, opts.layout, opts.margins ?? DEFAULT_MARGINS)
  const blob = new Blob([pdf], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${opts.prefix ?? 'pcb-layers'}-${stamp()}.pdf`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
