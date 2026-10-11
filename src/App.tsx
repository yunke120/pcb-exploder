import { useCallback, useRef, useState } from 'react'
import JSZip from 'jszip'
import DropZone from './components/DropZone'
import LayerPanel from './components/LayerPanel'
import ExplosionView from './components/ExplosionView'
import { identifyLayer, type LayerMeta } from './lib/layers'
import {
  parseGerberToSvg,
  getViewBox,
  computeGlobalBox,
  renderLayerTexture,
  type ViewBox,
  type GlobalBox,
} from './lib/gerber'

export interface LayerItem {
  id: string
  name: string
  meta: LayerMeta
  svg?: string
  vb?: ViewBox
  texture?: import('three').Texture
}

const ACCEPTED = /\.(gbr|gtl|gbl|gts|gbs|gto|gbo|gtp|gbp|gko|gm\d|gml|g\d|gp\d|in\d|drl|txt)$/i

interface RawEntry {
  name: string
  text: () => Promise<string>
}

async function gatherEntries(files: File[]): Promise<RawEntry[]> {
  const entries: RawEntry[] = []
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      const zip = await JSZip.loadAsync(await f.arrayBuffer())
      zip.forEach((path, entry) => {
        if (!entry.dir && ACCEPTED.test(path)) {
          const name = path.split('/').pop() || path
          entries.push({ name, text: () => entry.async('string') })
        }
      })
    } else if (ACCEPTED.test(f.name)) {
      entries.push({ name: f.name, text: () => f.text() })
    }
  }
  return entries
}

export default function App() {
  const [items, setItems] = useState<LayerItem[]>([])
  const [aspect, setAspect] = useState(1)
  const [explosion, setExplosion] = useState(1.4)
  const [showLabels, setShowLabels] = useState(true)
  const [visible, setVisible] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const itemsRef = useRef<LayerItem[]>([])

  const handleFiles = useCallback(async (files: File[]) => {
    setBusy(true)
    setError(null)
    try {
      const entries = await gatherEntries(files)
      if (entries.length === 0) {
        setError('未识别到 Gerber 文件，请检查扩展名或压缩包内容。')
        setBusy(false)
        return
      }

      const parsed: LayerItem[] = entries.map((e, idx) => ({
        id: `${idx}-${e.name}`,
        name: e.name,
        meta: identifyLayer(e.name),
      }))

      // 仅对可渲染平面层解析 SVG
      const renderables = parsed.filter((p) => p.meta.renderable)
      await Promise.all(
        renderables.map(async (p) => {
          const entry = entries[parsed.indexOf(p)]
          try {
            const text = await entry.text()
            const svg = await parseGerberToSvg(text)
            const vb = getViewBox(svg)
            parsed[parsed.indexOf(p)] = { ...parsed[parsed.indexOf(p)], svg, vb }
          } catch (err) {
            console.warn('图层解析失败:', p.name, err)
          }
        }),
      )

      const done = parsed
        .filter((p) => p.meta.renderable && p.svg && p.vb)
        .map((p) => ({ ...p }))

      if (done.length === 0) {
        setError('Gerber 解析未产生可渲染图层，请确认文件为 RS-274X 格式。')
        setItems(parsed) // 仍展示其他文件（钻孔/板框）
        setBusy(false)
        return
      }

      const g: GlobalBox = computeGlobalBox(done.map((d) => d.vb!))
      const asp = g.w / g.h || 1

      const withTex = await Promise.all(
        done.map(async (d) => {
          const texture = await renderLayerTexture(d.svg!, d.vb!, g, asp, d.meta.color)
          return { ...d, texture }
        }),
      )

      // 释放旧纹理
      for (const old of itemsRef.current) old.texture?.dispose()

      const finalItems = [...withTex, ...parsed.filter((p) => !p.meta.renderable)]
      itemsRef.current = finalItems
      setItems(finalItems)
      setAspect(asp)
      setVisible(new Set(withTex.map((t) => t.id)))
    } catch (err) {
      console.error(err)
      setError('处理过程中发生错误：' + (err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [])

  const toggle = useCallback((id: string) => {
    setVisible((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const visibleItems = items.filter((i) => i.texture && visible.has(i.id))
  const hasRenderable = items.some((i) => i.texture)

  return (
    <div className="app">
      <header className="header">
        <h1>PCB 爆炸图查看器</h1>
        <span className="sub">Gerber Layer Exploder · 仅层展开</span>
      </header>

      <aside className="side">
        <DropZone onFiles={handleFiles} busy={busy} />
        {error && (
          <div className="section" style={{ color: '#9b2c2c' }}>
            {error}
          </div>
        )}
        <LayerPanel
          items={items}
          visible={visible}
          onToggle={toggle}
          explosion={explosion}
          setExplosion={setExplosion}
          showLabels={showLabels}
          setShowLabels={setShowLabels}
        />
      </aside>

      <main className="main">
        {hasRenderable ? (
          <ExplosionView
            items={visibleItems}
            aspect={aspect}
            explosion={explosion}
            showLabels={showLabels}
          />
        ) : (
          <div className="empty-hint">
            拖入一组 Gerber 文件（或含 Gerber 的 .zip）<br />
            即可将各层以爆炸图形式展开
          </div>
        )}
        {hasRenderable && (
          <div className="legend-tag">
            <b>板框比例</b> {aspect >= 1 ? '横向' : '纵向'} · {aspect.toFixed(3)}<br />
            <b>可见图层</b> {visibleItems.length} / {items.filter((i) => i.texture).length}
          </div>
        )}
      </main>
    </div>
  )
}
