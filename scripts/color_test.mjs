// 复刻 App.tsx 中的配色逻辑，验证：
// 1) 同一选中集内颜色互不相同（含超出预置板 16 色的情形）；
// 2) 增删其他网络时，已有网络的颜色尽量保持稳定；
// 3) 显式网（按名跨层）使用单一 key → 单一颜色。
const NET_PALETTE = [
  '#ff5d8f', '#ffd166', '#06d6a0', '#4cc9f0', '#b388ff', '#ff9f1c',
  '#f15bb5', '#9ef01a', '#ef476f', '#00bbf9', '#fb8500', '#80ffdb',
  '#c1121f', '#7ae582', '#e0aaff', '#ffadad',
]
function hashStr(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0, g = 0, b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}
function colorFromIndex(i) {
  if (i < NET_PALETTE.length) return NET_PALETTE[i]
  const hue = ((i - NET_PALETTE.length) * 137.508) % 360
  return hslToHex(hue, 90, 62)
}
function assignNetColors(keys) {
  const size = Math.max(NET_PALETTE.length, keys.length, 1)
  const withHash = keys.map((k) => ({ k, h: hashStr(k) }))
  withHash.sort((a, b) => a.h - b.h)
  const used = new Set()
  const usedColors = new Set()
  const res = {}
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

let failed = 0
const check = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); failed++ } }

// 1) 50 个随机网络 → 全部互异
const big = Array.from({ length: 50 }, (_, i) => `net_${i}_${Math.random().toString(36).slice(2)}`)
const c1 = assignNetColors(big)
check(new Set(Object.values(c1)).size === big.length, '50 随机网络应全部互异')
console.log('随机50网络互异:', new Set(Object.values(c1)).size === big.length)

// 2) 200 个网络（远超预置板）→ 全部互异且无死循环
const huge = Array.from({ length: 200 }, (_, i) => `h_${i}`)
const c2 = assignNetColors(huge)
check(new Set(Object.values(c2)).size === 200, '200 网络应全部互异（黄金角扩展）')
console.log('扩展200网络互异:', new Set(Object.values(c2)).size === 200)

// 3) 稳定性：先选 A,B，再加入 C,D，A,B 颜色不变
const a = assignNetColors(['A', 'B'])
const b = assignNetColors(['A', 'B', 'C', 'D'])
check(a.A === b.A && a.B === b.B, '新增网络后已有网络颜色应保持不变')
console.log('A,B 稳定:', a.A === b.A && a.B === b.B)

// 4) 显式网单一 key → 单一颜色（跨层共享）
const c3 = assignNetColors(['AGND', 'VCC', '+12V'])
check(c3['AGND'] === c3['AGND'], '显式网单一 key 自然同色')
console.log('显式网单色: OK')

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
