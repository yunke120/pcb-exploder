import { useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Html } from '@react-three/drei'
import * as THREE from 'three'
import type { LayerItem } from '../App'

interface Props {
  items: LayerItem[]
  aspect: number
  explosion: number
  showLabels: boolean
  overlays: Record<string, import('three').Texture>
}

const BASE_SPACING = 0.07

function LayerMesh({
  item,
  z,
  planeW,
  planeH,
  showLabel,
  overlay,
}: {
  item: LayerItem
  z: number
  planeW: number
  planeH: number
  showLabel: boolean
  overlay?: import('three').Texture
}) {
  const tex = item.texture!
  return (
    <group position={[0, 0, z]}>
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
      {/* 着色后的 Gerber 纹理 */}
      <mesh position={[0, 0, 0.001]}>
        <planeGeometry args={[planeW, planeH]} />
        <meshBasicMaterial
          map={tex}
          transparent
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      {/* 选中网络的高亮叠加层（青色） */}
      {overlay && (
        <mesh position={[0, 0, 0.002]}>
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
      )}
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

export default function ExplosionView({ items, aspect, explosion, showLabels, overlays }: Props) {
  const planeW = aspect >= 1 ? 1 : aspect
  const planeH = aspect >= 1 ? 1 / aspect : 1

  const ordered = useMemo(
    () => items.filter((i) => i.texture).sort((a, b) => a.meta.order - b.meta.order),
    [items],
  )
  const n = ordered.length
  const spacing = BASE_SPACING * explosion

  return (
    <Canvas
      camera={{ position: [1.4, 1.4, 1.2], fov: 42, up: [0, 0, 1] }}
      gl={{ antialias: true, alpha: true }}
      style={{ background: 'radial-gradient(circle at 50% 40%, #1b3346, #0d1a26)' }}
    >
      <ambientLight intensity={0.8} />
      <directionalLight position={[2, 2, 3]} intensity={0.6} />
      {ordered.map((item, i) => {
        const z = (i - (n - 1) / 2) * spacing
        return (
          <LayerMesh
            key={item.id}
            item={item}
            z={z}
            planeW={planeW}
            planeH={planeH}
            showLabel={showLabels}
            overlay={overlays[item.id]}
          />
        )
      })}
      <OrbitControls enableDamping dampingFactor={0.1} makeDefault />
    </Canvas>
  )
}
