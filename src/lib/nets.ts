// 网络：一层内相互连通的铜图元集合（用于网络高亮与最小间距计算）。
// 网络重建逻辑见 odb.ts 的 computeOdbNets（种子点直接绑定网名）。

export interface Net {
  id: number
  name: string
  /** 该网络包含的图元索引（相对 layer.features） */
  primitiveIdxs: number[]
  /** 是否已绑定真实网名（explicit=true 为 ODB++ netlist 网名，false 为合成名 Net N） */
  explicit: boolean
}
