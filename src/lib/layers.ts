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
