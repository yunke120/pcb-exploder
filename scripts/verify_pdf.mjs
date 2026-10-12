// 验证 PDF 导出：注入 odb.zip → 等待渲染 → 点击导出（grid / perPage）
// → 通过 hook URL.createObjectURL 捕获 application/pdf blob，校验文件头/大小，检查 console 错误。
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9335
const URL = 'http://127.0.0.1:4199/'
const ZIP = 'C:/Users/yk/WorkBuddy/Claw/pcb-exploder/odb.zip'
const OUT = 'C:/Users/yk/WorkBuddy/Claw/pcb-exploder/scripts/.shots'
mkdirSync(OUT, { recursive: true })

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--no-first-run',
  '--disable-gpu',
  '--no-proxy-server',
  '--user-data-dir=' + OUT + '/profile-pdf2',
  '--window-size=1400,900',
  'about:blank',
], { stdio: 'ignore' })

let ws
let msgId = 0
const pending = new Map()
const consoleErrors = []

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function readBlob(index) {
  const r = await send('Runtime.evaluate', {
    expression: `new Promise(res => {
      const b = window.__pdfBlobs && window.__pdfBlobs[${index}];
      if (!b) return res(null);
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.readAsDataURL(b);
    })`,
    awaitPromise: true,
    returnByValue: true,
  })
  return r.result.value
}

function parseInfo(dataUrl) {
  if (!dataUrl) return null
  const b64 = dataUrl.split(',')[1]
  const buf = Buffer.from(b64, 'base64')
  return { size: buf.length, head: buf.subarray(0, 8).toString('latin1') }
}

async function main() {
  let target
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`)
      const list = await res.json()
      target = list.find((t) => t.type === 'page')
      if (target) break
    } catch {}
    await sleep(300)
  }
  if (!target) throw new Error('未获取到调试目标')

  ws = new WebSocket(target.webSocketDebuggerUrl)
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      const args = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
      consoleErrors.push(args)
    } else if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('EXC: ' + (msg.params.exceptionDetails?.exception?.description || ''))
    }
  })
  await new Promise((r) => ws.addEventListener('open', r))

  await send('Page.enable')
  await send('Runtime.enable')
  // 在文档加载前 hook createObjectURL，捕获 PDF blob
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const orig = URL.createObjectURL.bind(URL);
      window.__pdfBlobs = [];
      URL.createObjectURL = (blob) => {
        if (blob && blob.type === 'application/pdf') window.__pdfBlobs.push(blob);
        return orig(blob);
      };
    })();`,
  })
  await send('Page.navigate', { url: URL })
  await sleep(1500)

  const { root } = await send('DOM.getDocument')
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' })
  await send('DOM.setFileInputFiles', { nodeId, files: [ZIP] })

  let ready = false
  for (let i = 0; i < 60; i++) {
    const r = await send('Runtime.evaluate', { expression: `document.querySelectorAll('.net-row').length`, returnByValue: true })
    if (r.result.value > 0) { ready = true; break }
    await sleep(500)
  }
  if (!ready) throw new Error('渲染未完成')

  const btnEnabled = await send('Runtime.evaluate', {
    expression: `!document.querySelector('.export-btn')?.disabled`, returnByValue: true,
  })

  // grid 布局导出
  await send('Runtime.evaluate', { expression: `document.querySelector('.export-btn')?.click()` })
  let gridData = null
  for (let i = 0; i < 60; i++) {
    const r = await send('Runtime.evaluate', { expression: `window.__pdfBlobs.length`, returnByValue: true })
    if (r.result.value >= 1) { gridData = await readBlob(0); break }
    await sleep(500)
  }

  // perPage 布局导出
  await send('Runtime.evaluate', {
    expression: `(() => { const s=document.querySelector('.export-select'); s.value='perPage'; s.dispatchEvent(new Event('change',{bubbles:true})); })()`,
  })
  await sleep(300)
  await send('Runtime.evaluate', { expression: `document.querySelector('.export-btn')?.click()` })
  let perData = null
  for (let i = 0; i < 60; i++) {
    const r = await send('Runtime.evaluate', { expression: `window.__pdfBlobs.length`, returnByValue: true })
    if (r.result.value >= 2) { perData = await readBlob(1); break }
    await sleep(500)
  }

  const blobCount = await send('Runtime.evaluate', { expression: `window.__pdfBlobs.length`, returnByValue: true })
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + '/export-panel.png', Buffer.from(shot.data, 'base64'))

  console.log(JSON.stringify({
    btnEnabled: btnEnabled.result.value,
    blobCount: blobCount.result.value,
    grid: parseInfo(gridData),
    perPage: parseInfo(perData),
    consoleErrors,
  }, null, 2))
}

main()
  .then(() => { ws?.close(); chrome.kill(); process.exit(0) })
  .catch((e) => { console.error('FAIL:', e.message); ws?.close(); chrome.kill(); process.exit(1) })
