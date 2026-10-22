/**
 * TickList 日历 · Client 半边
 *
 * 只做两件事：
 *   1. 在左侧栏注册一个入口（sidebar.panellist）
 *   2. 在整宽主区挂一个 iframe，指向 Host 提供的 /ticklist-calendar/
 *
 * 为什么用 iframe 而不是把日历写成 React 组件：
 * 日历 UI 是一份独立的静态页面（原型），iframe 让它原样运行，
 * 不需要把 866 行 HTML/CSS 重写成 React，改 UI 只改那份页面即可。
 * 这与本机已有的 ai a-workbench 采用同一种做法。
 */
window.__ModuleLoader__.load({
  id: 'ticklist-calendar',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 与 Host 半边一致的路径前缀。 */
    const ROUTE_PREFIX = '/ticklist-calendar'

    /** 左侧栏入口 id，同时也是 main 面板的 key。 */
    const PANEL_ID = 'ticklist-calendar'

    const NS = 'ticklistCalendar'

    /** 极简日历图标（自绘，避免依赖宿主图标集）。 */
    function Glyph(props) {
      const size = (props && props.size) || 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true'
        },
        h('rect', { x: 2, y: 3.2, width: 12, height: 10.6, rx: 2 }),
        h('path', { d: 'M2 6.4h12' }),
        h('path', { d: 'M5.4 2v2.4M10.6 2v2.4' }),
        h('path', { d: 'M5.2 9.2h1.6M9.2 9.2h1.6M5.2 11.4h1.6' })
      )
    }

    /** 左侧栏入口图标。 */
    function PanelIcon(props) {
      const size = (props && props.size) || 16
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } },
        h(Glyph, { size })
      )
    }

    /** 是否 macOS：只有 darwin 需要 -webkit-app-region 拖窗口。 */
    const IS_MAC = /Mac/i.test(
      (typeof navigator !== 'undefined' && navigator.userAgent) || ''
    )

    /** 顶栏高度，必须与 CSS 一致。 */
    const BAR_HEIGHT = 48

    /**
     * 主区面板：宿主侧顶栏 + iframe 内容。
     *
     * 关键点（踩过的坑）：顶栏必须画在**宿主文档**里。
     * -webkit-app-region: drag 只对顶层文档的元素生效；
     * 一旦把顶栏放进 iframe，长按顶部就无法拖动 DSH 窗口。
     * 因此这里自绘顶栏并设 drag，iframe 只承载日历内容。
     */
    /* ============================ AI 会话 ============================
     * 右侧独立 AI 会话，做法与本机其他工作台一致：
     *   1) ctx.get('sessions') 创建/保留一个独立会话
     *   2) 把会话 id 存 localStorage，重开页面继续用同一个
     *   3) 用 SessionProvider 包住，再把会话子槽位渲染出来
     * ============================================================== */

    /** 自有槽位名：用它换到 SessionProvider 和会话级标准 props。 */
    const CHAT_SLOT = 'ticklist-calendar.main.conversation'

    const SESSION_KEY = 'ticklist-calendar.sessionId'

    /** apply() 里捕获的 ctx，供会话创建使用。 */
    let pluginCtx = null
    let sessionReference = null
    let sessionPromise = null

    function readLocal(key) {
      try {
        return window.localStorage.getItem(key)
      } catch (error) {
        return null
      }
    }
    function writeLocal(key, value) {
      try {
        window.localStorage.setItem(key, value)
      } catch (error) {
        /* 隐身模式等场景忽略 */
      }
    }
    function clearLocal(key) {
      try {
        window.localStorage.removeItem(key)
      } catch (error) {
        /* ignore */
      }
    }

    function releaseSession() {
      const current = sessionReference
      sessionReference = null
      if (current) {
        try {
          current.release()
        } catch (error) {
          console.error('[ticklist-calendar] release session', error)
        }
      }
    }

    /** 创建会话时不指定工作区，交给 DSH 用默认值。 */
    function createOptions() {
      return {}
    }

    async function retainById(id) {
      const sessions = pluginCtx && pluginCtx.get && pluginCtx.get('sessions')
      if (!sessions) throw new Error('sessions service unavailable')
      const retained = sessions.retain(id, { source: 'ticklist-calendar' })
      try {
        await retained.ready
        return retained
      } catch (error) {
        try {
          retained.release()
        } catch (ignored) {
          /* ignore */
        }
        throw error
      }
    }

    async function createSession(forceNew) {
      const sessions = pluginCtx && pluginCtx.get && pluginCtx.get('sessions')
      if (!sessions) throw new Error('sessions service unavailable')

      if (!forceNew) {
        const saved = readLocal(SESSION_KEY)
        if (saved) {
          try {
            return await retainById(saved)
          } catch (error) {
            clearLocal(SESSION_KEY)
          }
        }
      } else {
        clearLocal(SESSION_KEY)
      }

      const id = await sessions.create(createOptions())
      if (typeof id !== 'string' || id === '') throw new Error('session.create returned no id')
      writeLocal(SESSION_KEY, id)
      return await retainById(id)
    }

    function ensureSession(forceNew) {
      if (sessionReference !== null && forceNew !== true) return Promise.resolve(sessionReference)
      if (sessionPromise !== null) return sessionPromise
      sessionPromise = (async () => {
        if (forceNew === true) releaseSession()
        const retained = await createSession(forceNew === true)
        sessionReference = retained
        return retained
      })().finally(() => {
        sessionPromise = null
      })
      return sessionPromise
    }

    /**
     * 固定落在「聊天」视图。
     *
     * conversation.content 默认可能渲染会话列表或空态 hero；
     * 工作台右侧要的是一条随时可输入的对话，所以强制 view: 'chat'。
     */
    function FixedChatView(props) {
      return props.renderSlot('conversation.session', { view: 'chat' })
    }

    /** 会话内的内容：把 conversation.content 工厂渲染出来。 */
    function ChatConversationPanel(props) {
      const { renderFactorySlot } = props
      return renderFactorySlot(
        'conversation.content',
        { variant: 'embedded', phase: 'active', hero: false },
        { slots: { views: FixedChatView } }
      )
    }

    /** 右侧对话区：负责准备会话，再用 SessionProvider 承载。 */
    function ChatSurface(props) {
      const { SessionProvider, renderSlot } = props
      const [reference, setReference] = React.useState(null)
      const [error, setError] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        ensureSession(false)
          .then((retained) => {
            if (alive) setReference(retained)
          })
          .catch((failure) => {
            if (alive) setError(String((failure && failure.message) || failure))
          })
        return () => {
          alive = false
        }
      }, [])

      if (error) {
        return h(
          'div',
          { style: { padding: 16, fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6B7684)' } },
          h('div', { style: { marginBottom: 8 } }, 'AI 会话启动失败'),
          h('div', { style: { opacity: 0.8, wordBreak: 'break-word' } }, error),
          h(
            'button',
            {
              type: 'button',
              onClick: () => {
                setError(null)
                ensureSession(true)
                  .then(setReference)
                  .catch((again) => setError(String((again && again.message) || again)))
              },
              style: {
                marginTop: 10,
                height: 28,
                padding: '0 12px',
                borderRadius: 6,
                border: '1px solid var(--dsw-alias-border-l1, #E3E8EF)',
                background: 'transparent',
                cursor: 'pointer',
                color: 'inherit',
                fontSize: 12
              }
            },
            '重试'
          )
        )
      }

      if (!reference || typeof SessionProvider !== 'function') {
        return h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              fontSize: 12,
              color: 'var(--dsw-alias-label-secondary, #6B7684)'
            }
          },
          '正在准备 AI 会话…'
        )
      }

      return h(
        SessionProvider,
        { session: reference },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
          renderSlot(CHAT_SLOT, {}, { fallback: null })
        )
      )
    }

    /* ============================ 主面板 ============================ */

    /**
     * 主区面板：左侧日历（iframe）+ 右侧 AI 会话。
     *
     * 顶栏仍在宿主文档里，保证 -webkit-app-region: drag 生效。
     */
    function MainPanel(props) {
      const [view, setView] = React.useState(readView)
      const [query, setQuery] = React.useState('')
      const [reloadKey, setReloadKey] = React.useState(0)
      const [chatWidth, setChatWidth] = React.useState(readChatWidth)
      const [dragging, setDragging] = React.useState(false)
      const frameRef = React.useRef(null)
      const bodyRef = React.useRef(null)
      const widthRef = React.useRef(chatWidth)
      const src = `${ROUTE_PREFIX}/?embed=1&v=${reloadKey}`
      widthRef.current = chatWidth

      const post = React.useCallback((message) => {
        const win = frameRef.current && frameRef.current.contentWindow
        if (!win) return
        try {
          win.postMessage(message, '*')
        } catch (error) {
          /* 未就绪时忽略 */
        }
      }, [])

      React.useEffect(() => { post({ type: 'ticklist:setView', view }) }, [view, post])
      React.useEffect(() => { post({ type: 'ticklist:setQuery', query }) }, [query, post])

      /* 拖动分隔条：日历一边、AI 一边，宽度持久化 */
      const onSplitDown = React.useCallback((event) => {
        if (event.button !== 0) return
        event.preventDefault()
        const startX = event.clientX
        const startWidth = widthRef.current
        const bodyWidth = bodyRef.current ? bodyRef.current.clientWidth : 0
        const maxWidth = bodyWidth > 0 ? Math.max(280, bodyWidth - 420) : 900
        setDragging(true)

        const move = (moveEvent) => {
          const next = Math.max(280, Math.min(maxWidth, startWidth + (startX - moveEvent.clientX)))
          setChatWidth(Math.round(next))
        }
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          window.removeEventListener('pointercancel', up)
          setDragging(false)
          writeChatWidth(widthRef.current)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', up)
      }, [])

      const dragStyle = IS_MAC ? { WebkitAppRegion: 'drag' } : undefined
      const noDragStyle = IS_MAC ? { WebkitAppRegion: 'no-drag' } : undefined

      const segBtn = (target, label) => {
        const on = view === target
        return h(
          'button',
          {
            key: target,
            type: 'button',
            onClick: () => {
              setView(target)
              try {
                window.localStorage.setItem('ticklist:view', target)
              } catch (error) {
                /* 隐私模式等场景写不进去，忽略 */
              }
            },
            title: { month: '月视图', week: '周视图', list: '列表视图', board: '看板视图' }[target],
            style: {
              height: 26,
              padding: '0 12px',
              border: 0,
              borderRadius: 6,
              fontSize: 12.5,
              cursor: 'pointer',
              background: on ? 'var(--dsw-alias-bg-layer-1, #FFFFFF)' : 'transparent',
              color: on ? 'var(--dsw-alias-brand-primary, #315F9D)' : 'var(--dsw-alias-label-secondary, #6B7684)',
              fontWeight: on ? 600 : 400,
              boxShadow: on ? '0 1px 2px rgba(16,24,40,.10)' : 'none',
              ...noDragStyle
            }
          },
          label
        )
      }

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            width: '100%',
            height: '100%',
            minHeight: 0
          }
        },
        /* ---------- 顶栏 ---------- */
        h(
          'div',
          {
            style: {
              flex: 'none',
              height: BAR_HEIGHT,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '0 16px',
              background: 'var(--dsw-specific-sidebar-fill, #F4F6F9)',
              color: 'var(--dsw-alias-label-primary, #1F2933)',
              borderBottom: '1px solid var(--dsw-alias-border-l1, #E3E8EF)',
              ...dragStyle
            }
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 } },
            h(
              'span',
              {
                style: {
                  width: 24,
                  height: 24,
                  borderRadius: 6,
                  background: 'var(--dsw-alias-brand-primary, #315F9D)',
                  display: 'grid',
                  placeItems: 'center',
                  flex: 'none',
                  color: '#fff'
                }
              },
              h(Glyph, { size: 14 })
            ),
            h(
              'span',
              {
                style: {
                  fontSize: 14,
                  fontWeight: 600,
                  color: 'var(--dsw-alias-label-primary, #1F2933)',
                  whiteSpace: 'nowrap'
                }
              },
              '日历清单'
            )
          ),
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                height: 30,
                width: 220,
                marginLeft: 16,
                padding: '0 9px',
                borderRadius: 8,
                background: 'var(--dsw-alias-bg-layer-1, #FFFFFF)',
                border: '1px solid var(--dsw-alias-border-l1, #E3E8EF)',
                ...noDragStyle
              }
            },
            h(
              'svg',
              {
                width: 13,
                height: 13,
                viewBox: '0 0 24 24',
                fill: 'none',
                stroke: 'var(--dsw-alias-label-secondary, #8A94A2)',
                strokeWidth: 2,
                strokeLinecap: 'round'
              },
              h('circle', { cx: 11, cy: 11, r: 7 }),
              h('path', { d: 'm20 20-3.6-3.6' })
            ),
            h('input', {
              type: 'search',
              value: query,
              onChange: (event) => setQuery(event.target.value),
              placeholder: '搜索任务',
              'aria-label': '搜索任务',
              style: {
                flex: '1 1 auto',
                minWidth: 0,
                background: 'none',
                border: 0,
                outline: 'none',
                color: 'var(--dsw-alias-label-primary, #1F2933)',
                fontSize: 12.5
              }
            })
          ),
          h(
            'div',
            {
              style: {
                display: 'flex',
                gap: 2,
                padding: 2,
                borderRadius: 8,
                background: 'var(--dsw-alias-bg-layer-2, #F4F6F9)',
                ...noDragStyle
              }
            },
            segBtn('month', '月'),
            segBtn('week', '周'),
            segBtn('list', '列表'),
            segBtn('board', '看板')
          ),
          h('span', { style: { flex: '1 1 auto' } })
        ),
        /* ---------- 内容：日历 + AI ---------- */
        h(
          'div',
          {
            ref: bodyRef,
            style: { flex: '1 1 auto', minHeight: 0, display: 'flex' }
          },
          h('iframe', {
            key: reloadKey,
            ref: frameRef,
            src,
            title: 'TickList 日历',
            onLoad: () => post({ type: 'ticklist:setView', view }),
            style: {
              flex: '1 1 auto',
              width: '100%',
              height: '100%',
              minWidth: 0,
              border: 0,
              display: 'block',
              background: '#F4F6F9'
            }
          }),
          /* 分隔条 */
          h('div', {
            key: 'split',
            role: 'separator',
            'aria-orientation': 'vertical',
            title: '拖动调整宽度',
            onPointerDown: onSplitDown,
            onDoubleClick: () => {
              setChatWidth(380)
              writeChatWidth(380)
            },
            style: {
              flex: 'none',
              width: 6,
              cursor: 'col-resize',
              background: dragging
                ? 'var(--dsw-alias-brand-primary, #315F9D)'
                : 'var(--dsw-alias-border-l1, #E3E8EF)',
              transition: 'background .15s'
            }
          }),
          /* AI 会话 */
          h(
            'div',
            {
              key: 'chat',
              style: {
                flex: 'none',
                width: chatWidth + 'px',
                minWidth: 0,
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                background: 'var(--dsw-alias-bg-layer-1, #FFFFFF)',
                borderLeft: '1px solid var(--dsw-alias-border-l1, #E3E8EF)'
              }
            },
            h(ChatSurface, {
              SessionProvider: props && props.SessionProvider,
              renderSlot: props && props.renderSlot
            })
          )
        )
      )
    }

    /* 对话宽度持久化 */
    function readView() {
      try {
        const saved = window.localStorage.getItem('ticklist:view')
        if (saved === 'month' || saved === 'week' || saved === 'list' || saved === 'board') return saved
      } catch (error) {
        /* 忽略存储不可用 */
      }
      return 'week'
    }

    function readChatWidth() {
      const raw = Number(readLocal('ticklist-calendar.chatWidth'))
      return Number.isFinite(raw) && raw >= 240 ? raw : 380
    }
    function writeChatWidth(value) {
      writeLocal('ticklist-calendar.chatWidth', String(value))
    }


    function apply(ctx) {
        pluginCtx = ctx

        // 1) 左侧栏入口
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 1,
              label: () => '日历清单'
            },
            PanelIcon
          )
        )

        // 2) 整宽主区：日历 + 右侧 AI 会话
        //
        // 声明一个自有子槽位（scope: session），这样 MainPanel 的 props 里
        // 才会拿到 SessionProvider 与 renderSlot，右侧才能渲染真实对话。
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS,
              children: {
                [CHAT_SLOT]: { kind: 'single', scope: 'session' }
              }
            },
            MainPanel
          )
        )

        // 3) 会话子槽位里的对话内容
        ctx.slots.inject(CHAT_SLOT, () =>
          ctx.slots.register(
            {
              name: CHAT_SLOT,
              locale: NS
            },
            ChatConversationPanel
          )
        )

        // 4) 插件卸载时释放会话引用
        ctx.effect(
          () => () => releaseSession(),
          'ticklist-calendar: session'
        )
    }

    // 客户端半边声明它依赖的宿主服务：没有 slots 就无法注册任何 UI
    return { inject: ['slots', 'locale', 'sessions'], apply }
  }
})
