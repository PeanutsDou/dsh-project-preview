/**
 * dsh-project-preview — Client 半。
 *
 * 在「对话 / 轨迹」那一排页签里加一个「前端预览」。
 *
 * 关键点：注册到 **conversation.view** 插槽（会话级），而不是某个全局工作区。
 * 因为每个会话开发的项目不一样，预览必须是**按会话隔离**的——
 * 插槽的 inject 回调会把 sessionId 传进来，正好用来区分。
 *
 * 这里刻意**不 import 任何 @deepseek-ai/* 的类型**：
 * 它们是运行时才存在的平台模块，构建期解析不到（详见 src/dsh-shims.d.ts 的说明）。
 * ctx 用结构化类型描述，够用且不引入构建依赖。
 */
import { useEffect, useState } from 'react'

export const name = 'dsh-project-preview-client'

/** 客户端服务名：插槽注册表 */
export const inject = ['slots']

const STATE_API = '/__dsh-project-preview/state'

/** 轮询间隔。一秒对「改完切过去看」够用，且几乎没有出错余地 */
const POLL_MS = 1000

/** 超过这么久还没触发 onLoad，就提示可能是被拒绝嵌入 */
const STALL_MS = 6000

interface PreviewState {
  url: string | null
  title: string
  version: number
  updatedAt: number
}

/** 用中性半透明色，白天/夜间主题都能看 */
const LINE = 'rgba(127,127,127,0.28)'
const SOFT = 'rgba(127,127,127,0.10)'
const DIM = 'rgba(127,127,127,0.95)'

const buttonStyle: React.CSSProperties = {
  flex: 'none',
  padding: '2px 8px',
  border: `1px solid ${LINE}`,
  borderRadius: '5px',
  background: 'transparent',
  color: 'inherit',
  fontSize: '12px',
  cursor: 'pointer',
  lineHeight: '18px',
}

function Toolbar(props: { title: string; url: string; onRefresh: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 10px',
        borderBottom: `1px solid ${LINE}`,
        background: SOFT,
        fontSize: '12px',
        flex: 'none',
      }}
    >
      <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{props.title || '前端预览'}</span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          opacity: 0.7,
          fontFamily: 'ui-monospace, Consolas, monospace',
        }}
        title={props.url}
      >
        {props.url}
      </span>
      <button type="button" onClick={props.onRefresh} style={buttonStyle}>
        刷新
      </button>
      <a
        href={props.url}
        target="_blank"
        rel="noreferrer"
        style={{ ...buttonStyle, textDecoration: 'none', color: 'inherit' }}
      >
        在外部打开
      </a>
    </div>
  )
}

function Centered(props: { children?: React.ReactNode }) {
  return (
    <div
      style={{
        ...FILL_STYLE,
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        textAlign: 'center',
      }}
    >
      {props.children}
    </div>
  )
}

/**
 * 切到「前端预览」时，把底部的输入框**藏起来**，让预览占满整个会话区。
 *
 * 不这么做的话：会话正文是 824px，而插槽给视图的容器只有 696px——
 * 差的 128px 被输入框占着，预览被截掉一块。
 *
 * 用隐藏而不是「绝对定位盖上去」，是因为隐藏让布局自然长满：
 * 输入框一从文档流里消失，视图容器自己就会撑到 824px，
 * 不用跟 DSH 的层级较劲，也不会盖错东西。
 *
 * 钩子是 DSH 自己暴露的 `data-composer-seat`（不是哈希类名，跨版本稳）。
 * 卸载时原样恢复。
 */
function useHideComposer(): void {
  useEffect(() => {
    const seats = Array.from(document.querySelectorAll<HTMLElement>('[data-composer-seat]'))
    const saved = seats.map((element) => ({ element, display: element.style.display }))

    for (const { element } of saved) element.style.display = 'none'

    return () => {
      for (const { element, display } of saved) element.style.display = display
    }
  }, [])
}

/** 视图在文档流里撑满可用高度 */
const FILL_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
}

