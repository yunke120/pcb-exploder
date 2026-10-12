import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import DropZone, { type DroppedItem } from './components/DropZone'
import LayerPanel from './components/LayerPanel'
import NetPanel from './components/NetPanel'
import ExplosionView from './components/ExplosionView'
import ExportPanel from './components/ExportPanel'
import { exportLayersPdf, type PdfLayout, type PdfLayer } from './lib/pdfExport'
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
import { minSpacing, odbNetShapes, gerberNetShapes, type SpacingResult } from './lib/spacing'

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

/** 用于 3D 视图中标注最小间距的结果（含两网络各自的颜色） */
export interface SpacingMark {
  layerId: string
  distance: number
  pA: [number, number]
  pB: [number, number]
  colorA: string
  colorB: string
}

const ACCEPTED = /\.(gbr|gtl|gbl|gts|gbs|gto|gbo|gtp|gbp|gko|gm\d|gml|g\d|gp\d|in\d|drl|txt)$/i

/** 预置的“优选”高亮色（深色背景 + 叠加混合下清晰可辨），优先用于前若干个网络 */
const NET_PALETTE = [
  '#ff5d8f', // 粉红
  '#ffd166', // 金黄
  '#06d6a0', // 青绿
  '#4cc9f0', // 天蓝
  '#b388ff', // 紫
  '#ff9f1c', // 橙
  '#f15bb5', // 品红
  '#9ef01a', // 黄绿
  '#ef476f', // 红
  '#00bbf9', // 蓝
  '#fb8500', // 琥珀
  '#80ffdb', // 浅青
  '#c1121f', // 深红
  '#7ae582', // 绿
  '#e0aaff', // 浅紫
  '#ffadad', // 浅粉
]

/** FNV-1a 字符串哈希，用于把网络 key 稳定映射到配色槽位 */
function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** HSL → #RRGGBB（仅用于超出预置板时按需生成，保证色相均匀分布） */
function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360
  s /= 100
  l /= 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const to = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

/** 由槽位序号得到颜色：前若干用预置板，超出后用黄金角色相生成，确保互不相同 */
function colorFromIndex(i: number): string {
  if (i < NET_PALETTE.length) return NET_PALETTE[i]
  const hue = ((i - NET_PALETTE.length) * 137.508) % 360
  return hslToHex(hue, 90, 62)
}

/**
 * 为当前选中的多个网络分配互不相同的颜色。
 * 槽位数 = max(预置板长度, 选中数)，按哈希升序分配并线性探测避让，
 * 并在颜色层面去重，保证“当前选中集内颜色互异”，且单个网络在增删其他网络时颜色尽量稳定。
 */
function assignNetColors(keys: string[]): Record<string, string> {
  const size = Math.max(NET_PALETTE.length, keys.length, 1)
  const withHash = keys.map((k) => ({ k, h: hashStr(k) }))
  withHash.sort((a, b) => a.h - b.h)
  const used = new Set<number>()
  const usedColors = new Set<string>()
  const res: Record<string, string> = {}
  for (const { k, h } of withHash) {
    let idx = h % size
    let guard = 0
    while ((used.has(idx) || usedColors.has(colorFromIndex(idx))) && guard <= size) {
      idx = (idx + 1) % size
      guard++
    }
    used.add(idx)
    const col = colorFromIndex(idx)
    usedColors.add(col)
    res[k] = col
  }
  return res
}

/**
 * 将选中的网络 key 解析为若干 {layer, net} 实例。
 * 显式网络名（如 AGND）会展开到所有含该名的铜层；非显式（Gerber 合成）仅单层单网。
 */
function resolveSelectedKey(
  key: string,
  items: LayerItem[],
): { layer: LayerItem; net: Net }[] {
  const out: { layer: LayerItem; net: Net }[] = []
  if (key.includes('::')) {
    const sep = key.indexOf('::')
    const layerId = key.slice(0, sep)
    const netId = Number(key.slice(sep + 2))
    const layer = items.find((i) => i.id === layerId)
    const net = layer?.nets?.find((n) => n.id === netId)
    if (layer && net) out.push({ layer, net })
  } else {
    for (const layer of items) {
      if (!layer.nets) continue
      for (const net of layer.nets) {
        if (net.explicit && net.name === key) out.push({ layer, net })
      }
    }
  }
  return out
}

