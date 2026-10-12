import { useState } from 'react'
import type { PdfLayout } from '../lib/pdfExport'

interface Props {
  disabled: boolean
  onExport: (layout: PdfLayout) => void
}

export default function ExportPanel({ disabled, onExport }: Props) {
  const [layout, setLayout] = useState<PdfLayout>('grid')

  return (
    <div className="section">
      <h2>导出 PDF</h2>
      <div className="row">
        <select
          className="export-select"
          value={layout}
          disabled={disabled}
          onChange={(e) => setLayout(e.target.value as PdfLayout)}
        >
          <option value="grid">平面网格（单页）</option>
          <option value="perPage">每层一页</option>
        </select>
      </div>
      <button className="btn primary export-btn" disabled={disabled} onClick={() => onExport(layout)}>
        导出 PDF
      </button>
      <div className="meta">
        将全部可渲染图层导出为 PDF，含层名标签；深色底板便于观察丝印等浅色层。
      </div>
    </div>
  )
}
