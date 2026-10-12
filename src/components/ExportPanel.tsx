import { useState } from 'react'
import type { PdfLayout } from '../lib/pdfExport'

interface Props {
  disabled: boolean
  count: number
  onExport: (layout: PdfLayout) => void
}

export default function ExportPanel({ disabled, count, onExport }: Props) {
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
        导出 PDF{count > 0 ? `（${count} 层）` : ''}
      </button>
      <div className="meta">
        从 ODB++ 直接生成矢量 PDF（放大不失真），仅导出当前勾选的图层，白底。
      </div>
    </div>
  )
}