interface RawEntry {
  name: string
  text: () => Promise<string>
}async function gatherEntries(files: File[]): Promise<RawEntry[]> {
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
  /** 视图模式：exploded=沿 Z 轴层叠展开；flat=各层在 XY 平面内网格铺开 */
  const [viewMode, setViewMode] = useState<'exploded' | 'flat'>('exploded')
  const [visible, setVisible] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const itemsRef = useRef<LayerItem[]>([])
  const gbRef = useRef<GlobalBox | null>(null)
  // 网络高亮：选中的网络 key 集合（layerId::netId）与对应叠加纹理
  const [selectedNets, setSelectedNets] = useState<Set<string>>(new Set())
  const [netOverlays, setNetOverlays] = useState<Record<string, import('three').Texture>>({})
  /** 每个选中网络（key）对应的高亮颜色，保证互不相同 */
  const netColors = useMemo<Record<string, string>>(
    () => assignNetColors([...selectedNets]),
    [selectedNets],
  )
  const FALLBACK_NET_COLOR = '#16f0ff'

  // 最小间距计算：仅当恰好选中 2 个网络时有效。
  // spacingPair 记录产生当前结果的两个网络 key（用于取各自高亮色）。
  const [spacingResults, setSpacingResults] = useState<SpacingResult[]>([])
  const [spacingPair, setSpacingPair] = useState<[string, string] | null>(null)

  // 选中数不是 2 时清空旧结果（避免残留标注）
  useEffect(() => {
    if (selectedNets.size !== 2) {
      setSpacingResults([])
      setSpacingPair(null)
    }
  }, [selectedNets])

  /** 计算两个选中网络在每一层（两网同时存在）的最小间距 */
  const computeSpacing = useCallback(() => {
    if (selectedNets.size !== 2) return
    const keys = [...selectedNets]
    const listA = resolveSelectedKey(keys[0], itemsRef.current)
    const listB = resolveSelectedKey(keys[1], itemsRef.current)
    const results: SpacingResult[] = []
    for (const layer of itemsRef.current) {
      if (!layer.nets) continue
      const na = listA.find((m) => m.layer.id === layer.id)
      const nb = listB.find((m) => m.layer.id === layer.id)
      if (!na || !nb) continue // 该层只有其中一个网络 → 不计算
      const shapesA = layer.odb
        ? odbNetShapes(layer.odb, na.net)
        : layer.parsed
          ? gerberNetShapes(layer.parsed, na.net)
          : []
      const shapesB = layer.odb
        ? odbNetShapes(layer.odb, nb.net)
        : layer.parsed
          ? gerberNetShapes(layer.parsed, nb.net)
          : []
      if (shapesA.length === 0 || shapesB.length === 0) continue
      const r = minSpacing(shapesA, shapesB)
      if (r)
        results.push({
          layerId: layer.id,
          layerName: layer.meta.name,
          distance: r.distance,
          pA: r.pA,
          pB: r.pB,
        })
    }
    results.sort((a, b) => a.distance - b.distance)
    setSpacingResults(results)
    setSpacingPair([keys[0], keys[1]])
  }, [selectedNets])

  // 给 3D 视图的标注附上两网络各自的高亮色
  const spacingMarks = useMemo<SpacingMark[]>(() => {
    if (!spacingPair || spacingResults.length === 0) return []
    const colorA = netColors[spacingPair[0]] ?? FALLBACK_NET_COLOR
    const colorB = netColors[spacingPair[1]] ?? FALLBACK_NET_COLOR
    return spacingResults.map((r) => ({
      layerId: r.layerId,
      distance: r.distance,
      pA: r.pA,
      pB: r.pB,
      colorA,
      colorB,
    }))
  }, [spacingResults, spacingPair, netColors])

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

  // 导出当前勾选（可见）的可渲染图层为 PDF
  const exportPdf = useCallback(
    (layout: PdfLayout) => {
      const renderable = itemsRef.current
        .filter((i) => i.texture && visible.has(i.id))
        .sort((a, b) => a.meta.order - b.meta.order)
      if (renderable.length === 0) return
      const layers: PdfLayer[] = renderable.map((i) => ({
        name: i.meta.name,
        canvas: i.texture!.image as HTMLCanvasElement,
      }))
      exportLayersPdf(layers, { aspect: aspect || 1, layout, title: 'PCB 图层' }).catch((e) => {
        console.error('PDF 导出失败:', e)
        setError('PDF 导出失败：' + (e as Error).message)
      })
    },
    [aspect, visible],
  )

  const visibleItems = items.filter((i) => i.texture && visible.has(i.id))
  const hasRenderable = items.some((i) => i.texture)

  // 选中网络变化时，为每个网络渲染一张专属颜色的高亮叠加纹理。
  // 叠加纹理的 key 为 `${layerId}::${netKey}`，从而同一层可同时显示多个不同颜色的高亮。
  // Gerber 走 gerber-to-svg 子集；ODB++ 走 renderOdbToTexture 子集。
  useEffect(() => {
    let cancelled = false
    async function run() {
      type Req = { oKey: string; layerId: string; net: Net; color: string }
      const requests: Req[] = []
      for (const key of selectedNets) {
        const color = netColors[key] ?? FALLBACK_NET_COLOR
        if (key.includes('::')) {
          // 非显式（Gerber 合成）网络：单层单网
          const sep = key.indexOf('::')
          const layerId = key.slice(0, sep)
          const netId = Number(key.slice(sep + 2))
          const layer = itemsRef.current.find((i) => i.id === layerId)
          const net = layer?.nets?.find((n) => n.id === netId)
          if (net) requests.push({ oKey: `${layerId}::${key}`, layerId, net, color })
        } else {
          // 显式网络：按名称展开到所有含该网的铜层，但整体共享同一颜色
          for (const layer of itemsRef.current) {
            if (!layer.nets) continue
            for (const net of layer.nets) {
              if (net.explicit && net.name === key)
                requests.push({ oKey: `${layer.id}::${key}`, layerId: layer.id, net, color })
            }
          }
        }
      }
      if (requests.length === 0) {
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
      for (const r of requests) {
        const layer = itemsRef.current.find((i) => i.id === r.layerId)
        if (!layer?.vb) continue
        try {
          let tex: import('three').Texture
          if (layer.odb) {
            tex = renderOdbToTexture(layer.odb, g, asp, r.color, new Set(r.net.primitiveIdxs))
          } else if (layer.parsed) {
            const subset = buildSubset(layer.parsed, r.net.primitiveIdxs)
            const svg = await parseGerberToSvg(subset)
            const svgVb = withViewBox(svg, layer.vb)
            tex = await renderLayerTexture(svgVb, layer.vb, g, asp, r.color)
          } else continue
          out[r.oKey] = tex
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
  }, [selectedNets, netColors, items, aspect])

  return (
    <div className="app">
      <header className="header">
        <h1>PCB 爆炸图查看器</h1>
        <span className="sub">Gerber Layer Exploder · 爆炸展开 / 平面展开</span>
      </header>

      <aside className="side">
        <DropZone onFiles={handleFiles} busy={busy} />
        {error && (
          <div className="section" style={{ color: '#9b2c2c' }}>
            {error}
          </div>
        )}
        <ExportPanel
          disabled={visibleItems.length === 0}
          count={visibleItems.length}
          onExport={exportPdf}
        />
        <LayerPanel
          items={items}
          visible={visible}
          onToggle={toggle}
          explosion={explosion}
          setExplosion={setExplosion}
          showLabels={showLabels}
          setShowLabels={setShowLabels}
          viewMode={viewMode}
          setViewMode={setViewMode}
        />
        <NetPanel
          items={items}
          mergedNets={mergedNets}
          selected={selectedNets}
          colors={netColors}
          onToggle={(key: string) =>
            setSelectedNets((prev) => {
              const next = new Set(prev)
              if (next.has(key)) next.delete(key)
              else next.add(key)
              return next
            })
          }
          onClear={() => setSelectedNets(new Set())}
          onComputeSpacing={computeSpacing}
          spacingResults={spacingResults}
          spacingComputed={spacingPair != null}
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
            g={gbRef.current ?? undefined}
            marks={spacingMarks}
            viewMode={viewMode}
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
