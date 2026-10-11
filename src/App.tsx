import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import DropZone, { type DroppedItem } from './components/DropZone'
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
import { parseOdb, renderOdbToTexture, type OdbLayer, type FileEntry } from './lib/odb'

export interface LayerItem {
  id: string
  name: string
  meta: LayerMeta
  svg?: string
  vb?: ViewBox
  texture?: import('three').Texture
  /** Gerber 解析结果（图元 + 块索引），用于网络高亮 */
  parsed?: ParsedLayer
  /** ODB++ 解析结果（图元 + 符号），用于网络高亮 */
  odb?: OdbLayer
  /** 该层识别出的网络列表 */
  nets?: Net[]
}

/** 跨层合并后的网络：同一显式网名（如 AGND）分布于多层时归并为一条 */
export interface MergedNetMember {
  layerId: string
  netId: number
  layerName: string
  primCount: number
}
export interface MergedNet {
  name: string
  members: MergedNetMember[]
  /** 跨层图元总数，用于排序与展示 */
  totalCount: number
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

/** 探测拖入内容是否包含 ODB++（文件夹树或 zip 内含 matrix/matrix） */
async function detectOdb(dropped: DroppedItem[]): Promise<boolean> {
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  for (const d of dropped) {
    if (/matrix\/matrix$/.test(norm(d.file.name)) || /matrix\/matrix$/.test(norm(d.path))) return true
    if (/\.zip$/i.test(d.file.name)) {
      try {
        const zip = await JSZip.loadAsync(await d.file.arrayBuffer())
        for (const rel of Object.keys(zip.files)) {
          if (/(^|\/)matrix\/matrix$/.test(norm(rel))) return true
        }
      } catch {
        /* ignore */
      }
    }
  }
  return false
}

/** 将拖入项（文件夹树或 zip）整理成 ODB++ 所需的 FileEntry[] */
async function toOdbEntries(dropped: DroppedItem[]): Promise<FileEntry[]> {
  const entries: FileEntry[] = []
  for (const d of dropped) {
    if (/\.zip$/i.test(d.file.name)) {
      const zip = await JSZip.loadAsync(await d.file.arrayBuffer())
      zip.forEach((path, entry) => {
        if (!entry.dir)
          entries.push({ path: path.replace(/\\/g, '/'), bytes: () => entry.async('uint8array') })
      })
    } else {
      entries.push({
        path: d.path.replace(/\\/g, '/'),
        bytes: () => d.file.arrayBuffer().then((b) => new Uint8Array(b)),
      })
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
  const gbRef = useRef<GlobalBox | null>(null)
  // 网络高亮：选中的网络 key 集合（layerId::netId）与对应叠加纹理
  const [selectedNets, setSelectedNets] = useState<Set<string>>(new Set())
  const [netOverlays, setNetOverlays] = useState<Record<string, import('three').Texture>>({})
  const HIGHLIGHT_COLOR = '#16f0ff'

  // 跨层合并：仅对“显式命名”的网络（ODB++ 真实网名）按名称归并；
  // Gerber 合成名（Net N）每层独立、不可合并，仍按层展示。
  const mergedNets = useMemo<MergedNet[]>(() => {
    const byName = new Map<string, MergedNet>()
    for (const layer of items) {
      if (!layer.nets || layer.nets.length === 0) continue
      for (const net of layer.nets) {
        if (!net.explicit) continue
        let m = byName.get(net.name)
        if (!m) {
          m = { name: net.name, members: [], totalCount: 0 }
          byName.set(net.name, m)
        }
        m.members.push({
          layerId: layer.id,
          netId: net.id,
          layerName: layer.meta.name,
          primCount: net.primitiveIdxs.length,
        })
        m.totalCount += net.primitiveIdxs.length
      }
    }
    return [...byName.values()].sort((a, b) => b.totalCount - a.totalCount)
  }, [items])

  // ---- ODB++ 分支 ----
  const handleOdb = useCallback(async (dropped: DroppedItem[]) => {
    const entries = await toOdbEntries(dropped)
    const design = await parseOdb(entries)
    const renderable = design.layers.filter((l) => l.meta.renderable && l.features.length > 0)
    if (renderable.length === 0) {
      setError('ODB++ 未解析出可渲染图层，请确认目录结构包含 steps/<step>/layers/<name>/features。')
      setBusy(false)
      return
    }
    const vbs: ViewBox[] = renderable.map((l) => l.vb)
    if (design.profile) vbs.push(design.profile)
    const g = computeGlobalBox(vbs)
    const asp = g.w / g.h || 1

    // 释放旧纹理
    for (const old of itemsRef.current) old.texture?.dispose()
    for (const t of Object.values(netOverlays)) t.dispose()

    const withTex: LayerItem[] = renderable.map((l) => ({
      id: `odb-${l.name}`,
      name: l.name,
      meta: l.meta,
      vb: l.vb,
      odb: l,
      texture: renderOdbToTexture(l, g, asp, l.meta.color),
      nets: l.nets,
    }))
    const nonRender: LayerItem[] = design.layers
      .filter((l) => !l.meta.renderable)
      .map((l) => ({ id: `odb-${l.name}`, name: l.name, meta: l.meta, odb: l, nets: l.nets }))

    const finalItems = [...withTex, ...nonRender]
    gbRef.current = g
    itemsRef.current = finalItems
    setItems(finalItems)
    setAspect(asp)
    setSelectedNets(new Set())
    setNetOverlays({})
    setVisible(new Set(withTex.map((t) => t.id)))
  }, [netOverlays])

  const handleFiles = useCallback(
    async (dropped: DroppedItem[]) => {
      setBusy(true)
      setError(null)
      try {
        if (await detectOdb(dropped)) {
          await handleOdb(dropped)
          return
        }

        const entries = await gatherEntries(dropped.map((d) => d.file))
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
        for (const t of Object.values(netOverlays)) t.dispose()

        const finalItems = [...withTex, ...parsed.filter((p) => !p.meta.renderable)]
        gbRef.current = g
        itemsRef.current = finalItems
        setItems(finalItems)
        setAspect(asp)
        setSelectedNets(new Set())
        setNetOverlays({})
        setVisible(new Set(withTex.map((t) => t.id)))
      } catch (err) {
        console.error(err)
        setError('处理过程中发生错误：' + (err as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [handleOdb, netOverlays],
  )

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

  // 选中网络变化时，渲染对应网络子集为叠加纹理（与底层同坐标系对齐）。
  // Gerber 走 gerber-to-svg 子集；ODB++ 走 renderOdbToTexture 子集。
  useEffect(() => {
    let cancelled = false
    async function run() {
      const byLayer = new Map<string, Net[]>()
      const pushOne = (layerId: string, net: Net) => {
        if (!byLayer.has(layerId)) byLayer.set(layerId, [])
        byLayer.get(layerId)!.push(net)
      }
      for (const key of selectedNets) {
        if (key.includes('::')) {
          // 非显式（Gerber 合成）网络：单层单网
          const sep = key.indexOf('::')
          const layerId = key.slice(0, sep)
          const netId = Number(key.slice(sep + 2))
          const layer = itemsRef.current.find((i) => i.id === layerId)
          const net = layer?.nets?.find((n) => n.id === netId)
          if (net) pushOne(layerId, net)
        } else {
          // 显式网络：按名称展开到所有含该网的铜层
          for (const layer of itemsRef.current) {
            if (!layer.nets) continue
            for (const net of layer.nets) {
              if (net.explicit && net.name === key) pushOne(layer.id, net)
            }
          }
        }
      }
      if (byLayer.size === 0) {
        setNetOverlays((prev) => {
          Object.values(prev).forEach((t) => t.dispose())
          return {}
        })
        return
      }
      const g: GlobalBox =
        gbRef.current ??
        computeGlobalBox(itemsRef.current.filter((i) => i.vb).map((i) => i.vb!))
      const asp = aspect || 1
      const out: Record<string, import('three').Texture> = {}
      for (const [layerId, nets] of byLayer) {
        const layer = itemsRef.current.find((i) => i.id === layerId)
        if (!layer?.vb) continue
        const idxs: number[] = []
        for (const n of nets) idxs.push(...n.primitiveIdxs)
        try {
          let tex: import('three').Texture
          if (layer.odb) {
            tex = renderOdbToTexture(layer.odb, g, asp, HIGHLIGHT_COLOR, new Set(idxs))
          } else if (layer.parsed) {
            const subset = buildSubset(layer.parsed, idxs)
            const svg = await parseGerberToSvg(subset)
            const svgVb = withViewBox(svg, layer.vb)
            tex = await renderLayerTexture(svgVb, layer.vb, g, asp, HIGHLIGHT_COLOR)
          } else continue
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
          mergedNets={mergedNets}
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
            拖入 Gerber 文件 / ODB++ 文件夹（或对应的 .zip）<br />
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
