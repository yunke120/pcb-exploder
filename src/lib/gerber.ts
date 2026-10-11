// Gerber(RS-274X) -> SVG -> three.js 纹理 的转换与跨层对齐。
// 关键：gerber-to-svg 输出的 viewBox 以 1000×Gerber 单位表示，
// 其 min-x/min-y 为各层在板坐标系中的真实偏移，可用于跨层精准叠合。
import * as THREE from 'three'

// gerber-to-svg 以 UMD 全局脚本（public/gerber-to-svg.min.js + index.html <script>）形式加载，
// 运行时挂载于 window.gerberToSvg，避免 Node 流依赖（events/readable-stream）在浏览器中缺失。
type GerberToSvgFn = (
  gerber: string,
  options?: Record<string, unknown>,
  done?: (err: Error | null, svg: string) => void,
) => unknown

function getGerberToSvg(): GerberToSvgFn {
  const g = (globalThis as unknown as { gerberToSvg?: GerberToSvgFn }).gerberToSvg
  if (!g) throw new Error('gerber-to-svg 未加载，请确认 public/gerber-to-svg.min.js 已随页面加载')
  return g
}

export interface ViewBox {
  minX: number
  minY: number
  w: number
  h: number
}

export interface GlobalBox {
  minX: number
  minY: number
  w: number
  h: number
}

/** 将 Gerber 文本转换为 SVG 字符串（回调式封装） */
export function parseGerberToSvg(text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    getGerberToSvg()(
      text,
      { id: 'pcb-layer' },
      (err: Error | null, svg: string) => {
        if (err) reject(err)
        else resolve(svg)
      },
    )
  })
}

/** 解析 SVG 的 viewBox（1000×Gerber 单位） */
export function getViewBox(svg: string): ViewBox {
  const m = svg.match(/viewBox="([-\d.\s]+)"/)
  if (m) {
    const [minX, minY, w, h] = m[1].trim().split(/\s+/).map(Number)
    return { minX, minY, w, h }
  }
  return { minX: 0, minY: 0, w: 1000, h: 1000 }
}

/** 由若干 viewBox 计算全局板框，用于跨层对齐 */
export function computeGlobalBox(vbs: ViewBox[]): GlobalBox {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const v of vbs) {
    minX = Math.min(minX, v.minX)
    minY = Math.min(minY, v.minY)
    maxX = Math.max(maxX, v.minX + v.w)
    maxY = Math.max(maxY, v.minY + v.h)
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, w: 1000, h: 1000 }
  return { minX, minY, w: maxX - minX, h: maxY - minY }
}

/**
 * 将单个图层 SVG 渲染为 three.js 纹理。
 * 依据全局板框把该层内容绘制到与板框同比例的画布上，
 * 透明区域保留，从而各层平面尺寸一致、内容精准对齐。
 */
export function renderLayerTexture(
  svg: string,
  vb: ViewBox,
  g: GlobalBox,
  aspect: number,
  color: string,
): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    // 设置 px 尺寸（供 canvas 拉伸），并按图层颜色着色 currentColor
    let s = svg.replace(/\swidth="[^"]*"/, ` width="${Math.round(vb.w)}"`)
    s = s.replace(/\sheight="[^"]*"/, ` height="${Math.round(vb.h)}"`)
    s = s.replace(/(<svg[^>]*)/, `$1 color="${color}" style="color:${color}"`)

    const blob = new Blob([s], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      const maxTex = 1024
      const cw = aspect >= 1 ? maxTex : Math.round(maxTex * aspect)
      const ch = aspect >= 1 ? Math.round(maxTex / aspect) : maxTex
      const canvas = document.createElement('canvas')
      canvas.width = cw
      canvas.height = ch
      const ctx = canvas.getContext('2d')!
      ctx.clearRect(0, 0, cw, ch)
      const scale = cw / g.w
      const dx = (vb.minX - g.minX) * scale
      const dy = (vb.minY - g.minY) * scale
      const dw = vb.w * scale
      const dh = vb.h * scale
      ctx.drawImage(img, dx, dy, dw, dh)
      const tex = new THREE.CanvasTexture(canvas)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = 8
      tex.needsUpdate = true
      URL.revokeObjectURL(url)
      resolve(tex)
    }
    img.onerror = (e) => {
      URL.revokeObjectURL(url)
      reject(e)
    }
    img.src = url
  })
}
