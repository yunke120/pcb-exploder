import { useRef, useState } from 'react'

export interface DroppedItem {
  file: File
  /** 相对路径（文件夹拖入时）或文件名 */
  path: string
}

interface Props {
  onFiles: (items: DroppedItem[]) => void
  busy: boolean
}

/** 递归遍历目录项，收集所有文件及其相对路径 */
async function traverse(
  entry: any,
  base: string,
  out: DroppedItem[],
): Promise<void> {
  if (entry.isFile) {
    const file: File = await new Promise((res, rej) => entry.file(res, rej))
    out.push({ file, path: base ? `${base}/${entry.name}` : entry.name })
  } else if (entry.isDirectory) {
    const reader = entry.createReader()
    let batch: any[] = []
    do {
      batch = await new Promise<any[]>((res, rej) => reader.readEntries(res, rej))
      for (const e of batch) await traverse(e, base ? `${base}/${entry.name}` : entry.name, out)
    } while (batch.length > 0)
  }
}

export default function DropZone({ onFiles, busy }: Props) {
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setOver(false)
    const dt = e.dataTransfer
    const items = dt.items
    const collected: DroppedItem[] = []
    if (items && items.length && (items[0] as any).webkitGetAsEntry) {
      const entries = Array.from(items)
        .map((it) => (it as any).webkitGetAsEntry())
        .filter(Boolean)
      for (const ent of entries) await traverse(ent, '', collected)
    }
    if (collected.length === 0 && dt.files.length) {
      for (const f of Array.from(dt.files)) collected.push({ file: f, path: f.name })
    }
    if (collected.length) onFiles(collected)
  }

  return (
    <div
      className={`dropzone${over ? ' over' : ''}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
    >
      <strong>{busy ? '正在解析图层…' : '拖入 ODB++ 文件夹 / .zip'}</strong>
      <small>支持 ODB++ 目录树（steps/&lt;step&gt;/layers/...）或对应 .zip 压缩包</small>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".zip"
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.target.files || [])
          if (files.length) {
            onFiles(files.map((f) => ({ file: f, path: (f as any).webkitRelativePath || f.name })))
          }
          e.target.value = ''
        }}
      />
    </div>
  )
}
