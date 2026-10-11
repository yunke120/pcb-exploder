// PCB 爆炸图查看器 —— Electron 主进程（CommonJS）
// 目标：Windows 7 离线运行（Electron 22 为最后一个支持 Win7 的版本）
const { app, BrowserWindow, shell } = require('electron')
const path = require('path')

// Win7 老显卡上强制使用较稳妥的渲染路径，避免 WebGL 白屏
app.commandLine.appendSwitch('enable-unsafe-swiftshader')
app.commandLine.appendSwitch('ignore-gpu-blacklist')

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0d1a26',
    autoHideMenuBar: true,
    title: 'PCB 爆炸图查看器',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
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
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
