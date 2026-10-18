import { useState } from 'react'
import { PCB_TECH_PRESETS, ASSEMBLY_TECH_PRESETS } from '../lib/tech'
import Collapsible, { usePersistentOpen } from './Collapsible'

// 选择键约定：自动项 "a:<index>"、预置项 "p:<index>"；自定义条目始终包含（不可取消勾选）
interface TechSectionProps {
  title: string
  /** 自动生成建议（可编辑文本，仅印制板图有） */
  auto?: string[]
  onEditAuto?: (index: number, text: string) => void
  /** 预置通用要求（固定文本） */
  presets: string[]
  selected: Set<string>
  onToggle: (id: string) => void
  custom: string[]
  onAddCustom: (text: string) => void
  onRemoveCustom: (index: number) => void
  disabled: boolean
  exportLabel: string
  onExport: () => void
  /** 当前勾选（含自定义）条目数，用于复制按钮文案 */
  copyCount: number
  onCopy: () => void
}

function TechSection({
  title,
  auto = [],
  onEditAuto,
  presets,
  selected,
  onToggle,
  custom,
  onAddCustom,
  onRemoveCustom,
  disabled,
  exportLabel,
  onExport,
  copyCount,
  onCopy,
}: TechSectionProps) {
  const [draft, setDraft] = useState('')

  const submitCustom = () => {
    const t = draft.trim()
    if (!t) return
    onAddCustom(t)
    setDraft('')
  }

  const total = auto.length + presets.length + custom.length
  const checkedCount =
    auto.filter((_, i) => selected.has(`a:${i}`)).length +
    presets.filter((_, i) => selected.has(`p:${i}`)).length +
    custom.length
  const { open, setOpen } = usePersistentOpen(`tech-${title}`, false)

  return (
    <Collapsible
      title={title}
      badge={`${checkedCount}/${total}`}
      open={open}
      onOpenChange={setOpen}
    >
      {auto.length > 0 && (
        <>
          <div className="tech-sub">自动生成建议（带数值项可编辑）</div>
          {auto.map((o, i) => {
            const id = `a:${i}`
            return (
              <div key={`a-${i}`} className="tech-item">
                <input
                  type="checkbox"
                  checked={selected.has(id)}
                  onChange={() => onToggle(id)}
                />
                <input
                  type="text"
                  className="input tech-auto-input"
                  aria-label="技术要求条目"
                  value={o}
                  onChange={(e) => onEditAuto?.(i, e.target.value)}
                />
              </div>
            )
          })}
        </>
      )}

      <div className="tech-sub">通用要求</div>
      <div className="list list--tech">
        {presets.map((o, i) => {
          const id = `p:${i}`
          return (
            <label key={`p-${i}`} className="tech-item">
              <input
                type="checkbox"
                checked={selected.has(id)}
                onChange={() => onToggle(id)}
              />
              <span>{o}</span>
            </label>
          )
        })}
      </div>

      {custom.length > 0 && (
        <>
          <div className="tech-sub">自定义条目</div>
          {custom.map((t, i) => (
            <div key={`c-${i}-${t}`} className="tech-item tech-custom">
              <span className="tech-custom-text">{t}</span>
              <button
                type="button"
                className="tech-del"
                title="删除"
                aria-label={`删除条目：${t}`}
                onClick={() => onRemoveCustom(i)}
              >
                ×
              </button>
            </div>
          ))}
        </>
      )}

      <div className="row tech-add-row">
        <input
          type="text"
          className="input"
          placeholder="新增技术要求条目…"
          aria-label="新增技术要求条目"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitCustom()
          }}
        />
        <button type="button" className="btn" onClick={submitCustom}>
          添加
        </button>
      </div>

      <div className="tech-actions">
        <button
          type="button"
          className="btn"
          disabled={copyCount === 0 || disabled}
          onClick={onCopy}
          title="仅复制当前勾选的技术要求条目"
        >
          复制技术要求{copyCount > 0 ? `（${copyCount}）` : ''}
        </button>
        <button type="button" className="btn btn--primary" disabled={disabled} onClick={onExport}>
          {exportLabel}
        </button>
      </div>
    </Collapsible>
  )
}

interface Props {
  disabled: boolean
  // 印制板图
  pcbAuto: string[]
  onPcbEditAuto: (index: number, text: string) => void
  pcbSelected: Set<string>
  onPcbToggle: (id: string) => void
  pcbCustom: string[]
  onPcbAddCustom: (text: string) => void
  onPcbRemoveCustom: (index: number) => void
  pcbExportLabel: string
  onExportPcb: () => void
  pcbCopyCount: number
  onCopyPcb: () => void
  // 组件图
  assemblySelected: Set<string>
  onAssemblyToggle: (id: string) => void
  assemblyCustom: string[]
  onAssemblyAddCustom: (text: string) => void
  onAssemblyRemoveCustom: (index: number) => void
  assemblyExportLabel: string
  onExportAssembly: () => void
  assemblyCopyCount: number
  onCopyAssembly: () => void
}

export default function TechPanel({
  disabled,
  pcbAuto,
  onPcbEditAuto,
  pcbSelected,
  onPcbToggle,
  pcbCustom,
  onPcbAddCustom,
  onPcbRemoveCustom,
  pcbExportLabel,
  onExportPcb,
  pcbCopyCount,
  onCopyPcb,
  assemblySelected,
  onAssemblyToggle,
  assemblyCustom,
  onAssemblyAddCustom,
  onAssemblyRemoveCustom,
  assemblyExportLabel,
  onExportAssembly,
  assemblyCopyCount,
  onCopyAssembly,
}: Props) {
  return (
    <>
      <TechSection
        title="印制板图"
        auto={pcbAuto}
        onEditAuto={onPcbEditAuto}
        presets={PCB_TECH_PRESETS}
        selected={pcbSelected}
        onToggle={onPcbToggle}
        custom={pcbCustom}
        onAddCustom={onPcbAddCustom}
        onRemoveCustom={onPcbRemoveCustom}
        disabled={disabled}
        exportLabel={pcbExportLabel}
        onExport={onExportPcb}
        copyCount={pcbCopyCount}
        onCopy={onCopyPcb}
      />
      <TechSection
        title="组件图"
        presets={ASSEMBLY_TECH_PRESETS}
        selected={assemblySelected}
        onToggle={onAssemblyToggle}
        custom={assemblyCustom}
        onAddCustom={onAssemblyAddCustom}
        onRemoveCustom={onAssemblyRemoveCustom}
        disabled={disabled}
        exportLabel={assemblyExportLabel}
        onExport={onExportAssembly}
        copyCount={assemblyCopyCount}
        onCopy={onCopyAssembly}
      />
    </>
  )
}
