/**
 * 找出会话输入框（composer）在 DOM 里的位置、稳定的选择器钩子，
 * 以及它和视图容器的兄弟关系。用于决定「隐藏输入框」怎么实现最稳。
 *
 * 运行： node test/probe-composer.mjs <url> [会话名]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'

const [url, sessionName] = process.argv.slice(2)
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = (t) => new Promise((res, rej) => {
  http.get(t, (r) => { let b = ''; r.on('data', (c) => { b += c }); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } }) }).on('error', rej)
})

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-comp-'))
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

if (sessionName) {
  await send('Runtime.evaluate', {
    expression: `(function(){
      const n = ${JSON.stringify(sessionName)};
      const all = Array.from(document.querySelectorAll('button,a,[role="button"],li,div,span'));
      let hit = all.find((e) => (e.innerText||'').trim() === n);
      if (!hit) { const l = all.filter((e) => { const t=(e.innerText||'').trim(); return t.includes(n) && t.length < 40 }); hit = l[l.length-1] }
      if (hit) hit.click();
      return !!hit;
    })()`,
    returnByValue: true,
  })
  await sleep(4000)
}

const probe = `JSON.stringify((function () {
  // 输入框：contenteditable 或者 textarea
  const editable = document.querySelector('[contenteditable="true"], textarea');
  const out = { editable: null, editableChain: [], dataHooks: [], scrollBodyChildren: [] };

  if (editable) {
    out.editable = editable.tagName.toLowerCase() + ' ' + String(editable.className || '').slice(0, 60);
    let n = editable;
    for (let i = 0; i < 8 && n; i += 1) {
      const ds = [];
      for (const a of n.attributes || []) if (a.name.startsWith('data-')) ds.push(a.name + '=' + a.value.slice(0, 30));
      out.editableChain.push({
        lvl: i,
        tag: n.tagName.toLowerCase(),
        cls: String(n.className || '').split(' ').slice(0, 3).join(' ').slice(0, 60),
        data: ds,
        h: n.clientHeight,
        pos: getComputedStyle(n).position,
      });
      n = n.parentElement;
    }
  }

  // 页面上所有 data-* 钩子
  const hooks = new Set();
  for (const el of document.querySelectorAll('*')) {
    for (const a of el.attributes || []) if (a.name.startsWith('data-')) hooks.add(a.name);
  }
  out.dataHooks = Array.from(hooks);

  // scrollBody 的子节点
  const sb = document.querySelector('[class*="scrollBody"]');
  if (sb) {
    for (const c of sb.children) {
      out.scrollBodyChildren.push({
        cls: String(c.className || '').slice(0, 60),
        h: c.clientHeight,
        pos: getComputedStyle(c).position,
        hasEditable: c.contains(document.querySelector('[contenteditable="true"], textarea')),
        txt: (c.innerText || '').trim().slice(0, 40).replace(/\\n/g, ' / '),
      });
    }
  }
  return out;
})())`

const info = await send('Runtime.evaluate', { expression: probe, returnByValue: true })
console.log(info.exceptionDetails ? '求值异常: ' + JSON.stringify(info.exceptionDetails).slice(0, 400) : info.result.value)

try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
