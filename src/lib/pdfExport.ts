// PDF 导出（原生矢量版）：直接从 ODB++ 解析出的图元生成原生 PDF，
// 不经 SVG / svg2pdf / jsPDF 等中间层——图元以 PDF 路径运算符写入，
// 铺铜内孔用 evenodd 填充（`f*`），焊盘用贝塞尔圆/椭圆，走线/圆弧用带宽度描边。
// 内容流用 FlateDecode 压缩，纯矢量、放大不失真。
//
// 坐标系：板坐标（mm，y 轴向上）直接映射到 PDF 用户空间（pt，y 轴向上），
// 与 3D 视图的顶视方向一致、不做镜像。PDF 页默认白底，仅绘制各层图元。
import type { OdbLayer, OdbFeature, OdbSymbol } from './odb'
import type { GlobalBox } from './geometry'

export interface PdfLayer {
  color: string
  odb: OdbLayer
}

export type PdfLayout = 'grid' | 'perPage'

const KAPPA = 0.5522847498307936 // 贝塞尔圆近似常数 (4/3)(√2−1)

// ---------- 数字格式化 ----------
// 坐标最多 2 位小数（pt），去掉尾零；2 位小数 ≈ 0.0035mm 精度，远超 PCB 最小特征。
function fmt(n: number): string {
  if (!isFinite(n)) return '0'
  const v = Math.round(n * 100) / 100
  return String(v)
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
  // PDF_x = ax + x*s，PDF_y = ay + y*s
  constructor(
    private ax: number,
    private ay: number,
    private s: number,
    ops?: string[],
  ) {
    this.ops = ops ?? []
  }
  /** 板坐标点 → "x y" */
  P(x: number, y: number): string {
    return `${fmt(this.ax + x * this.s)} ${fmt(this.ay + y * this.s)}`
  }
  /** 板坐标长度(mm) → pt 数值 */
  W(mm: number): string {
    return fmt(mm * this.s)
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

/** 圆角矩形（四角各一段 90° 圆弧贝塞尔），追加整条闭合路径 */
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

/** 八角形（平顶/平底），追加闭合路径 + `f` */
function emitOctagon(g: Gfx, cx: number, cy: number, w: number, h: number) {
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
  g.ops.push('f')
}

/** 焊盘符号 → 填充路径 */
function emitSymbol(g: Gfx, sym: OdbSymbol, x: number, y: number) {
  switch (sym.kind) {
    case 'round':
    case 'unknown': {
      const r = (sym.d ?? sym.w) / 2
      emitEllipse(g, x, y, r, r)
      g.ops.push('f')
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
        g.ops.push(
          `${g.P(x0, y0)} m`,
          `${g.P(x0 + w, y0)} l`,
          `${g.P(x0 + w, y0 + h)} l`,
          `${g.P(x0, y0 + h)} l`,
          'h',
          'f',
        )
      } else {
        emitRoundedRect(g, x0, y0, w, h, r)
        g.ops.push('f')
      }
      break
    }
    case 'oval':
      emitEllipse(g, x, y, sym.w / 2, sym.h / 2)
      g.ops.push('f')
      break
    case 'oct':
      emitOctagon(g, x, y, sym.w, sym.h)
      break
    case 'donut': {
      const outer = (sym.d ?? sym.w) / 2
      const inner = (sym.inner ?? outer * 0.5) / 2
      emitEllipse(g, x, y, outer, outer)
      emitEllipse(g, x, y, inner, inner)
      g.ops.push('f*')
      break
    }
  }
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

/** 把一层的全部图元发射到指定 gfx（先设填充/描边颜色为图层色） */
function emitLayer(g: Gfx, layer: OdbLayer, color: string) {
  const [r, gg, b] = hexToRgb01(color)
  g.ops.push(`${fmt(r)} ${fmt(gg)} ${fmt(b)} rg`, `${fmt(r)} ${fmt(gg)} ${fmt(b)} RG`)
  for (const f of layer.features) emitFeature(g, f, layer.symbols)
}

// ---------- 布局 ----------
interface Placed {
  ox: number
  oy: number
  s: number
}

function perPagePlacements(layers: PdfLayer[], g: GlobalBox): { pw: number; ph: number; p: Placed } {
  const long = 800
  const margin = 20
  const aspect = g.w / g.h || 1
  const pw = aspect >= 1 ? long : Math.max(1, Math.round(long * aspect))
  const ph = aspect >= 1 ? Math.max(1, Math.round(long / aspect)) : long
  const s = Math.min((pw - 2 * margin) / g.w, (ph - 2 * margin) / g.h)
  const ox = (pw - g.w * s) / 2
  const oy = (ph - g.h * s) / 2
  void layers
  return { pw, ph, p: { ox, oy, s } }
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

/** 组装原生 PDF（字节级：对象 + xref + trailer） */
async function buildPdf(contents: Bytes[], mediaBoxes: [number, number][]): Promise<Bytes> {
  const N = contents.length
  const nObj = 2 + 2 * N
  const compressed: Uint8Array[] = []
  for (const c of contents) compressed.push(await deflate(c))

  // 头部：%PDF-1.4 + 二进制标记注释（4 个高字节，便于阅读器识别二进制流）。
  // 用显式字节数组构造，避免 TextEncoder 把高位字节按 UTF-8 二次编码。
  const parts: Uint8Array[] = [new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])]
  let len = parts[0].length
  const offsets: number[] = new Array(nObj + 1).fill(0)
  const add = (b: Uint8Array) => {
    parts.push(b)
    len += b.length
  }
  const body = (num: number, b: Uint8Array) => {
    offsets[num] = len
    add(enc(`${num} 0 obj\n`))
    add(b)
    add(enc('\nendobj\n'))
  }

  body(1, enc('<< /Type /Catalog /Pages 2 0 R >>'))
  const kids = Array.from({ length: N }, (_, i) => `${3 + i} 0 R`).join(' ')
  body(2, enc(`<< /Type /Pages /Kids [${kids}] /Count ${N} >>`))
  for (let i = 0; i < N; i++) {
    const pageNum = 3 + i
    const contNum = 3 + N + i
    body(
      pageNum,
      enc(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(mediaBoxes[i][0])} ${fmt(mediaBoxes[i][1])}] /Resources << >> /Contents ${contNum} 0 R >>`,
      ),
    )
    const stream = compressed[i]
    body(contNum, concat(enc(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`), stream, enc('\nendstream')))
  }

  const xrefOffset = len
  let xref = `xref\n0 ${nObj + 1}\n0000000000 65535 f \n`
  for (let num = 1; num <= nObj; num++) xref += String(offsets[num]).padStart(10, '0') + ' 00000 n \n'
  add(enc(xref))
  add(enc(`trailer\n<< /Size ${nObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`))
  return concat(...parts)
}

