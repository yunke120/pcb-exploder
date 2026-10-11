import type { LayerItem } from '../App'

interface Props {
  items: LayerItem[]
  visible: Set<string>
  onToggle: (id: string) => void
  explosion: number
  setExplosion: (v: number) => void
  showLabels: boolean
  setShowLabels: (v: boolean) => void
}

export default function LayerPanel({
  items,
  visible,
  onToggle,
  explosion,
  setExplosion,
  showLabels,
  setShowLabels,
}: Props) {
  const renderable = items.filter((i) => i.texture)
  const others = items.filter((i) => !i.texture)

  return (
    <div>
      <div className="section">
        <h2>爆炸间距</h2>
        <div className="row">
          <input
            type="range"
            min={0}
            max={4}
            step={0.05}
            value={explosion}
            onChange={(e) => setExplosion(parseFloat(e.target.value))}
          />
          <span style={{ width: 38, textAlign: 'right' }}>{explosion.toFixed(2)}×</span>
        </div>
        <label className="row" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={showLabels}
            onChange={(e) => setShowLabels(e.target.checked)}
          />
          显示图层标签
        </label>
      </div>

      <div className="section">
        <h2>平面图层 ({renderable.length})</h2>
        {renderable.length === 0 && <div className="meta">尚未导入可渲染的 Gerber 层</div>}
        {renderable.map((i) => (
          <div className="layer-row" key={i.id}>
            <input type="checkbox" checked={visible.has(i.id)} onChange={() => onToggle(i.id)} />
            <span className="swatch" style={{ background: i.meta.color }} />
            <span className="name">{i.meta.name}</span>
          </div>
        ))}
      </div>

      {others.length > 0 && (
        <div className="section">
          <h2>其他文件 ({others.length})</h2>
          {others.map((i) => (
            <div className="layer-row" key={i.id}>
              <span className="swatch" style={{ background: i.meta.color, opacity: 0.5 }} />
              <span className="name">{i.meta.name}</span>
              <span className="meta">{i.meta.kind === 'drill' ? '钻孔' : '板框'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
