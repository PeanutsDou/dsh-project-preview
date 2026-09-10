/**
 * 用无头 Chrome 打开指定 URL，截图并回答一个 DOM 问题。
 *
 * 用途：验证客户端插件真的把页签渲染出来了 —— 这一层只有浏览器能验，
 * 健康检查和 Node 测试都到不了。
 *
 * 运行： node test/ui-probe.mjs <url> <要查找的文本> <输出png>
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'

const [url, needle, outPath, clickText] = process.argv.slice(2)

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function getJson(target) {
  return new Promise((resolve, reject) => {
    http.get(target, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-probe-'))
const child = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=0',
  `--user-data-dir=${userDataDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--hide-scrollbars', '--mute-audio', '--enable-unsafe-swiftshader',
  '--window-size=1400,900',
  'about:blank',
], { stdio: 'ignore', windowsHide: true })

let port = null
const portFile = path.join(userDataDir, 'DevToolsActivePort')
for (let i = 0; i < 200; i += 1) {
  if (fs.existsSync(portFile)) {
    const parsed = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0])
    if (Number.isInteger(parsed) && parsed > 0) { port = parsed; break }
  }
  await sleep(100)
}
if (port === null) { console.error('起不来'); process.exit(1) }

let target = null
for (let i = 0; i < 60; i += 1) {
  const list = await getJson(`http://127.0.0.1:${port}/json/list`)
  target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (target) break
  await sleep(100)
}

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve) => socket.addEventListener('open', resolve))

/** 控制台错误与网络请求 */
const consoleErrors = []
const requests = []

let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))

  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map((a) => a.value || a.description || '').join(' '))
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    consoleErrors.push('未捕获异常：' + (d.exception?.description ?? d.text))
  }
  if (msg.method === 'Network.requestWillBeSent') {
    requests.push(msg.params.request.url)
  }

  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(msg.error.message))
    else resolve(msg.result)
  }
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url })

// 等 SPA 起来
await sleep(6000)

// 可选：先点一个按钮（比如「新会话」）—— conversation.view 的页签只在会话里出现
if (clickText) {
  // 支持用 | 分隔的点击序列
  for (const step of clickText.split('|')) {
    const clicked = await send('Runtime.evaluate', {
      expression: `(function () {
        const needle = ${JSON.stringify(step.trim())};
        const all = Array.from(document.querySelectorAll('button, a, [role="button"], li, [class*="item"], [class*="row"], div, span'));
        // 优先精确匹配，其次匹配「短文本里包含」的最深元素
        let hit = all.find((e) => (e.innerText || '').trim() === needle);
        if (!hit) {
          const loose = all.filter((e) => {
            const t = (e.innerText || '').trim();
            return t.includes(needle) && t.length < 40;
          });
          hit = loose[loose.length - 1];
        }
        if (!hit) return 'not-found';
        hit.click();
        return 'clicked';
      })()`,
      returnByValue: true,
    })
    console.log('点击「' + step.trim() + '」: ' + clicked.result.value)
    await sleep(4000)
  }
}

const found = await send('Runtime.evaluate', {
  expression: `document.body.innerText.includes(${JSON.stringify(needle)})`,
  returnByValue: true,
})

const tabs = await send('Runtime.evaluate', {
  expression: `JSON.stringify(Array.from(document.querySelectorAll('[role="tab"], button')).map(e => (e.innerText||'').trim()).filter(Boolean).slice(0, 40))`,
  returnByValue: true,
})

const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'))

// 客户端插件是合并成一个请求加载的，检查我的包名在不在清单里
const bundleRequests = requests.filter((u) => u.includes('/plugins/'))
const inBundle = bundleRequests.some((u) => u.includes('dsh-project-preview'))

// 清单里都有谁（只看第三方，便于对比）
const names = bundleRequests
  .flatMap((u) => decodeURIComponent(u).split('??')[1]?.split(',') ?? [])
  .map((p) => p.replace('/client.js', ''))
  .filter((p) => !p.startsWith('@deepseek-ai/'))

console.log(JSON.stringify({
  找到目标文本: found.result.value === true,
  我的客户端bundle被加载: inBundle,
  plugins请求数: bundleRequests.length,
  清单里的第三方插件: names,
  控制台错误: consoleErrors.slice(0, 12),
  截图: outPath,
}, null, 2))

try {
  if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill('SIGKILL')
} catch { /* 已经退出 */ }
try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch { /* 临时目录 */ }
