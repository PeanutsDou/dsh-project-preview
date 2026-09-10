/**
 * Host 半的独立冒烟测试 —— 不依赖 DSH 上下文。
 *
 * 做法：造一个假的 ctx，把插件注册的路由和工具**截获下来**，
 * 然后直接调用它们，检查行为。这样在装进 DSH 之前就能确认逻辑是对的，
 * 不用靠「重启 DSH 试一下」来调试。
 *
 * 运行： node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { apply, name, inject } from '../lib/index.js'

let passed = 0
function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log('  \u2713 ' + label)
  } else {
    console.log('  \u2717 ' + label + (detail ? '  \u2192 ' + detail : ''))
    process.exitCode = 1
  }
}

// ── 造假 ctx，截获注册 ────────────────────────────────────────
let route = null
let tool = null

const ctx = {
  webServer: { register: (r) => { route = r; return () => { route = null } } },
  tools: { register: (t) => { tool = t; return () => { tool = null } } },
  effect: (fn) => { fn() },
}

apply(ctx)

check('导出 name', name === 'dsh-project-preview', String(name))
check('inject 只要 webServer 与 tools', JSON.stringify(inject) === JSON.stringify(['webServer', 'tools']), JSON.stringify(inject))
check('注册了路由', route !== null && route.kind === 'prefix')
check('路由前缀正确', route !== null && route.path === '/__dsh-project-preview', route && route.path)
check('注册了工具', tool !== null)
check('工具名是 project_preview', tool !== null && tool.name === 'project_preview', tool && tool.name)

// ── 假 req / res ──────────────────────────────────────────────
function fakeExchange(url) {
  const captured = { code: 0, body: '' }
  const res = {
    writeHead(code) { captured.code = code },
    end(body) { captured.body = body },
  }
  return { req: { url }, res, captured }
}

function stateOf(sessionId) {
  const ex = fakeExchange('/__dsh-project-preview/state?sessionId=' + encodeURIComponent(sessionId))
  route.handler(ex.req, ex.res)
  assert.equal(ex.captured.code, 200)
  return JSON.parse(ex.captured.body)
}

function callTool(args, sessionId) {
  return tool.execute(args, {
    agent: { session: { header: { id: sessionId } } },
  })
}

// ── 路由 ──────────────────────────────────────────────────────
const missing = fakeExchange('/__dsh-project-preview/state')
route.handler(missing.req, missing.res)
check('缺 sessionId 返回 400', missing.captured.code === 400, String(missing.captured.code))

const notFound = fakeExchange('/__dsh-project-preview/nope')
route.handler(notFound.req, notFound.res)
check('未知路径返回 404', notFound.captured.code === 404, String(notFound.captured.code))

const initial = stateOf('s1')
check('初始状态是未挂载', initial.ok === true && initial.state.url === null, JSON.stringify(initial))

// ── 工具：会话隔离 ────────────────────────────────────────────
await callTool({ action: 'show', url: 'http://127.0.0.1:8123/engine/index.html', title: '瓦片引擎' }, 's1')

const s1 = stateOf('s1')
const s2 = stateOf('s2')
check('show 之后本会话有地址', s1.state.url === 'http://127.0.0.1:8123/engine/index.html', JSON.stringify(s1.state))
check('标题写进去了', s1.state.title === '瓦片引擎', s1.state.title)
check('version 递增到 1', s1.state.version === 1, String(s1.state.version))
check('**别的会话看不到**（会话隔离）', s2.state.url === null, JSON.stringify(s2.state))

// ── 工具：刷新 ────────────────────────────────────────────────
const refreshed = await callTool({ action: 'refresh' }, 's1')
check('refresh 成功', refreshed.ok === true, JSON.stringify(refreshed))
check('refresh 只涨 version，地址不变', stateOf('s1').state.version === 2 && stateOf('s1').state.url === 'http://127.0.0.1:8123/engine/index.html')

// ── 工具：校验与边界 ──────────────────────────────────────────
const badUrl = await callTool({ action: 'show', url: 'javascript:alert(1)' }, 's1')
check('拒绝 javascript: 伪协议', badUrl.ok === false, JSON.stringify(badUrl))

const badUrl2 = await callTool({ action: 'show', url: '不是网址' }, 's1')
check('拒绝非法地址', badUrl2.ok === false, JSON.stringify(badUrl2))

const badAction = await callTool({ action: 'nope' }, 's1')
check('拒绝未知 action', badAction.ok === false, JSON.stringify(badAction))

const noSession = await tool.execute({ action: 'status' }, {})
check('拿不到会话 id 时明确报错', noSession.ok === false, JSON.stringify(noSession))

const s2Refresh = await callTool({ action: 'refresh' }, 's2')
check('没挂载就刷新会报错', s2Refresh.ok === false, JSON.stringify(s2Refresh))

// ── 工具：status / clear ──────────────────────────────────────
const status = await callTool({ action: 'status' }, 's1')
check('status 返回当前状态', status.ok === true && status.state.url !== null, JSON.stringify(status))

await callTool({ action: 'clear' }, 's1')
check('clear 之后回到未挂载', stateOf('s1').state.url === null)

console.log('')
console.log(process.exitCode === 1 ? '  有失败项' : `  全部通过：${passed} 项检查`)
