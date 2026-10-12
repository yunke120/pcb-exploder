// PDF 导出（矢量版）：把各图层转成矢量 SVG，用 svg2pdf.js 写入 PDF（真矢量，放大不失真）。
// 文字（层名，含中文）由浏览器 canvas 渲染为位图后嵌入——jsPDF 内置字体不含 CJK。
// jsPDF / svg2pdf.js 均动态 import 懒加载，不增大主包。
import type { jsPDF as JsPDF } from 'jspdf'
import type { GlobalBox } from './gerber'
import type { OdbLayer, OdbFeature, OdbSymbol } from './odb'

export interface PdfLayer {
  name: string
  color: string
  /** Gerber 层的原始 gerber-to-svg 输出（含 viewBox / mask / use） */
  svg?: string
  /** ODB++ 层引用（features + symbols） */
  odb?: OdbLayer
}

export type PdfLayout = 'grid' | 'perPage'

const NS = 'http://www.w3.org/2000/svg'
const XLINK = 'http://www.w3.org/1999/xlink'

// ---------- 几何辅助 ----------
function circlePath(cx: number, cy: number, r: number): string {
  return `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} Z`
}

function polygonPath(pts: number[][]): string {
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]} ${p[1]}`).join(' ') + ' Z'
}

// ---------- ODB++ 图元 → SVG ----------
function odbSymbolToSvg(sym: OdbSymbol): string {
  switch (sym.kind) {
    case 'round':
    case 'unknown': {
      const r = (sym.d ?? sym.w) / 2
      return `<circle r="${r}"/>`
    }
    case 'square':
    case 'rect': {
      const w = sym.w
      const h = sym.h
      const r = Math.min(sym.r ?? 0, w / 2, h / 2)
      const x0 = -w / 2
      const y0 = -h / 2
      if (r <= 0) return `<rect x="${x0}" y="${y0}" width="${w}" height="${h}"/>`
      return `<path d="M ${x0 + r} ${y0} L ${x0 + w - r} ${y0} A ${r} ${r} 0 0 1 ${x0 + w} ${y0 + r} L ${x0 + w} ${y0 + h - r} A ${r} ${r} 0 0 1 ${x0 + w - r} ${y0 + h} L ${x0 + r} ${y0 + h} A ${r} ${r} 0 0 1 ${x0} ${y0 + h - r} L ${x0} ${y0 + r} A ${r} ${r} 0 0 1 ${x0 + r} ${y0} Z"/>`
    }
    case 'oval':
      return `<ellipse rx="${sym.w / 2}" ry="${sym.h / 2}"/>`
    case 'oct': {
      const w = sym.w / 2
      const h = sym.h / 2
      const cw = w * 0.7071
      const ch = h * 0.7071
      return `<path d="${polygonPath([
        [-w + cw, -h],
        [w - cw, -h],
        [w, -h + ch],
        [w, h - ch],
        [w - cw, h],
        [-w + cw, h],
        [-w, h - ch],
        [-w, -h + ch],
      ])}"/>`
    }
    case 'donut': {
      const outer = (sym.d ?? sym.w) / 2
      const inner = (sym.inner ?? outer * 0.5) / 2
      return `<path fill-rule="evenodd" d="${circlePath(0, 0, outer)} ${circlePath(0, 0, inner)}"/>`
    }
  }
  return ''
}

