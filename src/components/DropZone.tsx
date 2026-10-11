import { useRef, useState } from 'react'

interface Props {
  onFiles: (files: File[]) => void
  busy: boolean
}

export default function DropZone({ onFiles, busy }: Props) {
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <div
      className={`dropzone${over ? ' over' : ''}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const files = Array.from(e.dataTransfer.files)
        if (files.length) onFiles(files)
      }}
    >
      <strong>{busy ? '正在解析 Gerber 图层…' : '拖入 Gerber 文件 / 文件夹 / .zip'}</strong>
      <small>支持 GTL·GBL·GTS·GBS·GTO·GBO·GTP·GBP·G1..·GM1·DRL 等扩展名</small>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".gbr,.gtl,.gbl,.gts,.gbs,.gto,.gbo,.gtp,.gbp,.gko,.gm1,.gm2,.gm3,.gml,.g1,.g2,.g3,.g4,.gp1,.in1,.drl,.txt,.zip"
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.target.files || [])
          if (files.length) onFiles(files)
          e.target.value = ''
        }}
      />
    </div>
  )
}
