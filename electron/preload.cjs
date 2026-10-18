// 预加载脚本：在 contextIsolation 下，仅向渲染进程暴露只读的配置读取能力。
// 不暴露任何 Node/文件系统能力，保持 nodeIntegration: false 的安全边界。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pcbExploder', {
  /** 读取 PDF 页边距配置（mm）。主进程负责定位并解析 pdf-config.json。 */
  getPdfMargins: () => ipcRenderer.invoke('pdf-config:margins'),
})