function odbFeatureToSvg(f: OdbFeature, syms: Record<number, OdbSymbol>): string {
  // 负极性（N）图元为“挖空”（反焊盘等）；当前样例均为正极性，N 暂跳过
  if (f.polarity === 'N') return ''

  if (f.kind === 'pad' && f.x != null && f.y != null) {
    const sym = syms[f.symbol]
    if (!sym) return ''
    return `<g transform="translate(${f.x} ${f.y})">${odbSymbolToSvg(sym)}</g>`
  }
  if (f.kind === 'line' && f.x1 != null) {
    const sym = syms[f.symbol]
    const w = sym?.d ?? Math.min(sym?.w ?? 1, sym?.h ?? 1)
    const cap = sym?.kind === 'round' || sym?.kind === 'oval' ? 'round' : 'butt'
    return `<line x1="${f.x1}" y1="${f.y1}" x2="${f.x2}" y2="${f.y2}" stroke-width="${w}" stroke-linecap="${cap}"/>`
  }
  if (f.kind === 'arc' && f.x1 != null && f.cx != null) {
    const sym = syms[f.symbol]
    const w = sym?.d ?? Math.min(sym?.w ?? 1, sym?.h ?? 1)
    const r = Math.hypot(f.x1 - f.cx, f.y1! - f.cy!)
    if (r < 1e-6) {
      return odbFeatureToSvg({ kind: 'pad', symbol: f.symbol, polarity: 'P', x: f.x1, y: f.y1 }, syms)
    }
    const a1 = Math.atan2(f.y1! - f.cy!, f.x1 - f.cx!)
    const a2 = Math.atan2(f.y2! - f.cy!, f.x2! - f.cx!)
    let da = a2 - a1
    while (da > Math.PI) da -= 2 * Math.PI
    while (da < -Math.PI) da += 2 * Math.PI
    const steps = 32
    const pts: number[][] = []
    for (let s = 0; s <= steps; s++) {
      const a = a1 + (da * s) / steps
      pts.push([f.cx + Math.cos(a) * r, f.cy! + Math.sin(a) * r])
    }
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]} ${p[1]}`).join(' ')
    return `<path d="${d}" fill="none" stroke-width="${w}" stroke-linecap="round"/>`
  }
  if (f.kind === 'surface' && f.poly && f.poly.length >= 3) {
    let d = polygonPath(f.poly)
    if (f.holes) for (const h of f.holes) if (h.length >= 3) d += ' ' + polygonPath(h)
    return `<path fill-rule="evenodd" d="${d}"/>`
  }
  return ''
}

/** ODB++ 层 → 矢量 SVG 字符串（viewBox=全局板框，Y 翻转与渲染管线一致） */
export function renderOdbToSvg(layer: OdbLayer, g: GlobalBox, color: string): string {
  const parts: string[] = []
  for (const f of layer.features) {
    const s = odbFeatureToSvg(f, layer.symbols)
    if (s) parts.push(s)
  }
  const H = 2 * g.minY + g.h
  return `<svg xmlns="${NS}" xmlns:xlink="${XLINK}" viewBox="${g.minX} ${g.minY} ${g.w} ${g.h}">` +
    `<g transform="translate(0 ${H}) scale(1 -1)" fill="${color}" stroke="${color}">${parts.join('')}</g></svg>`
}

// ---------- Gerber：把 gerber-to-svg 输出预处理为 svg2pdf 可用的纯矢量 ----------
/**
 * 预处理 gerber-to-svg 输出：
 *  1) `<use>` 展开（gerber-to-svg 用 use 复用焊盘定义）；
 *  2) `<mask>`（负极性 clear 挖空）展平为 evenodd 内孔路径；
 *  3) viewBox 改为全局板框 g、Y 翻转 translate 同步；
 *  4) currentColor → 图层颜色。
 */
function prepareGerberSvg(svgStr: string, color: string, g: GlobalBox): Element {
  const doc = new DOMParser().parseFromString(svgStr, 'image/svg+xml')
  const svg = doc.documentElement

  // 1) use 展开
  for (const use of [...svg.querySelectorAll('use')]) {
    const href = use.getAttribute('href') || use.getAttributeNS(XLINK, 'href')
    if (!href) continue
    const ref = svg.querySelector(href)
    if (!ref) continue
    const x = parseFloat(use.getAttribute('x') || '0')
    const y = parseFloat(use.getAttribute('y') || '0')
    const gWrap = doc.createElementNS(NS, 'g')
    gWrap.setAttribute('transform', `translate(${x} ${y})`)
    gWrap.appendChild(ref.cloneNode(true))
    use.replaceWith(gWrap)
  }

  // 2) mask 展平：挖空图形（mask 内非 #fff 的 shape）合并进引用元素，靠 evenodd 挖空
  for (const mask of [...svg.querySelectorAll('mask')]) {
    const id = mask.getAttribute('id')
    const holes: Element[] = []
    for (const el of mask.querySelectorAll('path,circle,rect,ellipse,polygon,polyline')) {
      if (el.getAttribute('fill') === '#fff') continue
      holes.push(el)
    }
    if (id) {
      for (const user of [...svg.querySelectorAll(`[mask="url(#${id})"]`)]) {
        user.removeAttribute('mask')
        for (const h of holes) {
          const c = h.cloneNode(true) as Element
          c.removeAttribute('fill')
          c.removeAttribute('stroke')
          user.appendChild(c)
        }
      }
    }
    mask.remove()
  }

  // 3) viewBox → 全局板框 g
  svg.setAttribute('viewBox', `${g.minX} ${g.minY} ${g.w} ${g.h}`)

  // 4) Y 翻转 translate 同步（translate(0, H) scale(1,-1) 的 H 改为 2*g.minY+g.h）
  const H = 2 * g.minY + g.h
  for (const el of [...svg.querySelectorAll('g')]) {
    const t = el.getAttribute('transform') || ''
    if (/scale\(1[ ,]-1\)/.test(t)) {
      el.setAttribute('transform', t.replace(/translate\([^)]*\)/, `translate(0 ${H})`))
    }
  }

  // 5) currentColor → 颜色
  for (const el of [...svg.querySelectorAll('*')]) {
    if (el.getAttribute('fill') === 'currentColor') el.setAttribute('fill', color)
    if (el.getAttribute('stroke') === 'currentColor') el.setAttribute('stroke', color)
  }
  svg.setAttribute('color', color)

  return svg
}

/** 统一：把某个导出图层转成 svg2pdf 可消费的 SVG 根元素 */
function layerToSvgElement(layer: PdfLayer, g: GlobalBox): Element {
  if (layer.odb) {
    const str = renderOdbToSvg(layer.odb, g, layer.color)
    return new DOMParser().parseFromString(str, 'image/svg+xml').documentElement
  }
  if (layer.svg) return prepareGerberSvg(layer.svg, layer.color, g)
  throw new Error('图层缺少可导出的矢量数据')
}

// ---------- 文字（中文安全，canvas 位图） ----------
function renderTextDataUrl(text: string, px: number, color: string): { url: string; w: number; h: number } {
  const font = `${px}px Georgia, "Microsoft YaHei", "SimSun", sans-serif`
  const measure = document.createElement('canvas').getContext('2d')!
  measure.font = font
  const tw = Math.ceil(measure.measureText(text).width)
  const pad = px * 0.4
  const w = tw + pad * 2
  const h = px * 1.35
  const scale = 3 // 超采样保证清晰
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(w * scale)
  canvas.height = Math.ceil(h * scale)
  const ctx = canvas.getContext('2d')!
  ctx.scale(scale, scale)
  ctx.font = font
  ctx.fillStyle = color
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(text, pad, px * 0.95)
  return { url: canvas.toDataURL('image/png'), w, h }
}

const px2mm = (px: number) => (px / 96) * 25.4

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 导出图层为矢量 PDF 并触发下载 */
export async function exportLayersPdf(
  layers: PdfLayer[],
  opts: { g: GlobalBox; layout: PdfLayout; title: string },
): Promise<void> {
  if (layers.length === 0) return
  const { g } = opts
  const aspect = g.w / g.h || 1

  const { jsPDF } = await import('jspdf')
  const { svg2pdf } = await import('svg2pdf.js')

  const labelColor = '#1f3a5f'

  let doc: JsPDF

  if (opts.layout === 'perPage') {
    const longMm = 240
    const marginMm = 10
    const imgWmm = aspect >= 1 ? longMm : longMm * aspect
    const imgHmm = aspect >= 1 ? longMm / aspect : longMm
    const topMm = 28 // 标题文字(20,20)下方留白
    const pw = imgWmm + marginMm * 2
    const ph = topMm + imgHmm + marginMm
    const orientation = pw >= ph ? 'landscape' : 'portrait'
    doc = new jsPDF({ orientation, unit: 'mm', format: [pw, ph], compress: true })

    for (let i = 0; i < layers.length; i++) {
      if (i > 0) doc.addPage([pw, ph], orientation)
      const layer = layers[i]
      const svgEl = layerToSvgElement(layer, g)
      await svg2pdf(svgEl, doc, {
        x: (pw - imgWmm) / 2,
        y: topMm,
        width: imgWmm,
        height: imgHmm,
      })
      // 层名文字：左上角 (20,20)
      const t = renderTextDataUrl(layer.name, 15, labelColor)
      doc.addImage(t.url, 'PNG', 20, 20, px2mm(t.w), px2mm(t.h))
    }
  } else {
    // grid：A4 横向单页，各层矢量网格排布 + 层名标签
    const pw = 297
    const ph = 210
    doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true })

    const margin = 10
    const titleH = 28
    const gap = 3
    const labelH = 5
    const n = layers.length
    const cols = Math.ceil(Math.sqrt(n))
    const rows = Math.ceil(n / cols)
    const aw = pw - margin * 2
    const ah = ph - margin - titleH
    const imgW = Math.min((aw - (cols - 1) * gap) / cols, ((ah - rows * labelH - (rows - 1) * gap) / rows) * aspect)
    const imgH = imgW / aspect
    const gridW = cols * imgW + (cols - 1) * gap
    const gridH = rows * (imgH + labelH) + (rows - 1) * gap
    const x0 = (pw - gridW) / 2
    const y0 = titleH + (ah - gridH) / 2

    // 标题
    const t = renderTextDataUrl(opts.title, 15, labelColor)
    doc.addImage(t.url, 'PNG', 20, 20, px2mm(t.w), px2mm(t.h))

    for (let i = 0; i < n; i++) {
      const col = i % cols
      const row = Math.floor(i / cols)
      const x = x0 + col * (imgW + gap)
      const y = y0 + row * (imgH + labelH + gap)
      const svgEl = layerToSvgElement(layers[i], g)
      await svg2pdf(svgEl, doc, { x, y, width: imgW, height: imgH })
      const lbl = renderTextDataUrl(layers[i].name, 9, labelColor)
      doc.addImage(lbl.url, 'PNG', x + imgW / 2 - px2mm(lbl.w) / 2, y + imgH + 0.5, px2mm(lbl.w), px2mm(lbl.h))
    }
  }

  const name = opts.title.replace(/\s+/g, '-') || 'pcb-layers'
  doc.save(`${name}-${stamp()}.pdf`)
}
