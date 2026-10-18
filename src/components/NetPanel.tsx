import { useMemo, useState } from 'react'
import type { MergedNet } from '../App'
import type { SpacingResult } from '../lib/spacing'
import Collapsible, { usePersistentOpen } from './Collapsible'

interface Props {
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

/**
 * 是否需要隐藏该网络名（面板不展示，也不作为可选高亮项）。
 * 规则：以 “Net” 开头的名称一律隐藏——它们是解析器合成的占位名（Net 1、Net 2…），
 * 或网表中无意义的自动编号，对用户没有区分意义。
 */
function isHiddenNetName(name: string): boolean {
  return /^\s*net/i.test(name)
}

export default function NetPanel({
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

  // 只保留“有真实网名的显式网络”，且每个网名只出现一次（跨层已按名称合并）。
  // 解析器为未绑定网名的孤立铜块合成的 “Net N” 不再逐层列出。
  const visibleNets = useMemo(
    () => mergedNets.filter((m) => !isHiddenNetName(m.name)),
    [mergedNets],
  )

  const q = query.trim().toLowerCase()
  const totalNets = visibleNets.length
  const selectedCount = selected.size
  const netPanel = usePersistentOpen('nets', false)

  if (totalNets === 0) return null

  const rows = visibleNets.filter((m) => !q || m.name.toLowerCase().includes(q))

  return (
    <Collapsible
      title="网络高亮"
      badge={selectedCount > 0 ? `已选 ${selectedCount}` : `${totalNets}`}
      open={netPanel.open}
      onOpenChange={netPanel.setOpen}
      actions={
        selectedCount > 0 ? (
          <button type="button" className="link-btn" onClick={onClear}>
            清除
          </button>
        ) : null
      }
    >
      <input
        className="input input--search"
        type="search"
        placeholder="搜索网络名…"
        aria-label="搜索网络名"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {rows.length === 0 ? (
        <div className="empty">没有匹配 “{query}” 的网络</div>
      ) : (
        <div className="list list--nets">
          {rows.map((m) => {
            const key = m.name
            const checked = selected.has(key)
            const layerSummary = m.members.map((mm) => mm.layerName).join('、')
            return (
              <label className={`net-row${checked ? ' net-row--on' : ''}`} key={key}>
                <input type="checkbox" checked={checked} onChange={() => onToggle(key)} />
                <span
                  className="net-color"
                  style={{ background: colors[key] ?? '#16f0ff' }}
                  aria-hidden="true"
                />
                <span className="net-name" title={layerSummary}>
                  {m.name}
                </span>
                {m.members.length > 1 && (
                  <span className="tag tag--quiet" title={layerSummary}>
                    ×{m.members.length}
                  </span>
                )}
                <span className="net-sub">{m.totalCount}</span>
              </label>
            )
          })}
        </div>
      )}

      {selected.size === 2 && (
        <div className="spacing-box">
          <button type="button" className="btn btn--primary btn--block" onClick={onComputeSpacing}>
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
            <div className="empty">两网络无共同出现的层</div>
          ) : (
            <div className="hint">
              勾选 2 个网络后点击计算，将自动求两网在每一层的最小间距，并在图中标注最近点。
            </div>
          )}
        </div>
      )}

      <div className="hint">
        勾选网络后，对应铜层将以专属颜色高亮；跨层同名网络共享同一颜色。
      </div>
    </Collapsible>
  )
}

function formatMm(v: number): string {
  if (v >= 100) return v.toFixed(1)
  if (v >= 1) return v.toFixed(2)
  return v.toFixed(3)
}
