// Gerber 图层识别：根据扩展名或文件名关键词判定图层类型、堆叠顺序与配色。

export type LayerKind =
  | 'topCopper'
  | 'bottomCopper'
  | 'innerCopper'
  | 'topSolderMask'
  | 'bottomSolderMask'
  | 'topSilkscreen'
  | 'bottomSilkscreen'
  | 'topPaste'
  | 'bottomPaste'
  | 'keepout'
  | 'mechanical'
  | 'component'
  | 'outline'
  | 'drill'
  | 'unknown'

export interface LayerMeta {
  kind: LayerKind
  name: string
  color: string
  /** 堆叠顺序，数值越小越靠下（底层） */
  order: number
  /** 是否为可在 3D 中展开的平面层 */
  renderable: boolean
}

const COLOR: Record<LayerKind, string> = {
  topCopper: '#e08a3c',
  bottomCopper: '#c97a30',
  innerCopper: '#b06a28',
  topSolderMask: '#2f9e54',
  bottomSolderMask: '#278a48',
  topSilkscreen: '#eaeaea',
  bottomSilkscreen: '#dcdcdc',
  topPaste: '#cfcfcf',
  bottomPaste: '#bcbcbc',
  keepout: '#e8556a',
  mechanical: '#8c9aa6',
  component: '#7fd1e0',
  outline: '#ffffff',
  drill: '#8aa0b4',
  unknown: '#9aa7b4',
}

function innerName(n: number) {
  return `内层铜箔 L${n}`
}

/** 取得某图层类型的标准配色（ODB++ 等外部解析器复用） */
export function layerColor(kind: LayerKind): string {
  return COLOR[kind] ?? '#9aa7b4'
}

/**
 * 依据文件名与扩展名识别图层。
 * 支持两类命名：
 *  1) 短扩展名：GTL/GBL/GTS/GBS/GTO/GBO/GTP/GBP/GKO/GM1.. / G1..G9 / GP1.. / IN1.. / DRL / TXT
 *  2) 描述性命名（Altium/KiCad 常见，扩展名多为 .gbr/.ger）：
 *     Copper_Signal_Top / Copper_Signal_Bot / Copper_Signal_1 / Legend_Top /
 *     Paste_Top / Keep-out / Mechanical_1 等
 */
export function identifyLayer(filename: string): LayerMeta {
  const base = filename.toLowerCase().replace(/\.[^.]+$/, '') // 去扩展名
  const ext = (filename.toLowerCase().match(/\.([a-z0-9]+)$/) || ['', ''])[1]

  const make = (kind: LayerKind, name: string, order: number, renderable = true): LayerMeta => ({
    kind,
    name,
    color: COLOR[kind],
    order,
    renderable,
  })

  // 钻孔优先（扩展名或文件名）
  if (ext === 'drl' || (ext === 'txt' && /drill|plated|nc\b/i.test(base)) || /drill|plated.*hole|nc.*drill/i.test(base)) {
    return make('drill', '钻孔 (Drill)', -1, false)
  }

  // 板框 / 外框（扩展名或描述性关键词，含 Mechanical 机械层）
  if (ext === 'gko' || ext === 'gm1' || ext === 'gm2' || ext === 'gm3' || ext === 'gml' || /outline|border|edge|mech|board/i.test(base)) {
    // Mechanical 机械层通常作为非展开的外框/标注；Keep-out 由下方专门处理
    if (/mech|mechanical/i.test(base)) {
      return make('outline', '机械层 / 外框 (Mechanical)', 200, false)
    }
    return make('outline', '板框 / 外框', 200, false)
  }

  // 内层铜箔（短扩展名）
  const inner = ext.match(/^(g|gp|in)(\d+)$/)
  if (inner) {
    const n = parseInt(inner[2], 10)
    return make('innerCopper', innerName(n), 40 + n, true)
  }

  // 短扩展名速查
  switch (ext) {
    case 'gtl':
    case 'cmp':
      return make('topCopper', '顶层铜箔 (Top Copper)', 100)
    case 'gbl':
      return make('bottomCopper', '底层铜箔 (Bottom Copper)', 30)
    case 'gts':
      return make('topSolderMask', '顶层阻焊 (Top Solder Mask)', 110)
    case 'gbs':
      return make('bottomSolderMask', '底层阻焊 (Bottom Solder Mask)', 20)
    case 'gto':
      return make('topSilkscreen', '顶层丝印 (Top Silkscreen)', 120)
    case 'gbo':
      return make('bottomSilkscreen', '底层丝印 (Bottom Silkscreen)', 10)
    case 'gtp':
      return make('topPaste', '顶层钢网 (Top Paste)', 130)
    case 'gbp':
      return make('bottomPaste', '底层钢网 (Bottom Paste)', 25)
  }

  // ---- 描述性命名识别（扩展名多为 .gbr/.ger 时） ----
  const isCopper = /copper|signal|plane|layer|trace/i.test(base)
  const isTop = /\btop\b|top_|_top/i.test(base)
  const isBot = /bot|bottom/i.test(base)

  // 阻焊 / 绿油
  if (/mask|solder|sm\b/i.test(base)) {
    return make(isBot ? 'bottomSolderMask' : 'topSolderMask',
      isBot ? '底层阻焊 (Bottom Solder Mask)' : '顶层阻焊 (Top Solder Mask)',
      isBot ? 20 : 110)
  }

  // 丝印 / 图例
  if (/legend|silk|overlay|print/i.test(base)) {
    return make(isBot ? 'bottomSilkscreen' : 'topSilkscreen',
      isBot ? '底层丝印 (Bottom Silkscreen)' : '顶层丝印 (Top Silkscreen)',
      isBot ? 10 : 120)
  }

  // 钢网 / 锡膏
  if (/paste|stencil|cream/i.test(base)) {
    return make(isBot ? 'bottomPaste' : 'topPaste',
      isBot ? '底层钢网 (Bottom Paste)' : '顶层钢网 (Top Paste)',
      isBot ? 25 : 130)
  }

  // Keep-out 禁止布线层
  if (/keep[.\-_ ]?out|keepout/i.test(base)) {
    return make('keepout', '禁止布线层 (Keep-out)', 60, true)
  }

  // 铜箔层（含内层编号）
  if (isCopper) {
    if (isTop) return make('topCopper', '顶层铜箔 (Top Copper)', 100)
    if (isBot) return make('bottomCopper', '底层铜箔 (Bottom Copper)', 30)
    const numMatch = base.match(/signal[_\- ]*(\d+)|copper[_\- ]*(\d+)|layer[_\- ]*(\d+)|plane[_\- ]*(\d+)/i)
    const n = numMatch ? parseInt(numMatch[1], 10) : 1
    return make('innerCopper', innerName(n), 40 + n, true)
  }

  return make('unknown', `未识别: ${filename}`, 150, true)
}
