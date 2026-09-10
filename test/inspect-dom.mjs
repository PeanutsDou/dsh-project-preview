/**
 * 打开 GUI、进入会话并切到指定页签，然后把 iframe 的父级链高度打出来。
 * 用来定位「预览没有占满高度」这类布局问题。
 *
 * 运行： node test/inspect-dom.mjs <url> <会话名> <页签名>
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'

const [url, sessionName, tabName] = process.argv.slice(2)
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = (t) => new Promise((res, rej) => {
  http.get(t, (r) => { let b = ''; r.on('data', (c) => { b += c }); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } }) }).on('error', rej)
})

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dom-'))
const child = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--window-size=1400,900', 'about:blank'],
  { stdio: 'ignore', windowsHide: true })

let port = null
const pf = path.join(dir, 'DevToolsActivePort')
for (let i = 0; i < 200; i += 1) {
  if (fs.existsSync(pf)) { const p = Number(fs.readFileSync(pf, 'utf8').split(/\r?\n/)[0]); if (p > 0) { port = p; break } }
  await sleep(100)
}
let target = null
for (let i = 0; i < 60; i += 1) {
  const list = await getJson(`http://127.0.0.1:${port}/json/list`)
  target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (target) break
  await sleep(100)
}

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => socket.addEventListener('open', r))
let id = 1
const pend = new Map()
socket.addEventListener('message', (e) => {
  const m = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data))
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) }
})
const send = (method, params = {}) => new Promise((resolve, reject) => { const i = id++; pend.set(i, { resolve, reject }); socket.send(JSON.stringify({ id: i, method, params })) })

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url })
await sleep(6000)

async function clickText(needle) {
  await send('Runtime.evaluate', {
    expression: `(function(){
      const n = ${JSON.stringify(needle)};
      const all = Array.from(document.querySelectorAll('button,a,[role="button"],li,[class*="item"],[class*="row"],div,span'));
      let hit = all.find((e) => (e.innerText||'').trim() === n);
      if (!hit) { const l = all.filter((e) => { const t = (e.innerText||'').trim(); return t.includes(n) && t.length < 40 }); hit = l[l.length-1] }
      if (hit) hit.click();
      return !!hit;
    })()`,
    returnByValue: true,
  })
  await sleep(4000)
}

await clickText(sessionName)
await clickText(tabName)
await sleep(1500)

const probe = `JSON.stringify((function () {
  const f = document.querySelector('iframe[title="前端预览"]');
  if (!f) return { err: 'no iframe' };

  const viewArea = f.parentElement && f.parentElement.parentElement ? f.parentElement.parentElement : null;
  const body = viewArea ? viewArea.parentElement : null;
  const out = {
    iframeH: f.clientHeight,
    viewAreaH: viewArea ? viewArea.clientHeight : null,
    bodyH: body ? body.clientHeight : null,
    bodyPosition: body ? getComputedStyle(body).position : null,
    bodyChildren: []
  };
  if (body) {
    for (const c of body.children) {
      out.bodyChildren.push({
        cls: String(c.className || '').slice(0, 50),
        h: c.clientHeight,
        position: getComputedStyle(c).position,
        flex: getComputedStyle(c).flex,
        txt: (c.innerText || '').trim().slice(0, 30).replace(/\\n/g, ' ')
      });
    }
  }
  return out;
})())`

const info = await send('Runtime.evaluate', { expression: probe, returnByValue: true })
if (info.exceptionDetails) {
  console.log('求值异常:', JSON.stringify(info.exceptionDetails).slice(0, 500))
} else {
  console.log(info.result.value)
}

try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
