// 共享几何类型：板框 / 图层包围盒与全局板框计算。
// 单位：mm（与 odb.ts 解析约定一致）。

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
