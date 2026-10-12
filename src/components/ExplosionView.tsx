import { useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Html } from '@react-three/drei'
import * as THREE from 'three'
import type { LayerItem, SpacingMark } from '../App'
import type { GlobalBox } from '../lib/geometry'

interface Props {
  items: LayerItem[]
  aspect: number
  explosion: number
  showLabels: boolean
  overlays: Record<string, import('three').Texture>
  g?: GlobalBox
  marks: SpacingMark[]
  viewMode: 'exploded' | 'flat'
}

const BASE_SPACING = 0.07

/** 平面展开网格参数 */
const FLAT_GAP = 0.22
const FLAT_TARGET = 2.4

/** 每个可见图层在 3D 世界中的位置与缩放 */
interface Placement {
  x: number
  y: number
  z: number
  scale: number
}

/** 爆炸展开：各层沿 Z 轴等距展开 */
function explodedPlacements(n: number, spacing: number): Placement[] {
  return Array.from({ length: n }, (_, i) => ({
    x: 0,
    y: 0,
    z: (i - (n - 1) / 2) * spacing,
    scale: 1,
  }))
}

/** 平面展开：各层在 XY 平面内按网格铺开，单层保持原有宽高比 */
function flatPlacements(n: number, planeW: number, planeH: number): Placement[] {
  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  const scale = Math.max(
    0.05,
    Math.min(
      (FLAT_TARGET - (cols - 1) * FLAT_GAP) / (cols * planeW),
      (FLAT_TARGET - (rows - 1) * FLAT_GAP) / (rows * planeH),
      1,
    ),
  )
  const cw = planeW * scale
  const ch = planeH * scale
  const gw = cols * cw + (cols - 1) * FLAT_GAP
  const gh = rows * ch + (rows - 1) * FLAT_GAP
  const out: Placement[] = []
  for (let i = 0; i < n; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    out.push({
      x: -gw / 2 + col * (cw + FLAT_GAP) + cw / 2,
      y: gh / 2 - row * (ch + FLAT_GAP) - ch / 2,
      z: 0,
      scale,
    })
  }
  return out
}

function LayerMesh({
  item,
  placement,
  planeW,
  planeH,
  showLabel,
  overlayTextures,
}: {
  item: LayerItem
  placement: Placement
  planeW: number
  planeH: number
  showLabel: boolean
  overlayTextures?: import('three').Texture[]
}) {
  const tex = item.texture!
  return (
    <group
      position={[placement.x, placement.y, placement.z]}
      scale={[placement.scale, placement.scale, 1]}
    >
      {/* 半透明底板，体现该层的“薄片”范围 */}
      <mesh>
        <planeGeometry args={[planeW, planeH]} />
        <meshBasicMaterial
          color={item.meta.color}
          transparent
          opacity={0.1}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      {/* 着色后的图层纹理 */}
      <mesh position={[0, 0, 0.001]}>
        <planeGeometry args={[planeW, planeH]} />
        <meshBasicMaterial
          map={tex}
          transparent
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      {/* 选中网络的高亮叠加层（每个网络一种颜色，叠加混合） */}
      {overlayTextures?.map((overlay, i) => (
        <mesh key={i} position={[0, 0, 0.002 + i * 0.0005]}>
          <planeGeometry args={[planeW, planeH]} />
          <meshBasicMaterial
            map={overlay}
            transparent
            side={THREE.DoubleSide}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            toneMapped={false}
          />
        </mesh>
      ))}
      {showLabel && (
        <Html position={[-planeW / 2, planeH / 2 + 0.04, 0]} center={false}>
          <div
            style={{
              whiteSpace: 'nowrap',
              fontSize: 11,
              fontFamily: 'Georgia, serif',
              color: '#e8f0f8',
              background: 'rgba(17,32,47,0.7)',
              padding: '2px 6px',
              borderRadius: 4,
              borderLeft: `3px solid ${item.meta.color}`,
            }}
          >
            {item.meta.name}
          </div>
        </Html>
      )}
    </group>
  )
}