/** 由 ODB++ 图层 + 全局板框生成原生矢量 PDF 字节 */
export async function buildPdfFromLayers(
  layers: PdfLayer[],
  g: GlobalBox,
  layout: PdfLayout,
): Promise<Bytes> {
  const contents: Bytes[] = []
  const mediaBoxes: [number, number][] = []

  if (layout === 'perPage') {
    const { pw, ph, p } = perPagePlacements(layers, g)
    for (const layer of layers) {
      const gfx = new Gfx(p.ox - g.minX * p.s, p.oy - g.minY * p.s, p.s)
      emitLayer(gfx, layer.odb, layer.color)
      contents.push(enc(gfx.ops.join('\n')))
      mediaBoxes.push([pw, ph])
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
      const gfx = new Gfx(imgX - g.minX * s, imgY - g.minY * s, s, ops)
      emitLayer(gfx, layers[i].odb, layers[i].color)
    }
    contents.push(enc(ops.join('\n')))
    mediaBoxes.push([pw, ph])
  }

  return buildPdf(contents, mediaBoxes)
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 导出图层为原生矢量 PDF 并触发下载 */
export async function exportLayersPdf(
  layers: PdfLayer[],
  opts: { g: GlobalBox; layout: PdfLayout },
): Promise<void> {
  if (layers.length === 0) return
  const pdf = await buildPdfFromLayers(layers, opts.g, opts.layout)
  const blob = new Blob([pdf], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `pcb-layers-${stamp()}.pdf`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
