// PDF 页边距配置：从程序目录旁的 pdf-config.json 读取，供渲染进程导出图纸 PDF 时使用。
//
// 查找顺序（取第一个存在的文件）：
//   1. PORTABLE_EXECUTABLE_DIR  —— electron-builder 便携版 exe 所在目录（用户可直接修改）
//   2. app.getPath('exe') 所在目录 —— 非便携版（解压目录/安装目录）下的 exe 同级
//   3. 开发态：项目根目录
// 若均不存在，则在首选位置写入一份默认配置，方便用户首次修改。
const fs = require('fs')
const path = require('path')
const { app } = require('electron')

/** 四个方向的默认边距（mm） */
const DEFAULT_MARGIN_MM = 0.2
const KEYS = ['top', 'bottom', 'left', 'right']

function defaults() {
  return { top: DEFAULT_MARGIN_MM, bottom: DEFAULT_MARGIN_MM, left: DEFAULT_MARGIN_MM, right: DEFAULT_MARGIN_MM }
}

/** 候选配置目录，按优先级从高到低 */
function candidateDirs() {
  const dirs = []
  // 便携版：NSIS 脚本会设置 PORTABLE_EXECUTABLE_DIR 为用户 exe 所在目录
  if (process.env.PORTABLE_EXECUTABLE_DIR) dirs.push(process.env.PORTABLE_EXECUTABLE_DIR)
  // 非便携版：exe 同级目录
  try {
    const exeDir = path.dirname(app.getPath('exe'))
    if (exeDir) dirs.push(exeDir)
  } catch {
    /* app 未就绪时忽略 */
  }
  // 开发态：项目根目录（electron/ 的上一级）
  dirs.push(path.join(__dirname, '..'))
  // 去重并保持顺序
  return [...new Set(dirs)]
}

/** 把任意输入规整为非负有限数（mm），非法值回退到默认 */
function normalize(v, fallback) {
  const n = typeof v === 'number' ? v : parseFloat(v)
  if (!Number.isFinite(n) || n < 0) return fallback
  return n
}

/**
 * 读取边距配置。
 * 返回 { margins, source }，source 为实际读取到的文件路径，未找到文件时为 null。
 */
function readMargins() {
  for (const dir of candidateDirs()) {
    const file = path.join(dir, 'pdf-config.json')
    try {
      const raw = fs.readFileSync(file, 'utf8')
      const json = JSON.parse(raw)
      // 同时兼容 { margins: {...} } 与平铺 {...} 两种写法
      const src = json && typeof json === 'object' && json.margins && typeof json.margins === 'object' ? json.margins : json
      const d = defaults()
      const margins = {
        top: normalize(src && src.top, d.top),
        bottom: normalize(src && src.bottom, d.bottom),
        left: normalize(src && src.left, d.left),
        right: normalize(src && src.right, d.right),
      }
      return { margins, source: file }
    } catch {
      // 文件不存在或解析失败 → 继续尝试下一个候选目录
    }
  }
  return { margins: defaults(), source: null }
}

/** 在首选可写目录写入默认配置（仅在缺省时调用） */
function ensureDefaultConfig() {
  for (const dir of candidateDirs()) {
    const file = path.join(dir, 'pdf-config.json')
    if (fs.existsSync(file)) return file
    try {
      const body = {
        _说明: '图纸 PDF 页边距（单位 mm）。在板框四周额外增加的留白，四个方向均可独立设置，默认 0.2。',
        top: DEFAULT_MARGIN_MM,
        bottom: DEFAULT_MARGIN_MM,
        left: DEFAULT_MARGIN_MM,
        right: DEFAULT_MARGIN_MM,
      }
      fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n', 'utf8')
      return file
    } catch {
      // 该目录不可写（如 Program Files），尝试下一个
    }
  }
  return null
}

module.exports = { readMargins, ensureDefaultConfig, defaults, KEYS, DEFAULT_MARGIN_MM }