/** 板坐标(mm) → 该层平面局部 3D 坐标（与渲染管线同一映射，保证对齐） */
function boardToPlane(
  bx: number,
  by: number,
  g: GlobalBox,
  planeW: number,
  planeH: number,
): { x: number; y: number } {
  return {
    x: ((bx - g.minX) / g.w) * planeW - planeW / 2,
    y: ((by - g.minY) / g.h) * planeH - planeH / 2,
  }
}

function SpacingMarker({
  mark,
  placement,
  planeW,
  planeH,
  g,
}: {
  mark: SpacingMark
  placement: Placement
  planeW: number
  planeH: number
  g: GlobalBox
}) {
  const la = boardToPlane(mark.pA[0], mark.pA[1], g, planeW, planeH)
  const lb = boardToPlane(mark.pB[0], mark.pB[1], g, planeW, planeH)
  const a = { x: placement.x + la.x * placement.scale, y: placement.y + la.y * placement.scale }
  const b = { x: placement.x + lb.x * placement.scale, y: placement.y + lb.y * placement.scale }
  const mx = (a.x + b.x) / 2
  const my = (a.y + b.y) / 2
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  const ang = Math.atan2(b.y - a.y, b.x - a.x)
  const zz = placement.z + 0.003
  return (
    <group>
      {/* 最近点连线（亮红色细线，贴合所在层） */}
      {len > 1e-6 && (
        <mesh position={[mx, my, zz]} rotation={[0, 0, ang]}>
          <planeGeometry args={[len, 0.0012]} />
          <meshBasicMaterial
            color="#ff2b2b"
            transparent
            opacity={1}
            depthTest={false}
            toneMapped={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
      {/* 距离标签 */}
      <Html position={[mx, my, zz + 0.02]} center>
        <div
          style={{
            whiteSpace: 'nowrap',
            fontSize: 12,
            fontFamily: 'Menlo, Consolas, monospace',
            fontWeight: 600,
            color: '#ffffff',
            background: '#ff2b2b',
            padding: '2px 7px',
            borderRadius: 4,
            boxShadow: '0 1px 4px rgba(0,0,0,0.5)',
          }}
        >
          {mark.distance.toFixed(3)} mm
        </div>
      </Html>
    </group>
  )
}

export default function ExplosionView({
  items,
  aspect,
  explosion,
  showLabels,
  overlays,
  g,
  marks,
  viewMode,
}: Props) {
  const planeW = aspect >= 1 ? 1 : aspect
  const planeH = aspect >= 1 ? 1 / aspect : 1

  const ordered = useMemo(
    () => items.filter((i) => i.texture).sort((a, b) => a.meta.order - b.meta.order),
    [items],
  )
  const n = ordered.length
  const spacing = BASE_SPACING * explosion

  const placements = useMemo<Placement[]>(
    () =>
      viewMode === 'flat'
        ? flatPlacements(n, planeW, planeH)
        : explodedPlacements(n, spacing),
    [viewMode, n, planeW, planeH, spacing],
  )

  return (
    <Canvas
      camera={{ position: [1.4, 1.4, 1.2], fov: 42, up: [0, 0, 1] }}
      gl={{ antialias: true, alpha: true }}
      style={{ background: 'radial-gradient(circle at 50% 40%, #1b3346, #0d1a26)' }}
    >
      <ambientLight intensity={0.8} />
      <directionalLight position={[2, 2, 3]} intensity={0.6} />
      {ordered.map((item, i) => {
        const overlayTextures = Object.entries(overlays)
          .filter(([k]) => k.startsWith(item.id + '::'))
          .map(([, t]) => t)
        return (
          <LayerMesh
            key={item.id}
            item={item}
            placement={placements[i]}
            planeW={planeW}
            planeH={planeH}
            showLabel={showLabels}
            overlayTextures={overlayTextures}
          />
        )
      })}
      {g &&
        marks.map((mark) => {
          const idx = ordered.findIndex((i) => i.id === mark.layerId)
          if (idx < 0) return null
          return (
            <SpacingMarker
              key={mark.layerId}
              mark={mark}
              placement={placements[idx]}
              planeW={planeW}
              planeH={planeH}
              g={g}
            />
          )
        })}
      <OrbitControls enableDamping dampingFactor={0.1} makeDefault />
    </Canvas>
  )
}
