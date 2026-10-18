import { useMemo, useState } from 'react'
import type { LayerItem } from '../App'
import Collapsible, { usePersistentOpen } from './Collapsible'

interface Props {
  items: LayerItem[]
  visible: Set<string>
  onToggle: (id: string) => void
  explosion: number
  setExplosion: (v: number) => void
  showLabels: boolean
  setShowLabels: (v: boolean) => void
  viewMode: 'exploded' | 'flat'
  setViewMode: (v: 'exploded' | 'flat') => void
}

export default function LayerPanel({
  items,
  visible,
  onToggle,
  explosion,
  setExplosion,
  showLabels,
  setShowLabels,
  viewMode,
  setViewMode,
}: Props) {
  const renderable = items.filter((i) => i.texture)
  const others = items.filter((i) => !i.texture)

  // 图层较多时提供筛选，避免长列表刷屏
  const [layerQuery, setLayerQuery] = useState('')
  const lq = layerQuery.trim().toLowerCase()
  const shownLayers = useMemo(
    () => (lq ? renderable.filter((i) => i.meta.name.toLowerCase().includes(lq)) : renderable),
    [renderable, lq],
  )

  const visibleCount = renderable.filter((i) => visible.has(i.id)).length
  const allVisible = renderable.length > 0 && visibleCount === renderable.length

  /** 批量显示 / 隐藏所有可渲染图层 */
  const toggleAll = () => {
    if (allVisible) renderable.forEach((i) => visible.has(i.id) && onToggle(i.id))
    else renderable.forEach((i) => !visible.has(i.id) && onToggle(i.id))
  }

  const viewPanel = usePersistentOpen('view')
  const layerPanel = usePersistentOpen('layers', false)
  const otherPanel = usePersistentOpen('others', false)

  return (
    <>
      <Collapsible title="视图" open={viewPanel.open} onOpenChange={viewPanel.setOpen}>
        <div className="field">
          <span className="field__label">视图模式</span>
          <div className="seg" role="group" aria-label="视图模式">
            <button
              type="button"
              className={`seg-btn ${viewMode === 'exploded' ? 'active' : ''}`}
              aria-pressed={viewMode === 'exploded'}
              onClick={() => setViewMode('exploded')}
              title="各层沿 Z 轴等距层叠展开"
            >
              爆炸展开
            </button>
            <button
              type="button"
              className={`seg-btn ${viewMode === 'flat' ? 'active' : ''}`}
              aria-pressed={viewMode === 'flat'}
              onClick={() => setViewMode('flat')}
              title="各层在同一平面内按网格铺开"
            >
              平面展开
            </button>
          </div>
        </div>

        <div className="field">
          <div className="field__row">
            <span className="field__label">爆炸间距</span>
            <span className="field__value">{explosion.toFixed(2)}×</span>
          </div>
          <input
            type="range"
            aria-label="爆炸间距"
            min={0}
            max={4}
            step={0.05}
            value={explosion}
            disabled={viewMode === 'flat'}
            onChange={(e) => setExplosion(parseFloat(e.target.value))}
          />
          {viewMode === 'flat' && (
            <div className="hint">平面展开模式下各层并排铺开，无需调整爆炸间距。</div>
          )}
        </div>

        <label className="check-row">
          <input
            type="checkbox"
            checked={showLabels}
            onChange={(e) => setShowLabels(e.target.checked)}
          />
          <span>显示图层标签</span>
        </label>
      </Collapsible>

      <Collapsible
        title="平面图层"
        badge={`${visibleCount}/${renderable.length}`}
        open={layerPanel.open}
        onOpenChange={layerPanel.setOpen}
        actions={
          renderable.length > 0 ? (
            <button type="button" className="link-btn" onClick={toggleAll}>
              {allVisible ? '全不选' : '全选'}
            </button>
          ) : null
        }
      >
        {renderable.length === 0 ? (
          <div className="empty">尚未导入可渲染的 ODB++ 层</div>
        ) : (
          <>
            {renderable.length > 6 && (
              <input
                className="input input--search"
                type="search"
                placeholder="筛选图层…"
                aria-label="筛选图层"
                value={layerQuery}
                onChange={(e) => setLayerQuery(e.target.value)}
              />
            )}
            <div className="list list--layers">
              {shownLayers.map((i) => (
                <label className="layer-row" key={i.id}>
                  <input
                    type="checkbox"
                    checked={visible.has(i.id)}
                    onChange={() => onToggle(i.id)}
                  />
                  <span className="swatch" style={{ background: i.meta.color }} aria-hidden="true" />
                  <span className="name" title={i.meta.name}>
                    {i.meta.name}
                  </span>
                </label>
              ))}
              {shownLayers.length === 0 && <div className="empty">没有匹配的图层</div>}
            </div>
          </>
        )}
      </Collapsible>

      {others.length > 0 && (
        <Collapsible
          title="其他文件"
          badge={others.length}
          open={otherPanel.open}
          onOpenChange={otherPanel.setOpen}
        >
          <div className="list list--layers">
            {others.map((i) => (
              <div className="layer-row layer-row--static" key={i.id}>
                <span
                  className="swatch swatch--dim"
                  style={{ background: i.meta.color }}
                  aria-hidden="true"
                />
                <span className="name" title={i.meta.name}>
                  {i.meta.name}
                </span>
                <span className="tag">{i.meta.kind === 'drill' ? '钻孔' : '板框'}</span>
              </div>
            ))}
          </div>
        </Collapsible>
      )}
    </>
  )
}
