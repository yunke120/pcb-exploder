// 验证 PDF 导出：仅导出勾选图层 + 白底。
// 1) 取消勾选一个图层后，按钮层数从 11 → 10；2) 导出 grid PDF blob 生成；
// 3) 探针记录 canvas fillStyle，确认出现白底 #ffffff 且无深色底 #16283a。
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9336
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
  '--user-data-dir=' + OUT + '/profile-pdf3',
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

async function evalJs(expression, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  return r.result.value
}

async function readBlob(index) {
  return evalJs(`new Promise(res => {
    const b = window.__pdfBlobs && window.__pdfBlobs[${index}];
    if (!b) return res(null);
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.readAsDataURL(b);
  })`, true)
}

function parseInfo(dataUrl) {
  if (!dataUrl) return null
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64')
  return { size: buf.length, head: buf.subarray(0, 8).toString('latin1') }
}

async function main() {
  let target
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
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
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    } else if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('EXC: ' + (msg.params.exceptionDetails?.exception?.description || ''))
    }
  })
  await new Promise((r) => ws.addEventListener('open', r))

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const orig = URL.createObjectURL.bind(URL);
      window.__pdfBlobs = [];
      URL.createObjectURL = (blob) => {
        if (blob && blob.type === 'application/pdf') window.__pdfBlobs.push(blob);
        return orig(blob);
      };
      const proto = CanvasRenderingContext2D.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'fillStyle');
      if (desc) {
        window.__fillStyles = [];
        Object.defineProperty(proto, 'fillStyle', {
          get() { return desc.get.call(this); },
          set(v) { if (typeof v === 'string' && !window.__fillStyles.includes(v)) window.__fillStyles.push(v); desc.set.call(this, v); },
        });
      }
    })();`,
  })
  await send('Page.navigate', { url: URL })

  // 等待文件输入框出现，并用 objectId 注入（避免 DOM node id 时序问题）
  let objId = null
  for (let i = 0; i < 40; i++) {
    const r = await send('Runtime.evaluate', { expression: `document.querySelector('input[type=file]')` })
    if (r.result && r.result.objectId) { objId = r.result.objectId; break }
    await sleep(300)
  }
  if (!objId) throw new Error('文件输入框未出现')
  await send('DOM.setFileInputFiles', { objectId: objId, files: [ZIP] })

  for (let i = 0; i < 60; i++) {
    if ((await evalJs(`document.querySelectorAll('.net-row').length`)) > 0) break
    await sleep(500)
  }

  const checked0 = await evalJs(`document.querySelectorAll('.layer-row input[type=checkbox]:checked').length`)
  const btnText0 = await evalJs(`document.querySelector('.export-btn')?.textContent.trim()`)

  // 取消勾选第一个图层
  await evalJs(`document.querySelector('.layer-row input[type=checkbox]').click()`)
  await sleep(200)
  const checked1 = await evalJs(`document.querySelectorAll('.layer-row input[type=checkbox]:checked').length`)
  const btnText1 = await evalJs(`document.querySelector('.export-btn')?.textContent.trim()`)

  // 导出（默认 grid 布局）
  await evalJs(`document.querySelector('.export-btn')?.click()`)
  let data = null
  for (let i = 0; i < 60; i++) {
    if ((await evalJs(`window.__pdfBlobs.length`)) >= 1) { data = await readBlob(0); break }
    await sleep(500)
  }

  const fillStyles = await evalJs(`window.__fillStyles`)
  const hasWhite = Array.isArray(fillStyles) && fillStyles.includes('#ffffff')
  const hasDark = Array.isArray(fillStyles) && fillStyles.includes('#16283a')

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + '/export-white.png', Buffer.from(shot.data, 'base64'))

  console.log(JSON.stringify({
    checkedBefore: checked0,
    btnBefore: btnText0,
    checkedAfterUncheck: checked1,
    btnAfter: btnText1,
    pdf: parseInfo(data),
    whiteBg: hasWhite,
    darkBgStillUsed: hasDark,
    consoleErrors,
  }, null, 2))
}

main()
  .then(() => { ws?.close(); chrome.kill(); process.exit(0) })
  .catch((e) => { console.error('FAIL:', e.message); ws?.close(); chrome.kill(); process.exit(1) })
