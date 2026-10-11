import { useMemo, useState } from 'react'
import type { LayerItem, MergedNet } from '../App'
import type { SpacingResult } from '../lib/spacing'

interface Props {
  items: LayerItem[]
  mergedNets: MergedNet[]
  selected: Set<string>
  /** 每个网络 key 对应的高亮颜色 */
  colors: Record<string, string>
  onToggle: (key: string) => void
  onClear: () => void
  onComputeSpacing: () => void
  spacingResults: SpacingResult[]
  /** 是否已执行过间距计算（用于区分「未计算」与「计算后无共同层」） */
  spacingComputed: boolean
}

export default function NetPanel({
  items,
  mergedNets,
  selected,
  colors,
  onToggle,
  onClear,
  onComputeSpacing,
  spacingResults,
  spacingComputed,
}: Props) {
  const [query, setQuery] = useState('')

  // 各层中“未命名（非显式）”的网络，仍按层单独展示
  const nonExplicit = useMemo(
    () =>
      items
        .filter((i) => i.nets && i.nets.some((n) => !n.explicit))
        .map((layer) => ({ layer, nets: layer.nets!.filter((n) => !n.explicit) })),
    [items],
  )

  const q = query.trim().toLowerCase()
  const totalNets = mergedNets.length + nonExplicit.reduce((s, l) => s + l.nets.length, 0)
  const selectedCount = selected.size

  if (totalNets === 0) return null

  const mergedRows = mergedNets.filter((m) => !q || m.name.toLowerCase().includes(q))
  const nonExp = nonExplicit
    .map(({ layer, nets }) => ({
      layer,
      nets: nets.filter(
        (n) => !q || n.name.toLowerCase().includes(q) || layer.meta.name.toLowerCase().includes(q),
      ),
    }))
    .filter((g) => g.nets.length > 0)

  if (mergedRows.length === 0 && nonExp.length === 0) {
    return (
      <div className="section net-panel">
        <div className="section-title">
          网络高亮
          <span className="net-count">{totalNets} 个网络</span>
        </div>
        <input
          className="net-search"
          placeholder="搜索网络名 / 层…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="net-hint">没有匹配 “{query}” 的网络</div>
      </div>
    )
  }

  return (
    <div className="section net-panel">
      <div className="section-title">
        网络高亮
        <span className="net-count">
          {selectedCount > 0 ? `${selectedCount} 已选` : `${totalNets} 个网络`}
        </span>
        {selectedCount > 0 && (
          <button className="link-btn" onClick={onClear}>
            清除
          </button>
        )}
      </div>

      <input
        className="net-search"
        placeholder="搜索网络名 / 层…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="net-list">
        {mergedRows.length > 0 && (
          <>
            <div className="net-group-title">
              按名称合并（跨层）
              <span className="net-layer-sub">{mergedRows.length}</span>
            </div>
            {mergedRows.map((m) => {
              const key = m.name
              const checked = selected.has(key)
              return (
                <label className="net-row" key={key}>
                  <input type="checkbox" checked={checked} onChange={() => onToggle(key)} />
                  <span
                    className="net-color"
                    style={{ background: colors[key] ?? '#16f0ff' }}
                    title="高亮颜色"
                  />
                  <span className="net-name" title={m.members.map((mm) => mm.layerName).join('、')}>
                    {m.name}
                  </span>
                  <span className="net-tag">X2</span>
                  {m.members.length > 1 && (
                    <span className="net-layer-sub" title={m.members.map((mm) => mm.layerName).join('、')}>
                      ×{m.members.length} 层
                    </span>
                  )}
                  <span className="net-sub">{m.totalCount}</span>
                </label>
              )
            })}
          </>
        )}

        {nonExp.map(({ layer, nets }) => (
          <div className="net-layer" key={layer.id}>
            <div className="net-layer-name" style={{ borderLeftColor: layer.meta.color }}>
              {layer.meta.name}
              <span className="net-layer-sub">{nets.length}</span>
            </div>
            {nets.map((net) => {
              const key = `${layer.id}::${net.id}`
              const checked = selected.has(key)
              return (
                <label className="net-row" key={key}>
                  <input type="checkbox" checked={checked} onChange={() => onToggle(key)} />
                  <span
                    className="net-color"
                    style={{ background: colors[key] ?? '#16f0ff' }}
                    title="高亮颜色"
                  />
                  <span className="net-name">{net.name}</span>
                  <span className="net-sub">{net.primitiveIdxs.length}</span>
                </label>
              )
            })}
          </div>
        ))}
      </div>

      {selected.size === 2 && (
        <div className="spacing-box">
          <button className="btn primary spacing-btn" onClick={onComputeSpacing}>
            计算最小间距
          </button>
          {spacingResults.length > 0 ? (
            <ul className="spacing-list">
              {spacingResults.map((r) => (
                <li key={r.layerId}>
                  <span className="spacing-layer">{r.layerName}</span>
                  <span className="spacing-dist">{formatMm(r.distance)} mm</span>
                </li>
              ))}
            </ul>
          ) : spacingComputed ? (
            <div className="spacing-empty">两网络无共同出现的层</div>
          ) : (
            <div className="spacing-hint">
              勾选 2 个网络后点击计算，将自动求两网在每一层的最小间距（仅两网同时出现的层），并在图中标注最近点。
            </div>
          )}
        </div>
      )}

      <div className="net-hint">勾选网络后，对应铜层上将以各自专属颜色高亮该网络；不同网络使用不同颜色（同层也可叠加多个），跨层同名网络共享同一颜色</div>
    </div>
  )
}

function formatMm(v: number): string {
  if (v >= 100) return v.toFixed(1)
  if (v >= 1) return v.toFixed(2)
  return v.toFixed(3)
}
