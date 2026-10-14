import { useState } from 'react'

/** 一条可勾选的技术要求条目 */
export interface TechOption {
  text: string
  source: 'auto' | 'preset'
}

interface TechSectionProps {
  title: string
  options: TechOption[]
  selected: Set<string>
  onToggle: (text: string) => void
  custom: string[]
  onAddCustom: (text: string) => void
  onRemoveCustom: (index: number) => void
  disabled: boolean
  exportLabel: string
  onExport: () => void
}

function TechSection({
  title,
  options,
  selected,
  onToggle,
  custom,
  onAddCustom,
  onRemoveCustom,
  disabled,
  exportLabel,
  onExport,
}: TechSectionProps) {
  const [draft, setDraft] = useState('')
  const auto = options.filter((o) => o.source === 'auto')
  const preset = options.filter((o) => o.source === 'preset')

  const submitCustom = () => {
    const t = draft.trim()
    if (!t) return
    onAddCustom(t)
    setDraft('')
  }

  return (
    <div className="section tech-section">
      <h2>{title}</h2>

      {auto.length > 0 && (
        <>
          <div className="tech-sub">自动生成建议</div>
          {auto.map((o) => (
            <label key={o.text} className="tech-item">
              <input
                type="checkbox"
                checked={selected.has(o.text)}
                onChange={() => onToggle(o.text)}
              />
              <span>{o.text}</span>
            </label>
          ))}
        </>
      )}

      <div className="tech-sub">通用要求</div>
      {preset.map((o) => (
        <label key={o.text} className="tech-item">
          <input
            type="checkbox"
            checked={selected.has(o.text)}
            onChange={() => onToggle(o.text)}
          />
          <span>{o.text}</span>
        </label>
      ))}

      {custom.length > 0 && (
        <>
          <div className="tech-sub">自定义条目</div>
          {custom.map((t, i) => (
            <div key={`${i}-${t}`} className="tech-item tech-custom">
              <span className="tech-custom-text">{t}</span>
              <button className="tech-del" title="删除" onClick={() => onRemoveCustom(i)}>
                ×
              </button>
            </div>
          ))}
        </>
      )}

      <div className="row tech-add-row">
        <input
          type="text"
          className="tech-input"
          placeholder="新增技术要求条目…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitCustom()
          }}
        />
        <button className="btn tech-add" onClick={submitCustom}>
          添加
        </button>
      </div>

      <button className="btn primary export-btn" disabled={disabled} onClick={onExport}>
        {exportLabel}
      </button>
    </div>
  )
}

interface Props {
  disabled: boolean
  layerCount: number
  pcbOptions: TechOption[]
  pcbSelected: Set<string>
  onPcbToggle: (text: string) => void
  pcbCustom: string[]
  onPcbAddCustom: (text: string) => void
  onPcbRemoveCustom: (index: number) => void
  onExportPcb: () => void
  assemblyOptions: TechOption[]
  assemblySelected: Set<string>
  onAssemblyToggle: (text: string) => void
  assemblyCustom: string[]
  onAssemblyAddCustom: (text: string) => void
  onAssemblyRemoveCustom: (index: number) => void
  onExportAssembly: () => void
}

export default function TechPanel({
  disabled,
  layerCount,
  pcbOptions,
  pcbSelected,
  onPcbToggle,
  pcbCustom,
  onPcbAddCustom,
  onPcbRemoveCustom,
  onExportPcb,
  assemblyOptions,
  assemblySelected,
  onAssemblyToggle,
  assemblyCustom,
  onAssemblyAddCustom,
  onAssemblyRemoveCustom,
  onExportAssembly,
}: Props) {
  const suffix = layerCount > 0 ? `（${layerCount} 层）` : ''
  return (
    <>
      <TechSection
        title="印制板图技术要求"
        options={pcbOptions}
        selected={pcbSelected}
        onToggle={onPcbToggle}
        custom={pcbCustom}
        onAddCustom={onPcbAddCustom}
        onRemoveCustom={onPcbRemoveCustom}
        disabled={disabled}
        exportLabel={`导出印制板图${suffix}`}
        onExport={onExportPcb}
      />
      <TechSection
        title="组件图技术要求"
        options={assemblyOptions}
        selected={assemblySelected}
        onToggle={onAssemblyToggle}
        custom={assemblyCustom}
        onAddCustom={onAssemblyAddCustom}
        onRemoveCustom={onAssemblyRemoveCustom}
        disabled={disabled}
        exportLabel={`导出组件图${suffix}`}
        onExport={onExportAssembly}
      />
    </>
  )
}
