import { useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { ArrowDown, ArrowUp, CaseSensitive, X } from 'lucide-react'
import { api } from '../api'
import { useStore } from '../store'
import { attachTerminal, registerTerminalControls } from '../terminalBus'

const THEME: ITheme = {
  background: '#0d1016',
  foreground: '#d6dde8',
  cursor: '#3ddc97',
  cursorAccent: '#0d1016',
  selectionBackground: '#3ddc9744',
  black: '#1b1f27',
  red: '#f7768e',
  green: '#3ddc97',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#c0caf5',
  brightBlack: '#565f89',
  brightRed: '#ff8ba0',
  brightGreen: '#73f0b8',
  brightYellow: '#ffc777',
  brightBlue: '#9ab8ff',
  brightMagenta: '#d0b3ff',
  brightCyan: '#a4e2ff',
  brightWhite: '#e7ecf7'
}

export function TerminalPane({ sessionId, visible }: { sessionId: string; visible: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const settings = useStore((s) => s.settings)
  const status = useStore((s) => s.sessions[sessionId]?.status)
  const searchRef = useRef<SearchAddon | null>(null)
  const sendRef = useRef<(d: string) => void>(() => undefined)
  const [search, setSearch] = useState<{ open: boolean; q: string; caseSensitive: boolean; found: boolean | null }>({
    open: false,
    q: '',
    caseSensitive: false,
    found: null
  })
  const searchInput = useRef<HTMLInputElement>(null)
  // Android: sticky Ctrl/Alt from the extra-keys row apply to the next key typed on the soft keyboard
  const isMobile = api.platform === 'android'
  const mods = useRef({ ctrl: false, alt: false })
  const [modState, setModState] = useState({ ctrl: false, alt: false })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const st = useStore.getState().settings
    const term = new Terminal({
      fontFamily: st?.terminalFontFamily,
      fontSize: st?.terminalFontSize ?? 14,
      scrollback: st?.terminalScrollback ?? 10000,
      cursorStyle: st?.terminalCursorStyle ?? 'block',
      cursorBlink: true,
      lineHeight: 1.15,
      allowProposedApi: false,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      theme: THEME
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(
      new WebLinksAddon((ev, uri) => {
        if (ev.ctrlKey || ev.metaKey) void api.openExternal(uri)
      })
    )
    const searchAddon = new SearchAddon()
    term.loadAddon(searchAddon)
    searchRef.current = searchAddon
    term.open(el)
    termRef.current = term
    fitRef.current = fit
    const unregister = registerTerminalControls(sessionId, {
      paste: (text) => term.paste(text),
      focus: () => term.focus()
    })

    const isMac = api.platform === 'darwin'
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const k = e.key.toLowerCase()
      // Copy / paste: Ctrl+Shift+C/V on Linux & Windows, Cmd+C/V on macOS
      const copy = isMac ? e.metaKey && k === 'c' : e.ctrlKey && e.shiftKey && k === 'c'
      const paste = isMac ? e.metaKey && k === 'v' : e.ctrlKey && e.shiftKey && k === 'v'
      if (copy) {
        const sel = term.getSelection()
        if (sel) void api.clipboard.write(sel)
        return false
      }
      if (paste) {
        void api.clipboard.read().then((t) => t && term.paste(t))
        return false
      }
      // Find: Ctrl+Shift+F (Cmd+F on macOS)
      if (isMac ? e.metaKey && !e.shiftKey && k === 'f' : e.ctrlKey && e.shiftKey && k === 'f') {
        setSearch((s) => ({ ...s, open: true }))
        requestAnimationFrame(() => searchInput.current?.select())
        return false
      }
      // Snippets: Ctrl+Shift+S (Cmd+Shift+S on macOS)
      if ((isMac ? e.metaKey : e.ctrlKey) && e.shiftKey && k === 's') {
        useStore.getState().openPalette(sessionId)
        return false
      }
      // let the app handle tab shortcuts
      if (e.ctrlKey && (e.key === 'Tab' || (e.shiftKey && k === 'w'))) return false
      return true
    })

    // Right-click: copy if there is a selection, otherwise paste (like most terminals on Windows/Linux)
    const onContext = (e: MouseEvent): void => {
      e.preventDefault()
      const sel = term.getSelection()
      if (sel) {
        void api.clipboard.write(sel)
        term.clearSelection()
      } else {
        void api.clipboard.read().then((t) => t && term.paste(t))
      }
    }
    el.addEventListener('contextmenu', onContext)

    // Only forward keystrokes once the shell is open. Anything typed while connecting (e.g. a
    // password meant for a dialog) must never end up on the remote command line.
    const send = (d: string): void => {
      if (useStore.getState().sessions[sessionId]?.status !== 'connected') return
      const m = mods.current
      if ((m.ctrl || m.alt) && d.length === 1) {
        let out = d
        if (m.ctrl) {
          const c = d.toUpperCase().charCodeAt(0)
          if (c >= 64 && c <= 95) out = String.fromCharCode(c - 64) // Ctrl+A..Z, [ \\ ] ^ _
          else if (d === ' ') out = '\x00'
        }
        if (m.alt) out = '\x1b' + out
        mods.current = { ctrl: false, alt: false }
        setModState({ ctrl: false, alt: false })
        d = out
      }
      api.ssh.write(sessionId, d)
    }
    sendRef.current = send
    const dataSub = term.onData(send)
    const binSub = term.onBinary(send)
    const resizeSub = term.onResize(({ cols, rows }) => api.ssh.resize(sessionId, cols, rows))
    const detach = attachTerminal(sessionId, (data) => term.write(data))

    const ro = new ResizeObserver(() => {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) {
        try {
          fit.fit()
        } catch {
          /* not laid out yet */
        }
      }
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      el.removeEventListener('contextmenu', onContext)
      dataSub.dispose()
      binSub.dispose()
      resizeSub.dispose()
      detach()
      unregister()
      term.dispose()
      termRef.current = null
    }
  }, [sessionId])

  // live-apply terminal settings
  useEffect(() => {
    const term = termRef.current
    if (!term || !settings) return
    term.options.fontFamily = settings.terminalFontFamily
    term.options.fontSize = settings.terminalFontSize
    term.options.cursorStyle = settings.terminalCursorStyle
    term.options.scrollback = settings.terminalScrollback
    try {
      fitRef.current?.fit()
    } catch {
      /* ignore */
    }
  }, [settings])

  useEffect(() => {
    if (!visible) return
    const frame = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        /* ignore */
      }
      // Never steal focus from a dialog (username/password/host key prompts, host editor).
      const { prompts, editor } = useStore.getState()
      if (status === 'connected' && prompts.length === 0 && !editor) termRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [status, visible])

  const find = (dir: 'next' | 'prev', q = search.q, caseSensitive = search.caseSensitive): void => {
    const addon = searchRef.current
    if (!addon || !q) return setSearch((s) => ({ ...s, found: null }))
    const found = dir === 'next' ? addon.findNext(q, { caseSensitive }) : addon.findPrevious(q, { caseSensitive })
    setSearch((s) => ({ ...s, found }))
  }

  const closeSearch = (): void => {
    searchRef.current?.clearDecorations()
    termRef.current?.clearSelection()
    setSearch((s) => ({ ...s, open: false, found: null }))
    termRef.current?.focus()
  }

  return (
    <div className={`terminal-wrap ${isMobile ? 'with-keys' : ''}`}>
      <div className="terminal-host" ref={ref} />
      {isMobile && (
        <TermKeys
          mods={modState}
          onToggle={(k) => {
            mods.current = { ...mods.current, [k]: !mods.current[k] }
            setModState({ ...mods.current })
          }}
          onKey={(seq) => sendRef.current(seq)}
          onPaste={() => void api.clipboard.read().then((t) => t && termRef.current?.paste(t))}
          onFind={() => setSearch((s) => ({ ...s, open: !s.open }))}
        />
      )}
      {search.open && (
        <div className="term-search" onKeyDown={(e) => e.stopPropagation()}>
          <input
            ref={searchInput}
            autoFocus
            placeholder="Find in terminal"
            value={search.q}
            className={search.found === false ? 'nomatch' : ''}
            onChange={(e) => {
              const q = e.target.value
              setSearch((s) => ({ ...s, q }))
              find('next', q)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') find(e.shiftKey ? 'prev' : 'next')
              if (e.key === 'Escape') closeSearch()
            }}
          />
          <button
            className={`icon-btn ${search.caseSensitive ? 'on' : ''}`}
            title="Match case"
            onClick={() => {
              const cs = !search.caseSensitive
              setSearch((s) => ({ ...s, caseSensitive: cs }))
              find('next', search.q, cs)
            }}
          >
            <CaseSensitive size={15} />
          </button>
          <button className="icon-btn" title="Previous (Shift+Enter)" onClick={() => find('prev')}>
            <ArrowUp size={14} />
          </button>
          <button className="icon-btn" title="Next (Enter)" onClick={() => find('next')}>
            <ArrowDown size={14} />
          </button>
          <button className="icon-btn" title="Close (Esc)" onClick={closeSearch}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  )
}

const KEYS: { label: string; seq: string }[] = [
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t' },
  { label: '←', seq: '\x1b[D' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '→', seq: '\x1b[C' },
  { label: '|', seq: '|' },
  { label: '/', seq: '/' },
  { label: '-', seq: '-' },
  { label: '~', seq: '~' },
  { label: 'Home', seq: '\x1b[H' },
  { label: 'End', seq: '\x1b[F' },
  { label: 'PgUp', seq: '\x1b[5~' },
  { label: 'PgDn', seq: '\x1b[6~' }
]

/** Extra keys row for touch keyboards. Buttons don't take focus, so the soft keyboard stays open. */
function TermKeys({
  mods,
  onToggle,
  onKey,
  onPaste,
  onFind
}: {
  mods: { ctrl: boolean; alt: boolean }
  onToggle: (k: 'ctrl' | 'alt') => void
  onKey: (seq: string) => void
  onPaste: () => void
  onFind: () => void
}) {
  const keep = (e: React.PointerEvent | React.MouseEvent): void => e.preventDefault()
  return (
    <div className="term-keys" onPointerDown={keep} onMouseDown={keep}>
      <button className={mods.ctrl ? 'on' : ''} onClick={() => onToggle('ctrl')}>
        Ctrl
      </button>
      <button className={mods.alt ? 'on' : ''} onClick={() => onToggle('alt')}>
        Alt
      </button>
      {KEYS.map((k) => (
        <button key={k.label} onClick={() => onKey(k.seq)}>
          {k.label}
        </button>
      ))}
      <button onClick={onPaste}>Paste</button>
      <button onClick={onFind}>Find</button>
    </div>
  )
}
