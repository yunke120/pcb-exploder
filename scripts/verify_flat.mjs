// 验证「平面展开」视图模式：注入 odb.zip → 等待渲染 → 切换到平面展开 → 截图 + 检查 console 错误。
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9333
const URL = 'http://localhost:4173/'
const ZIP = 'C:/Users/yk/WorkBuddy/Claw/pcb-exploder/odb.zip'
const OUTDIR = 'C:/Users/yk/WorkBuddy/Claw/pcb-exploder/scripts/.shots'
mkdirSync(OUTDIR, { recursive: true })

const chrome = spawn(CHROME, [
  `--headless=new`,
  `--remote-debugging-port=${PORT}`,
  '--no-first-run',
  '--disable-gpu',
  '--user-data-dir=' + OUTDIR + '/profile',
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

async function main() {
  // 等待调试端口
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
  await send('Page.navigate', { url: URL })
  await sleep(1500)

  // 找到隐藏的 file input 并注入 odb.zip
  const doc = await send('Runtime.evaluate', { expression: 'document.querySelector("input[type=file]") ? 1 : 0' })
  const { root } = await send('DOM.getDocument')
  const { nodeId } = await send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: 'input[type=file]',
  })
  await send('DOM.setFileInputFiles', { nodeId, files: [ZIP] })

  // 等待渲染完成（出现 .net-row 或图层纹理）
  let ready = false
  for (let i = 0; i < 60; i++) {
    const r = await send('Runtime.evaluate', {
      expression: `document.querySelectorAll('.net-row').length`,
      returnByValue: true,
    })
    const cnt = r.result.value
    if (cnt > 0) { ready = true; break }
    await sleep(500)
  }
  if (!ready) throw new Error('网络面板未出现，解析可能失败')

  const netCount = await send('Runtime.evaluate', {
    expression: `document.querySelectorAll('.net-row').length`, returnByValue: true,
  })
  const firstNet = await send('Runtime.evaluate', {
    expression: `document.querySelector('.net-row .net-name')?.textContent ?? ''`, returnByValue: true,
  })
  const segBtns = await send('Runtime.evaluate', {
    expression: `[...document.querySelectorAll('.seg-btn')].map(b=>b.textContent)`, returnByValue: true,
  })

  // 切换到平面展开
  await send('Runtime.evaluate', {
    expression: `[...document.querySelectorAll('.seg-btn')].find(b=>b.textContent.includes('平面展开'))?.click()`,
  })
  await sleep(800)

  const activeBtn = await send('Runtime.evaluate', {
    expression: `document.querySelector('.seg-btn.active')?.textContent ?? ''`, returnByValue: true,
  })
  const sliderDisabled = await send('Runtime.evaluate', {
    expression: `document.querySelector('input[type=range]')?.disabled`, returnByValue: true,
  })

  const shot1 = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUTDIR + '/flat.png', Buffer.from(shot1.data, 'base64'))

  // 切回爆炸展开
  await send('Runtime.evaluate', {
    expression: `[...document.querySelectorAll('.seg-btn')].find(b=>b.textContent.includes('爆炸展开'))?.click()`,
  })
  await sleep(500)
  const shot2 = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUTDIR + '/exploded.png', Buffer.from(shot2.data, 'base64'))

  console.log(JSON.stringify({
    netCount: netCount.result.value,
    firstNet: firstNet.result.value,
    segBtns: segBtns.result.value,
    activeAfterFlat: activeBtn.result.value,
    sliderDisabledInFlat: sliderDisabled.result.value,
    consoleErrors,
  }, null, 2))
}

main()
  .then(() => { ws?.close(); chrome.kill(); process.exit(0) })
  .catch((e) => { console.error('FAIL:', e.message); ws?.close(); chrome.kill(); process.exit(1) })
