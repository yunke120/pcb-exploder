// PCB 爆炸图查看器 —— Electron 主进程（CommonJS）
// 目标：Windows 7 离线运行（Electron 22 为最后一个支持 Win7 的版本）
const { app, BrowserWindow, shell, ipcMain } = require('electron')
const path = require('path')
const { readMargins, ensureDefaultConfig } = require('./pdf-config.cjs')

// Win7 老显卡上强制使用较稳妥的渲染路径，避免 WebGL 白屏
app.commandLine.appendSwitch('enable-unsafe-swiftshader')
app.commandLine.appendSwitch('ignore-gpu-blacklist')

// 图纸 PDF 页边距配置：渲染进程通过 IPC 读取（主进程负责定位 pdf-config.json）
ipcMain.handle('pdf-config:margins', () => {
  try {
    return readMargins()
  } catch (e) {
    // 任何异常都不应阻断导出，回退为默认边距
    return { margins: require('./pdf-config.cjs').defaults(), source: null, error: String(e) }
  }
})

function resolveIcon() {
  // 打包后图标由 electron-builder 嵌入 exe；开发/未嵌入时回退到构建资源目录
  const candidates = [
    path.join(__dirname, '..', 'resources', 'icon.png'),
    path.join(process.resourcesPath || '', 'icon.png'),
  ]
  for (const p of candidates) {
    try {
      if (p && require('fs').existsSync(p)) return p
    } catch {
      /* 忽略 */
    }
  }
  return undefined
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0d1a26',
    autoHideMenuBar: true,
    title: 'PCB 爆炸图查看器',
    icon: resolveIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
      // 允许拖入文件后读取内容（无需 node 权限，走标准 File API）
    },
  })

  // 生产：加载打包后的静态产物；开发：可连 vite dev server
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  // 外部链接用系统浏览器打开，避免在应用内跳转
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(() => {
  // 首次运行：若配置缺失，在可写目录写一份默认 pdf-config.json，方便用户修改
  ensureDefaultConfig()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
