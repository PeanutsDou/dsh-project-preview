/**
 * dsh-project-preview — Host 半。
 *
 * 职责只有两件：
 * 1. 按**会话**记住「这个会话要预览哪个地址」，用一个只读 HTTP 路由暴露给前端；
 * 2. 注册一个 AI 工具 project_preview，让模型能主动挂载 / 刷新 / 查询。
 *
 * 刻意不做的事：不托管文件、不起进程、不读工作区。
 * 预览的目标就是你自己的 dev server（或任何 http 地址），插件只负责「显示它」。
 * 权限面因此只有 webServer + tools 两个服务。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-project-preview'

/** 只需要这两个服务：一个注册路由，一个注册工具 */
export const inject = ['webServer', 'tools']

/** 路由前缀。用 __dsh- 开头，避开项目的真实路径 */
const ROUTE_PREFIX = '/__dsh-project-preview'

/** 单个会话的预览状态 */
interface PreviewState {
  /** 要显示的地址；null = 还没挂载 */
  url: string | null
  /** 页签里显示的项目名 */
  title: string
  /** 每次挂载/刷新递增。前端看到它变了就重新加载 iframe */
  version: number
  /** 最后一次变更的时间戳（毫秒） */
  updatedAt: number
}

const sessions = new Map<string, PreviewState>()

function stateOf(sessionId: string): PreviewState {
  let state = sessions.get(sessionId)
  if (state === undefined) {
    state = { url: null, title: '', version: 0, updatedAt: 0 }
    sessions.set(sessionId, state)
  }
  return state
}

function sendJson(res: ServerResponse, code: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 只接受 http/https：别让 javascript: 之类的东西进 iframe */
function normalizeUrl(raw: string): string | null {
  const text = raw.trim()
  if (text === '') return null

  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return null
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return parsed.toString()
}

/** 从工具执行上下文里认出当前会话 */
function sessionIdOf(exec: unknown): string {
  const agent = (exec as { agent?: { session?: { header?: { id?: unknown } } } } | undefined)?.agent
  const id = agent?.session?.header?.id
  return typeof id === 'string' ? id : ''
}

const DESCRIPTION = [
  '把正在开发的前端项目挂到会话内的「前端预览」页签，或让它刷新。',
  '',
  '什么时候用：',
  '- 你刚做出或改动了带界面的东西（网页、编辑器、可视化），想让人直接看到效果时，用 action="show" 挂上去；',
  '- 改完之后用 action="refresh" 让它重新加载，不要让人手动按 F5；',
  '- 挂载/刷新之后，告诉用户「切到「前端预览」页签看」。',
  '',
  '这个页签是**按会话隔离**的：你在哪个会话调用，就只有那个会话看得到。',
  '',
  'action：',
  '- show：挂载地址。参数 url 必填（http/https），title 可选（页签里显示的项目名）',
  '- refresh：让当前地址重新加载（地址没变，只是重载）',
  '- status：查询当前挂的是哪个地址',
  '- clear：清空当前会话的预览',
].join('\n')

export function apply(ctx: {
  webServer: { register: (route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }) => () => void }
  tools: { register: (tool: unknown) => () => void }
  effect: (fn: () => unknown, label?: string) => void
}): void {
  // ── 只读状态路由 ────────────────────────────────────────────
  // 前端每秒拉一次。用轮询而不是 SSE/WebSocket：一秒延迟对「改完切过去看」
  // 完全够用，而且几乎没有出错的余地。
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => {
          const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1')

          if (requestUrl.pathname === ROUTE_PREFIX + '/state') {
            const sessionId = requestUrl.searchParams.get('sessionId') ?? ''
            if (sessionId === '') {
              sendJson(res, 400, { ok: false, error: 'sessionId is required' })
              return
            }
            sendJson(res, 200, { ok: true, state: stateOf(sessionId) })
            return
          }

          sendJson(res, 404, { ok: false, error: 'not found' })
        },
      }),
    'dsh-project-preview: session preview state',
  )

  // ── AI 工具 ─────────────────────────────────────────────────
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'project_preview',
          description: DESCRIPTION,
          parameters: {
            action: {
              type: 'string',
              required: true,
              description: 'show / refresh / status / clear',
            },
            url: {
              type: 'string',
              description: 'action="show" 时必填：要显示的项目地址，必须是 http 或 https',
            },
            title: {
              type: 'string',
              description: '可选：页签工具栏里显示的项目名',
            },
          },
          output: {
            schema: { type: 'json' },
            render: (_args: unknown, value: unknown) => [
              { type: 'text', text: JSON.stringify(value, null, 2) },
            ],
          },
          timeoutMs: 10000,
          async execute(args: Record<string, unknown>, exec: unknown) {
            const sessionId = sessionIdOf(exec)
            if (sessionId === '') {
              return { ok: false, error: '拿不到当前会话 id，无法定位预览页签' }
            }

            const action = String(args.action ?? '').trim()
            const state = stateOf(sessionId)

            if (action === 'show') {
              const url = normalizeUrl(String(args.url ?? ''))
              if (url === null) {
                return { ok: false, error: 'url 必须是合法的 http/https 地址' }
              }

              state.url = url
              state.title = String(args.title ?? '').trim()
              state.version += 1
              state.updatedAt = Date.now()

              return {
                ok: true,
                action,
                url: state.url,
                version: state.version,
                hint: '已挂到「前端预览」页签，告诉用户切过去看',
              }
            }

            if (action === 'refresh') {
              if (state.url === null) {
                return { ok: false, error: '当前会话还没有挂载预览，先调用 action="show"' }
              }

              state.version += 1
              state.updatedAt = Date.now()

              return { ok: true, action, url: state.url, version: state.version, hint: '已刷新，用户可以切过去看最新效果' }
            }

            if (action === 'status') {
              return { ok: true, action, state }
            }

            if (action === 'clear') {
              state.url = null
              state.title = ''
              state.version += 1
              state.updatedAt = Date.now()
              return { ok: true, action }
            }

            return { ok: false, error: `不认识的 action："${action}"，可用：show / refresh / status / clear` }
          },
        }),
      ),
    'dsh-project-preview: project_preview tool',
  )
}
