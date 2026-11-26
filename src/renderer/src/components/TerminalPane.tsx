import { useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { ArrowDown, ArrowUp, CaseSensitive, X } from 'lucide-react'
import { api } from '../api'
import { useStore } from '../store'
import { attachTerminal, registerTerminalControls } from '../terminalBus'
import { enableSoftKeyboardInput, enableTouchScroll, restartSoftKeyboard } from '../touchInput'
import type { Snippet } from '../../../shared/types'
import { InputLine, suggestSnippets, type Suggestion } from '../../../shared/snippetSuggest'
import { SnippetSuggestions, type SuggestState } from './SnippetSuggestions'

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
  // snippet suggestions while typing (see shared/snippetSuggest.ts)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [suggest, setSuggest] = useState<SuggestState | null>(null)
  const suggestRef = useRef<SuggestState | null>(null)
  const acceptRef = useRef<(s: Suggestion<Snippet>) => void>(() => undefined)

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

    const line = new InputLine()
    // Esc (or filling in a suggestion) hides the list until the line changes
    let dismissedFor: string | null = null
    const showSuggest = (next: SuggestState | null): void => {
      const cur = suggestRef.current
      if (!cur && !next) return
      if (cur && next && sameSuggest(cur, next)) return
      suggestRef.current = next
      setSuggest(next)
    }
    /** `typing`: called right after a keystroke, before the shell's echo has come back */
    const refreshSuggest = (typing = false): void => {
      const st = useStore.getState()
      const typed = line.text
      const buf = term.buffer.active
      if (
        !st.settings?.snippetSuggestions ||
        typed === null ||
        typed === dismissedFor ||
        buf.type !== 'normal' || // vim, less, htop...
        buf.viewportY !== buf.baseY || // scrolled back
        document.activeElement !== term.textarea ||
        st.sessions[sessionId]?.status !== 'connected'
      ) {
        return showSuggest(null)
      }
      dismissedFor = null
      const items = suggestSnippets(st.snippets, typed)
      // Only when the shell echoed exactly this before the cursor: never at a password prompt (no echo),
      // and never when the line changed in ways the tracker can't see.
      if (!items.length) return showSuggest(null)
      const cur = suggestRef.current
      const same = !!cur && cur.items.length === items.length && cur.items.every((it, i) => it.snippet.id === items[i].snippet.id)
      const sel = same && cur ? cur.sel : -1
      if (!textBeforeCursor(term).endsWith(typed)) {
        // the echo is on its way: keep the list where it is (no flicker) until the screen catches up
        if (typing) return cur ? showSuggest({ ...cur, items, sel }) : undefined
        return showSuggest(null)
      }
      const pos = suggestPosition(term, el, wrapRef.current, [...typed.trimStart()].length, items.length)
      showSuggest(pos ? { items, sel, ...pos } : null)
    }

    const isMac = api.platform === 'darwin'
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      // Suggestion list open: arrows pick, Enter/Tab fill in the picked one, Esc closes. Enter and Tab
      // with nothing picked go to the shell as usual, so typing a command and pressing Enter never changes.
      const sg = suggestRef.current
      if (sg && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const n = sg.items.length
          const sel = e.key === 'ArrowDown' ? (sg.sel + 1) % n : sg.sel <= 0 ? n - 1 : sg.sel - 1
          showSuggest({ ...sg, sel })
          return false
        }
        if ((e.key === 'Enter' || e.key === 'Tab') && sg.sel >= 0) {
          e.preventDefault()
          acceptRef.current(sg.items[sg.sel])
          return false
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          dismissedFor = line.text
          showSuggest(null)
          return false
        }
      }
      const k = e.key.toLowerCase()
      // Copy / paste: Ctrl+Shift+C/V on Linux & Windows, Cmd+C/V on macOS
      const copy = isMac ? e.metaKey && k === 'c' : e.ctrlKey && e.shiftKey && k === 'c'
      const paste = isMac ? e.metaKey && k === 'v' : e.ctrlKey && e.shiftKey && k === 'v'
      // Returning false only stops xterm from handling the key; the browser's default action still
      // runs. For Ctrl+Shift+V that is Chromium's "paste as plain text" into xterm's hidden textarea,
      // which xterm then pastes again (twice on Linux), so cancel the default for every shortcut we own.
      if (copy) {
        e.preventDefault()
        const sel = term.getSelection()
        if (sel) void api.clipboard.write(sel)
        return false
      }
      if (paste) {
        e.preventDefault()
        void api.clipboard.read().then((t) => t && term.paste(t))
        return false
      }
      // Find: Ctrl+Shift+F (Cmd+F on macOS)
      if (isMac ? e.metaKey && !e.shiftKey && k === 'f' : e.ctrlKey && e.shiftKey && k === 'f') {
        e.preventDefault()
        setSearch((s) => ({ ...s, open: true }))
        requestAnimationFrame(() => searchInput.current?.select())
        return false
      }
      // Snippets: Ctrl+Shift+S (Cmd+Shift+S on macOS)
      if ((isMac ? e.metaKey : e.ctrlKey) && e.shiftKey && k === 's') {
        e.preventDefault()
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
    const write = (d: string): void => {
      if (useStore.getState().sessions[sessionId]?.status !== 'connected') return
      line.feed(d)
      api.ssh.write(sessionId, d)
      refreshSuggest(true)
    }
    const send = (d: string): void => {
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
      write(d)
    }
    sendRef.current = send
    const dataSub = term.onData(send)
    const binSub = term.onBinary(send)
    const resizeSub = term.onResize(({ cols, rows }) => {
      api.ssh.resize(sessionId, cols, rows)
      refreshSuggest()
    })
    // the echo of what was typed arrives with the output: only then can the screen confirm it
    const parsedSub = term.onWriteParsed(() => refreshSuggest())
    const scrollSub = term.onScroll(() => refreshSuggest())
    const onBlur = (): void => showSuggest(null)
    term.textarea?.addEventListener('blur', onBlur)
    const onFocus = (): void => refreshSuggest()
    term.textarea?.addEventListener('focus', onFocus)

    acceptRef.current = (s) => {
      write(s.insert) // keystrokes only, never Enter: the user runs it
      dismissedFor = line.text // the line is now the command; show more once it changes
      showSuggest(null)
      if (isMobile) restartSoftKeyboard(el)
      else term.focus()
    }
    const detach = attachTerminal(sessionId, (data) => term.write(data))

    const ro = new ResizeObserver(() => {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) {
        // when the soft keyboard opens the terminal shrinks: keep the prompt/cursor in view
        const buf = term.buffer.active
        const atBottom = buf.viewportY >= buf.baseY
        try {
          fit.fit()
        } catch {
          /* not laid out yet */
        }
        if (atBottom) term.scrollToBottom()
      }
    })
    ro.observe(el)

    // Touch scrolling (xterm.js only scrolls with a mouse wheel): swipe through the scrollback with
    // momentum; in full-screen programs (less, vim, htop) a swipe sends arrow keys instead.
    const removeTouch = isMobile ? enableTouchScroll(el, term, (d) => sendRef.current(d)) : () => undefined
    // Soft keyboards compose whole words; send each letter as it is typed instead (see enableSoftKeyboardInput)
    const removeIme = isMobile ? enableSoftKeyboardInput(el, (d) => sendRef.current(d)) : () => undefined

    return () => {
      removeIme()
      removeTouch()
      ro.disconnect()
      el.removeEventListener('contextmenu', onContext)
      dataSub.dispose()
      binSub.dispose()
      resizeSub.dispose()
      parsedSub.dispose()
      scrollSub.dispose()
      term.textarea?.removeEventListener('blur', onBlur)
      term.textarea?.removeEventListener('focus', onFocus)
      showSuggest(null)
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
    <div className={`terminal-wrap ${isMobile ? 'with-keys' : ''}`} ref={wrapRef}>
      <div className="terminal-host" ref={ref} />
      {suggest && (
        <SnippetSuggestions
          state={suggest}
          touch={isMobile}
          onPick={(s) => acceptRef.current(s)}
        />
      )}
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

function sameSuggest(a: SuggestState, b: SuggestState): boolean {
  return (
    a.sel === b.sel &&
    a.left === b.left &&
    a.top === b.top &&
    a.bottom === b.bottom &&
    a.items.length === b.items.length &&
    a.items.every((it, i) => it.snippet.id === b.items[i].snippet.id && it.insert === b.items[i].insert)
  )
}

/** The text on the cursor's line up to the cursor, including the rows it wrapped from. */
function textBeforeCursor(term: Terminal): string {
  const buf = term.buffer.active
  let y = buf.baseY + buf.cursorY
  let row = buf.getLine(y)
  if (!row) return ''
  let text = row.translateToString(false, 0, buf.cursorX)
  while (row.isWrapped && y > 0) {
    row = buf.getLine(--y)
    if (!row) break
    text = row.translateToString(false) + text
  }
  return text
}

/** Where to put the list: under the typed text, or above it when there is more room there. */
function suggestPosition(
  term: Terminal,
  host: HTMLElement,
  wrap: HTMLElement | null,
  typedCells: number,
  count: number
): Pick<SuggestState, 'left' | 'top' | 'bottom'> | null {
  const screen = host.querySelector('.xterm-screen')
  if (!wrap || !screen) return null
  const s = screen.getBoundingClientRect()
  const w = wrap.getBoundingClientRect()
  if (!s.width || !s.height) return null
  const cellW = s.width / term.cols
  const cellH = s.height / term.rows
  const buf = term.buffer.active
  const rowTop = Math.round(s.top - w.top + buf.cursorY * cellH)
  const x = s.left - w.left + Math.max(0, buf.cursorX - typedCells) * cellW
  const left = Math.round(Math.max(4, Math.min(x, w.width - Math.min(360, w.width - 8) - 4)))
  const below = w.height - (rowTop + cellH)
  const needed = count * 40 + 40
  return below >= needed || below >= rowTop
    ? { left, top: Math.round(rowTop + cellH + 2) }
    : { left, bottom: Math.round(w.height - rowTop + 2) }
}
