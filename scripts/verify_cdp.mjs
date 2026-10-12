// CDP 验证：加载 odb.zip → 两种布局各导出一次（每次全新页面加载），校验 PDF 页数
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9351
const URL_ = 'http://127.0.0.1:4199/'
const ZIP = 'C:/Users/yk/WorkBuddy/Claw/pcb-exploder/odb.zip'
const OUT = 'C:/Users/yk/WorkBuddy/Claw/pcb-exploder/scripts/.shots'
mkdirSync(OUT, { recursive: true })
const log = (...a) => console.log('[cdp]', ...a)
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--disable-gpu', '--no-proxy-server', '--user-data-dir=' + OUT + '/profile-cdp', 'about:blank'], { stdio: 'ignore' })
let ws, msgId = 0; const pending = new Map()
function send(m, p = {}) { return new Promise((res, rej) => { const id = ++msgId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p })) }) }
async function ev(expr, awaitPromise = false) { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise }); return r.result?.value }
let errors = []
async function loadAndExport(layout) {
  // 每次全新加载，避免 React 状态残留
  await send('Page.navigate', { url: URL_ }); await sleep(1500)
  await ev(`window.__pdf = []`)
  let oid = null
  for (let i = 0; i < 40; i++) { const r = await send('Runtime.evaluate', { expression: `document.querySelector('input[type=file]')` }); if (r.result?.objectId) { oid = r.result.objectId; break } await sleep(300) }
  await send('DOM.setFileInputFiles', { objectId: oid, files: [ZIP] })
  for (let i = 0; i < 80; i++) { if ((await ev(`document.querySelectorAll('.net-row').length`)) > 0) break; await sleep(400) }
  if (layout !== 'grid') {
    await ev(`const s=document.querySelector('.export-select'); const st=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; st.call(s,'${layout}'); s.dispatchEvent(new Event('change',{bubbles:true}))`)
  }
  log(`[${layout}] select 值:`, await ev(`document.querySelector('.export-select')?.value`), '| 按钮:', await ev(`document.querySelector('.export-btn')?.textContent?.trim()`))
  await ev(`document.querySelector('.export-btn')?.click()`)
  for (let i = 0; i < 90; i++) { if ((await ev(`window.__pdf?.length`)) > 0) break; await sleep(500) }
  log(`[${layout}] blob 数:`, await ev(`window.__pdf?.length`), '| UI 错误:', await ev(`[...document.querySelectorAll('.side .section')].map(s=>s.textContent.slice(0,120)).join(' | ')`))
  const info = await ev(`(async () => { try { const arr = window.__pdf || []; const b = arr[arr.length-1]; if (!b) return { err: 'no blob' }; const t = await b.text(); const m = t.match(new RegExp('/Count (\\\\d+)')); return { size: b.size, pages: m ? +m[1] : -1 } } catch (e) { return { err: String(e && e.message || e) } } })()`, true)
  log(`[${layout}] PDF:`, JSON.stringify(info))
  return info
}
async function main() {
  let target
  for (let i = 0; i < 40; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); target = l.find(t => t.type === 'page'); if (target) break } catch {} await sleep(300) }
  ws = new WebSocket(target.webSocketDebuggerUrl)
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result) } else if (m.method === 'Runtime.exceptionThrown') { errors.push(m.params.exceptionDetails?.exception?.description?.slice(0, 200)) } else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) { errors.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 200)) } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') { errors.push(m.params.entry.text.slice(0, 200)) } })
  await new Promise(r => ws.addEventListener('open', r))
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const o = URL.createObjectURL.bind(URL); window.__pdf = []; URL.createObjectURL = (b) => { if (b && b.type === 'application/pdf') window.__pdf.push(b); return o(b); }; })()` })
  const g = await loadAndExport('grid')
  const pp = await loadAndExport('perPage')
  log('界面文案:', await ev(`document.querySelector('.dropzone strong')?.textContent`))
  log('console 错误数:', errors.length, errors.slice(0, 3))
  if (!g || g.pages !== 1) throw new Error('grid 页数应为 1，实际 ' + (g && g.pages))
  if (!pp || pp.pages !== 11) throw new Error('perPage 页数应为 11，实际 ' + (pp && pp.pages))
}
main().then(() => { ws?.close(); chrome.kill(); process.exit(errors.length ? 1 : 0) }).catch(e => { log('FAIL', e.message); ws?.close(); chrome.kill(); process.exit(1) })
