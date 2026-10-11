// 验证：ODB++ 铜皮（surface）多轮廓解析是否被修复。
// 用 esbuild 打包 src/lib/odb.ts，对本地 odb/ 目录跑 parseOdb，
// 检查铜层 surface 是否按独立轮廓拆分（外轮廓 + 内孔）。
import { build } from 'esbuild'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'odb'

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

const files = walk(ROOT)
const entries = files.map((p) => ({
  path: p.replace(/\\/g, '/'), // 相对路径，保持 / 分隔
  bytes: async () => new Uint8Array(readFileSync(p)),
}))

// 1) 打包 odb.ts（含依赖）为临时 ESM
const result = await build({
  entryPoints: ['src/lib/odb.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  logLevel: 'silent',
})
const code = result.outputFiles[0].text
const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))

const design = await mod.parseOdb(entries)

let totalSurf = 0
let withHoles = 0
let maxHoles = 0
const top = design.layers.find((l) => l.name.toLowerCase() === 'top')
if (!top) throw new Error('未找到 TOP 层')
for (const f of top.features) {
  if (f.kind !== 'surface') continue
  totalSurf++
  const nh = f.holes ? f.holes.length : 0
  if (nh > 0) {
    withHoles++
    maxHoles = Math.max(maxHoles, nh)
  }
}

console.log('TOP 层 surface 总数:', totalSurf)
console.log('含内孔的 surface 数:', withHoles)
console.log('单层最大内孔数:', maxHoles)

// 断言：修复前，所有 surface 的 holes 为空（被合并进 poly）；
// 修复后应能解析出大量带内孔的灌铜轮廓。
let failed = 0
if (withHoles === 0) {
  console.error('FAIL: 没有任何 surface 解析出内孔，多轮廓拆分疑似未生效')
  failed++
}
if (maxHoles < 10) {
  console.error('FAIL: 单层最大内孔数过小，预期存在 16 孔级的灌铜轮廓')
  failed++
}
console.log(failed === 0 ? '\nSURFACE PARSE PASS ✅' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
