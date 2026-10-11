import { useCallback, useEffect, useRef, useState } from 'react'
import JSZip from 'jszip'
import DropZone from './components/DropZone'
import LayerPanel from './components/LayerPanel'
import NetPanel from './components/NetPanel'
import ExplosionView from './components/ExplosionView'
import { identifyLayer, type LayerMeta } from './lib/layers'
import {
  parseGerberToSvg,
  getViewBox,
  computeGlobalBox,
  renderLayerTexture,
  withViewBox,
  type ViewBox,
  type GlobalBox,
} from './lib/gerber'
import { parseGerber, buildSubset, type ParsedLayer } from './lib/gerberParse'
import { computeNets, type Net } from './lib/nets'

export interface LayerItem {
  id: string
  name: string
  meta: LayerMeta
  svg?: string
  vb?: ViewBox
  texture?: import('three').Texture
  /** Gerber 解析结果（图元 + 块索引），用于网络高亮 */
  parsed?: ParsedLayer
  /** 该层识别出的网络列表 */
  nets?: Net[]
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
  // 网络高亮：选中的网络 key 集合（layerId::netId）与对应叠加纹理
  const [selectedNets, setSelectedNets] = useState<Set<string>>(new Set())
  const [netOverlays, setNetOverlays] = useState<Record<string, import('three').Texture>>({})
  const HIGHLIGHT_COLOR = '#16f0ff'

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

      // 仅对可渲染平面层解析 SVG；铜层额外解析图元用于网络高亮
      const renderables = parsed.filter((p) => p.meta.renderable)
      const isCopper = (k: string) =>
        k === 'topCopper' || k === 'bottomCopper' || k === 'innerCopper'
      await Promise.all(
        renderables.map(async (p) => {
          const entry = entries[parsed.indexOf(p)]
          try {
            const text = await entry.text()
            const svg = await parseGerberToSvg(text)
            const vb = getViewBox(svg)
            const patch: Partial<LayerItem> = { svg, vb }
            if (isCopper(p.meta.kind)) {
              const parsedLayer = parseGerber(text)
              patch.parsed = parsedLayer
              patch.nets = computeNets(parsedLayer)
            }
            parsed[parsed.indexOf(p)] = { ...parsed[parsed.indexOf(p)], ...patch }
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

  // 选中网络变化时，复用 gerber-to-svg 渲染该网络子集为叠加纹理（与底层同坐标系对齐）
  useEffect(() => {
    let cancelled = false
    async function run() {
      const byLayer = new Map<string, Net[]>()
      for (const key of selectedNets) {
        const sep = key.indexOf('::')
        const layerId = key.slice(0, sep)
        const netId = Number(key.slice(sep + 2))
        const layer = itemsRef.current.find((i) => i.id === layerId)
        if (!layer?.parsed || !layer.nets) continue
        const net = layer.nets.find((n) => n.id === netId)
        if (!net) continue
        if (!byLayer.has(layerId)) byLayer.set(layerId, [])
        byLayer.get(layerId)!.push(net)
      }
      const g: GlobalBox = computeGlobalBox(
        itemsRef.current.filter((i) => i.vb).map((i) => i.vb!),
      )
      const asp = aspect || 1
      const out: Record<string, import('three').Texture> = {}
      for (const [layerId, nets] of byLayer) {
        const layer = itemsRef.current.find((i) => i.id === layerId)
        if (!layer?.vb || !layer.parsed) continue
        const idxs: number[] = []
        for (const n of nets) idxs.push(...n.primitiveIdxs)
        const subset = buildSubset(layer.parsed, idxs)
        try {
          const svg = await parseGerberToSvg(subset)
          const svgVb = withViewBox(svg, layer.vb)
          const tex = await renderLayerTexture(svgVb, layer.vb, g, asp, HIGHLIGHT_COLOR)
          out[layerId] = tex
        } catch (e) {
          console.warn('网络高亮渲染失败:', layer.name, e)
        }
      }
      if (cancelled) {
        Object.values(out).forEach((t) => t.dispose())
        return
      }
      setNetOverlays((prev) => {
        Object.values(prev).forEach((t) => t.dispose())
        return out
      })
    }
    run()
    return () => {
      cancelled = true
    }
  }, [selectedNets, items, aspect])

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
        <NetPanel
          items={items}
          selected={selectedNets}
          onToggle={(key: string) =>
            setSelectedNets((prev) => {
              const next = new Set(prev)
              if (next.has(key)) next.delete(key)
              else next.add(key)
              return next
            })
          }
          onClear={() => setSelectedNets(new Set())}
        />
      </aside>

      <main className="main">
        {hasRenderable ? (
          <ExplosionView
            items={visibleItems}
            aspect={aspect}
            explosion={explosion}
            showLabels={showLabels}
            overlays={netOverlays}
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
