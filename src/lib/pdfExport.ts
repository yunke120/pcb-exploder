// PDF 导出：把各渲染好的图层纹理（CanvasTexture.image）排版为 PDF。
// 采用「canvas 绘制文字 + jsPDF 仅嵌入位图」的方式，中文层名由浏览器渲染，
// 规避 jsPDF 内置 14 字体不含 CJK 的乱码问题。
// jsPDF 以动态 import 懒加载，避免把 html2canvas 等可选依赖打进主包。
import type { jsPDF as JsPDF } from 'jspdf'

export interface PdfLayer {
  /** 图层显示名（含中文） */
  name: string
  /** 该层渲染好的画布（与 three.js 纹理同源，透明底 + 图层着色） */
  canvas: HTMLCanvasElement
}

export type PdfLayout = 'grid' | 'perPage'

/** 白色底板（打印友好）；深色文字 */
const BG = '#ffffff'
const FG = '#1f3a5f'
const MUTED = '#6b7a8a'
/** 导出分辨率（150 DPI，打印足够清晰且体积可控） */
const DPI = 150
/** 中文友好的字体栈（Win7 含微软雅黑/宋体） */
const FONT = 'Georgia, "Microsoft YaHei", "SimSun", "Noto Serif CJK SC", serif'

const mm2px = (mm: number) => Math.max(1, Math.round((mm / 25.4) * DPI))

/** 图层画布：合成深色底板 + 降采样到目标长边（控制 PDF 体积） */
function prepareLayer(canvas: HTMLCanvasElement, maxSide: number): HTMLCanvasElement {
  const long = Math.max(canvas.width, canvas.height)
  const s = Math.min(1, maxSide / long)
  const w = Math.max(1, Math.round(canvas.width * s))
  const h = Math.max(1, Math.round(canvas.height * s))
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const c = out.getContext('2d')!
  c.fillStyle = BG
  c.fillRect(0, 0, w, h)
  c.drawImage(canvas, 0, 0, w, h)
  return out
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 平面网格单页（等同「平面展开」视图）：A4 横向，各层按网格铺开，每层下方标层名 */
function renderGridPage(layers: PdfLayer[], aspect: number, title: string): HTMLCanvasElement {
  const w = mm2px(297)
  const h = mm2px(210)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, w, h)

  const margin = mm2px(10)
  const titleH = mm2px(16)
  const gap = mm2px(3)
  const labelH = mm2px(6)

  // 标题与副标题
  ctx.fillStyle = FG
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.font = `bold ${mm2px(6)}px ${FONT}`
  ctx.fillText(title, margin, margin + mm2px(5))
  ctx.fillStyle = MUTED
  ctx.font = `${mm2px(3.6)}px ${FONT}`
  ctx.fillText(
    `${layers.length} 层 · 板框 ${aspect >= 1 ? '横向' : '纵向'} ${aspect.toFixed(3)} · ${stamp()}`,
    margin,
    margin + mm2px(9.5),
  )

  const n = layers.length
  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  const aw = w - margin * 2
  const ah = h - margin * 2 - titleH

  // 单个图层图片尺寸（保持板框宽高比）
  const imgW = Math.min(
    (aw - (cols - 1) * gap) / cols,
    ((ah - rows * labelH - (rows - 1) * gap) / rows) * aspect,
  )
  const imgH = imgW / aspect

  const gridW = cols * imgW + (cols - 1) * gap
  const gridH = rows * (imgH + labelH) + (rows - 1) * gap
  const x0 = (w - gridW) / 2
  const y0 = margin + titleH + (ah - gridH) / 2

  const maxSide = Math.max(1, Math.round(Math.max(imgW, imgH)))
  for (let i = 0; i < n; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const x = x0 + col * (imgW + gap)
    const y = y0 + row * (imgH + labelH + gap)
    ctx.drawImage(prepareLayer(layers[i].canvas, maxSide), x, y, imgW, imgH)
    ctx.fillStyle = FG
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `${mm2px(3)}px ${FONT}`
    ctx.fillText(layers[i].name, x + imgW / 2, y + imgH + labelH / 2)
  }

  return canvas
}

/** 每层一页：页面尺寸按板框宽高比设置，顶部标层名，图片铺满 */
function renderLayerPage(layer: PdfLayer, aspect: number): HTMLCanvasElement {
  const longMm = 250
  const marginMm = 10
  const titleHmm = 12
  const imgWmm = aspect >= 1 ? longMm : longMm * aspect
  const imgHmm = aspect >= 1 ? longMm / aspect : longMm
  const w = mm2px(imgWmm + marginMm * 2)
  const h = mm2px(imgHmm + titleHmm + marginMm * 2)

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, w, h)

  ctx.fillStyle = FG
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.font = `bold ${mm2px(5)}px ${FONT}`
  ctx.fillText(layer.name, mm2px(marginMm), mm2px(marginMm) + mm2px(4))

  const maxSide = Math.max(1, Math.round(mm2px(Math.max(imgWmm, imgHmm))))
  ctx.drawImage(
    prepareLayer(layer.canvas, maxSide),
    mm2px(marginMm),
    mm2px(marginMm + titleHmm),
    mm2px(imgWmm),
    mm2px(imgHmm),
  )

  return canvas
}

/** 导出图层为 PDF 并触发下载 */
export async function exportLayersPdf(
  layers: PdfLayer[],
  opts: { aspect: number; layout: PdfLayout; title: string },
): Promise<void> {
  if (layers.length === 0) return

  const { jsPDF } = await import('jspdf')
  let doc: JsPDF
  if (opts.layout === 'grid') {
    const page = renderGridPage(layers, opts.aspect, opts.title)
    doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true })
    doc.addImage(page.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, 297, 210)
  } else {
    const longMm = 250
    const marginMm = 10
    const titleHmm = 12
    const imgWmm = opts.aspect >= 1 ? longMm : longMm * opts.aspect
    const imgHmm = opts.aspect >= 1 ? longMm / opts.aspect : longMm
    const pw = imgWmm + marginMm * 2
    const ph = imgHmm + titleHmm + marginMm * 2
    const orientation = pw >= ph ? 'landscape' : 'portrait'
    doc = new jsPDF({ orientation, unit: 'mm', format: [pw, ph], compress: true })
    layers.forEach((layer, i) => {
      if (i > 0) doc.addPage([pw, ph], orientation)
      const page = renderLayerPage(layer, opts.aspect)
      doc.addImage(page.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pw, ph)
    })
  }

  const name = opts.title.replace(/\s+/g, '-') || 'pcb-layers'
  doc.save(`${name}-${stamp()}.pdf`)
}
