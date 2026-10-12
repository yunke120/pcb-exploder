// 完整矢量导出验证：ODB++ grid/perPage + Gerber grid，检查 DCTDecode（JPEG 位图，矢量应无）。
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9339
const URL = 'http://127.0.0.1:4199/'
const ODB = 'C:/Users/yk/WorkBuddy/Claw/pcb-exploder/odb.zip'
const GERBER = 'C:/Users/yk/WorkBuddy/Claw/pcb-exploder/gerber_file.zip'
const OUT = 'C:/Users/yk/WorkBuddy/Claw/pcb-exploder/scripts/.shots'
mkdirSync(OUT, { recursive: true })
const log = (...a) => console.log('[verify]', ...a)

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--disable-gpu', '--no-proxy-server', '--user-data-dir=' + OUT + '/profile-v2', 'about:blank'], { stdio: 'ignore' })
let ws, msgId = 0
const pending = new Map()
const consoleErrors = []
function send(m, p = {}) { return new Promise((res, rej) => { const id = ++msgId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p })) }) }
async function ev(expr) { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); return r.result?.value }

async function inject(zip) {
  let oid = null
  for (let i = 0; i < 40; i++) { const r = await send('Runtime.evaluate', { expression: `document.querySelector('input[type=file]')` }); if (r.result?.objectId) { oid = r.result.objectId; break } await sleep(300) }
  if (!oid) throw new Error('input 未出现')
  await send('DOM.setFileInputFiles', { objectId: oid, files: [zip] })
  for (let i = 0; i < 80; i++) { if ((await ev(`document.querySelectorAll('.net-row').length`)) > 0) return; await sleep(400) }
  throw new Error('渲染超时')
}

async function exportOne(label, startIndex) {
  await ev(`document.querySelector('.export-btn')?.click()`)
  let data = null
  for (let i = 0; i < 90; i++) {
    const n = await ev(`window.__pdfBlobs?.length ?? 0`)
    if (n > startIndex) {
      const r = await send('Runtime.evaluate', {
        expression: `(async () => {
          const b = window.__pdfBlobs[${startIndex}];
          const ab = new Uint8Array(await b.arrayBuffer());
          const head = String.fromCharCode(...ab.slice(0, 8));
          const T = 'DCTDecode';
          let hasJpeg = false;
          for (let i = 0; i + T.length <= ab.length; i++) {
            let ok = true;
            for (let j = 0; j < T.length; j++) if (ab[i+j] !== T.charCodeAt(j)) { ok = false; break }
            if (ok) { hasJpeg = true; break }
          }
          return JSON.stringify({ size: b.size, head, hasJpeg });
        })()`,
        returnByValue: true,
        awaitPromise: true,
      })
      data = JSON.parse(r.result?.value || 'null')
      break
    }
    await sleep(500)
  }
  if (!data) { log(label, 'NO BLOB'); return null }
  log(label, JSON.stringify(data))
  return data
}

async function main() {
  let target
  for (let i = 0; i < 40; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); target = l.find(t => t.type === 'page'); if (target) break } catch {} await sleep(300) }
  ws = new WebSocket(target.webSocketDebuggerUrl)
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result) } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') { consoleErrors.push(m.params.args.map(a => a.value ?? a.description ?? '').join(' ')) } else if (m.method === 'Runtime.exceptionThrown') { consoleErrors.push('EXC: ' + (m.params.exceptionDetails?.exception?.description || '')) } })
  await new Promise(r => ws.addEventListener('open', r))
  await send('Page.enable'); await send('Runtime.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const o = URL.createObjectURL.bind(URL); window.__pdfBlobs = []; URL.createObjectURL = (b) => { if (b && b.type === 'application/pdf') window.__pdfBlobs.push(b); return o(b); }; })()` })

  await send('Page.navigate', { url: URL }); await sleep(1500)
  await inject(ODB)
  log('ODB loaded')
  const r1 = await exportOne('odb-grid', 0)
  await ev(`(() => { const s=document.querySelector('.export-select'); s.value='perPage'; s.dispatchEvent(new Event('change',{bubbles:true})); })()`); await sleep(300)
  const r2 = await exportOne('odb-per', 1)

  await send('Page.navigate', { url: URL }); await sleep(1500)
  await inject(GERBER)
  log('GERBER loaded')
  const r3 = await exportOne('gerber-grid', 0) // navigate 后 blob 数组重置，从 0 开始

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT + '/vec-panel.png', Buffer.from(shot.data, 'base64'))
  log('consoleErrors:', consoleErrors.length ? consoleErrors : 'none')
}

main().then(() => { ws?.close(); chrome.kill(); process.exit(0) }).catch(e => { log('FAIL', e.message); ws?.close(); chrome.kill(); process.exit(1) })