function ProjectPreviewView(props: { sessionId?: string }) {
  useHideComposer()

  const sessionId = props?.sessionId ?? ''

  const [state, setState] = useState<PreviewState | null>(null)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [stalled, setStalled] = useState(false)
  /** 本地刷新计数：用户点「刷新」时 +1，和 host 的 version 一起决定 iframe 的 key */
  const [localBump, setLocalBump] = useState(0)

  // ── 轮询 host 状态 ────────────────────────────────────────
  useEffect(() => {
    if (sessionId === '') return undefined

    let alive = true
    let timer = 0

    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(`${STATE_API}?sessionId=${encodeURIComponent(sessionId)}`)
        const data = (await response.json()) as { ok?: boolean; state?: PreviewState; error?: string }
        if (!alive) return

        if (data?.ok === true && data.state !== undefined) {
          setState(data.state)
          setError('')
        } else {
          setError(data?.error ?? '读取预览状态失败')
        }
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause))
      }

      if (alive) timer = window.setTimeout(() => { void poll() }, POLL_MS)
    }

    void poll()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [sessionId])

  const url = state?.url ?? null
  const version = state?.version ?? 0

  // 换地址 / 刷新时重置加载状态，并起一个「卡住了」计时器
  useEffect(() => {
    if (url === null) return undefined

    setLoaded(false)
    setStalled(false)

    const timer = window.setTimeout(() => { setStalled(true) }, STALL_MS)
    return () => { window.clearTimeout(timer) }
  }, [url, version, localBump])

  if (sessionId === '') {
    return <Centered>拿不到会话 id，预览不可用。</Centered>
  }

  if (url === null) {
    return (
      <Centered>
        <div style={{ fontSize: '13px', marginBottom: '6px' }}>这个会话还没有挂载预览</div>
        <div style={{ fontSize: '12px', color: DIM, lineHeight: 1.7 }}>
          让 AI 把它正在开发的前端挂上来即可——
          <br />
          它会调用 project_preview 工具，这里就会自动出现。
        </div>
        {error !== '' ? (
          <div style={{ fontSize: '11px', color: '#f87171', marginTop: '10px' }}>{error}</div>
        ) : null}
      </Centered>
    )
  }

  return (
    <div style={FILL_STYLE}>
      <Toolbar
        title={state?.title ?? ''}
        url={url}
        onRefresh={() => { setLocalBump((n) => n + 1) }}
      />

      {stalled && !loaded ? (
        <div
          style={{
            padding: '6px 10px',
            fontSize: '12px',
            background: 'rgba(251,191,36,0.12)',
            borderBottom: `1px solid ${LINE}`,
            flex: 'none',
          }}
        >
          这个地址加载超过 {Math.round(STALL_MS / 1000)} 秒还没就绪。有些页面会禁止被嵌入
          （Electron 应用，或响应头带 X-Frame-Options），点上面的「在外部打开」可以直接看。
        </div>
      ) : null}

      <iframe
        // key 变了就重新挂载 iframe —— 这是最可靠的「刷新」方式，
        // 跨域时不能调 contentWindow.location.reload()
        key={`${version}-${localBump}`}
        src={url}
        title="前端预览"
        onLoad={() => { setLoaded(true) }}
        style={{ flex: 1, width: '100%', minHeight: 0, border: 'none', background: '#ffffff' }}
      />
    </div>
  )
}

/** 只描述用到的部分：插槽注册表 */
interface SlotsService {
  inject: (name: string, factory: () => unknown) => void
  register: (options: Record<string, unknown>, component: unknown) => unknown
}

export function apply(ctx: { slots: SlotsService }): void {
  // conversation.view 的注册项就是「对话 / 轨迹」那一排里的一个页签。
  // 第二个参数是渲染它的组件；inject 回调拿到 sessionId，用来做会话隔离。
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: 'project-preview',
        // 对话是 0，轨迹是 10；排在它们后面
        order: 20,
        label: () => '前端预览',
        inject: (sessionId: string) => ({ sessionId }),
      },
      ProjectPreviewView,
    ),
  )
}
