import { useState } from 'react'
import type { PdfLayout } from '../lib/pdfExport'
import Collapsible, { usePersistentOpen } from './Collapsible'

interface Props {
  disabled: boolean
  count: number
  onExport: (layout: PdfLayout) => void
}

export default function ExportPanel({ disabled, count, onExport }: Props) {
  const [layout, setLayout] = useState<PdfLayout>('grid')
  const { open, setOpen } = usePersistentOpen('export')

  return (
    <Collapsible title="导出 PDF" open={open} onOpenChange={setOpen}>
      <div className="field">
        <label className="field__label" htmlFor="pdf-layout">
          布局
        </label>
        <select
          id="pdf-layout"
          className="input"
          value={layout}
          disabled={disabled}
          onChange={(e) => setLayout(e.target.value as PdfLayout)}
        >
          <option value="grid">平面网格（单页）</option>
          <option value="perPage">每层一页</option>
        </select>
      </div>
      <button
        type="button"
        className="btn btn--primary btn--block"
        disabled={disabled}
        onClick={() => onExport(layout)}
      >
        导出 PDF{count > 0 ? `（${count} 层）` : ''}
      </button>
      <div className="hint">从 ODB++ 直接生成矢量 PDF（放大不失真），仅导出当前勾选的图层，白底。</div>
    </Collapsible>
  )
}
