import { useMemo, useState } from 'react'
import type { LayerItem } from '../App'

interface Props {
  items: LayerItem[]
  selected: Set<string>
  onToggle: (key: string) => void
  onClear: () => void
}

export default function NetPanel({ items, selected, onToggle, onClear }: Props) {
  const [query, setQuery] = useState('')

  const layersWithNets = useMemo(
    () => items.filter((i) => i.nets && i.nets.length > 0),
    [items],
  )

  const q = query.trim().toLowerCase()
  const totalNets = layersWithNets.reduce((s, l) => s + (l.nets?.length ?? 0), 0)
  const selectedCount = selected.size

  if (layersWithNets.length === 0) return null

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
        {layersWithNets.map((layer) => {
          const nets = (layer.nets ?? []).filter((n) =>
            q ? n.name.toLowerCase().includes(q) || layer.meta.name.toLowerCase().includes(q) : true,
          )
          if (nets.length === 0) return null
          return (
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
                    <span className="net-name">{net.name}</span>
                    {net.explicit && <span className="net-tag">X2</span>}
                    <span className="net-sub">{net.primitiveIdxs.length}</span>
                  </label>
                )
              })}
            </div>
          )
        })}
      </div>
      <div className="net-hint">勾选网络后，对应铜层上将以高亮色描出该网络</div>
    </div>
  )
}
