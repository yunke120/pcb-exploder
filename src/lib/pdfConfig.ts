// 图纸 PDF 页边距配置（渲染进程侧）。
//
// 配置来源优先级：
//   1. Electron 预加载脚本暴露的 window.pcbExploder.getPdfMargins()（读取程序目录旁 pdf-config.json）
//   2. 开发/浏览器模式：直接 fetch 项目根目录下的 public/pdf-config.json
//   3. 均不可用：使用内置默认值 0.2mm
//
// 四个数值单位均为 mm，表示在板框四周额外增加的长度。

export interface PdfMargins {
  top: number
  bottom: number
  left: number
  right: number
}

/** 默认边距：四向各 0.2mm */
export const DEFAULT_MARGIN_MM = 0.2

export const DEFAULT_MARGINS: PdfMargins = {
  top: DEFAULT_MARGIN_MM,
  bottom: DEFAULT_MARGIN_MM,
  left: DEFAULT_MARGIN_MM,
  right: DEFAULT_MARGIN_MM,
}

/** 预加载脚本注入的桥接对象 */
interface PcbExploderBridge {
  getPdfMargins?: () => Promise<{ margins?: Partial<PdfMargins>; source?: string | null }>
}

function bridge(): PcbExploderBridge | undefined {
  return (window as unknown as { pcbExploder?: PcbExploderBridge }).pcbExploder
}

/** 把任意输入规整为非负有限数（mm），非法值回退到默认 */
function normalize(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN
  if (!Number.isFinite(n) || n < 0) return fallback
  return n
}

/** 把部分/未知结构规整为完整边距对象 */
export function normalizeMargins(input: unknown): PdfMargins {
  const src = (input ?? {}) as Record<string, unknown>
  // 兼容 { margins: {...} } 包裹写法
  const flat = (src.margins ?? src) as Record<string, unknown>
  return {
    top: normalize(flat.top, DEFAULT_MARGINS.top),
    bottom: normalize(flat.bottom, DEFAULT_MARGINS.bottom),
    left: normalize(flat.left, DEFAULT_MARGINS.left),
    right: normalize(flat.right, DEFAULT_MARGINS.right),
  }
}

/**
 * 读取 PDF 边距配置。任何失败都回退到默认值，绝不阻断导出。
 * 返回实际生效的边距（mm）。
 */
export async function loadPdfMargins(): Promise<PdfMargins> {
  // 1) Electron：通过预加载桥读取程序目录旁的 pdf-config.json
  try {
    const b = bridge()
    if (b?.getPdfMargins) {
      const res = await b.getPdfMargins()
      if (res && res.margins) return normalizeMargins(res.margins)
    }
  } catch (e) {
    console.warn('读取 Electron 端 pdf-config 失败，回退默认边距：', e)
  }

  // 2) 开发/浏览器模式：读取 public/pdf-config.json
  try {
    const url = new URL('pdf-config.json', document.baseURI).href
    const resp = await fetch(url, { cache: 'no-store' })
    if (resp.ok) return normalizeMargins(await resp.json())
  } catch (e) {
    console.warn('读取 pdf-config.json 失败，回退默认边距：', e)
  }

  // 3) 内置默认值
  return { ...DEFAULT_MARGINS }
}
