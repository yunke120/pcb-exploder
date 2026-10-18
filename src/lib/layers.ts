// 图层类型、堆叠顺序与配色定义（ODB++ 等解析器共用）。

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

/** 取得某图层类型的标准配色（ODB++ 解析器复用） */
export function layerColor(kind: LayerKind): string {
  return COLOR[kind] ?? '#9aa7b4'
}

/**
 * 按真实堆叠顺序（从上至下）比较两个图层，用于图纸/PDF 的页序。
 *
 * 依据 ODB++ matrix 的 ROW：ROW 从小到大的顺序即物理叠层由上至下，例如
 *   ROW=2 TOPOVERLAY（顶层丝印） → ROW=5 TOP（顶层铜箔） → … → ROW=14 BOTTOM → ROW=17 BOTTOMOVERLAY（底层丝印）。
 * 注意：LayerMeta.order 是“三维视图里的视觉叠放”提示（数值越小越靠下），
 * 与物理叠层方向相反，不能直接用来排序图纸页序。
 */
export function compareStackOrder(
  a: { row: number; name: string },
  b: { row: number; name: string },
): number {
  if (a.row !== b.row) return a.row - b.row
  // 同一 ROW 时按名称稳定排序，避免顺序抖动
  return a.name.localeCompare(b.name)
}
