import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // 相对资源路径：让 Electron 以 file:// 协议加载 dist/index.html 时能正确找到 JS/CSS/gerber-to-svg
  base: './',
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
  },
})
