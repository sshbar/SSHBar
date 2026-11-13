import { useEffect, useMemo, useRef, useState } from 'react'
import { CornerDownLeft, Play, Search } from 'lucide-react'
import type { Snippet } from '../../../shared/types'
import { api } from '../api'
import { useStore } from '../store'
import { terminalControls } from '../terminalBus'

/** Paste or run a snippet in a session's terminal. */
export function runSnippet(sessionId: string, snippet: Snippet, execute: boolean): void {
  const t = terminalControls(sessionId)
  if (!t) return
  // paste goes through the terminal (bracketed paste for multi-line), Enter then runs it
  t.paste(snippet.command.replace(/\r?\n$/, ''))
  if (execute) api.ssh.write(sessionId, '\r')
  t.focus()
}

export function SnippetPalette() {
  const sessionId = useStore((s) => s.palette)
  const snippets = useStore((s) => s.snippets)
  const close = (): void => useStore.getState().openPalette(null)
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase()
    return snippets
      .filter((s) => !n || s.name.toLowerCase().includes(n) || s.command.toLowerCase().includes(n))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [snippets, q])

  useEffect(() => {
    setQ('')
    setIdx(0)
  }, [sessionId])
  useEffect(() => setIdx(0), [q])
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${idx}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [idx])

  if (!sessionId) return null

  const pick = (s: Snippet | undefined, execute: boolean): void => {
    if (!s) return
    close()
    requestAnimationFrame(() => runSnippet(sessionId, s, execute))
  }

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog">
        <div className="palette-search">
          <Search size={15} />
          <input
            autoFocus
            placeholder="Search snippets…  (Enter = paste · Ctrl+Enter = run)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close()
              else if (e.key === 'ArrowDown') (e.preventDefault(), setIdx((i) => Math.min(filtered.length - 1, i + 1)))
              else if (e.key === 'ArrowUp') (e.preventDefault(), setIdx((i) => Math.max(0, i - 1)))
              else if (e.key === 'Enter') pick(filtered[idx], e.ctrlKey || e.metaKey)
            }}
          />
        </div>
        <div className="palette-list" ref={listRef}>
          {filtered.length === 0 && (
            <div className="muted center pad">
              {snippets.length === 0 ? 'No snippets yet — add some on the Snippets page.' : 'No matching snippets.'}
            </div>
          )}
          {filtered.map((s, i) => (
            <div key={s.id} data-i={i} className={`palette-item ${i === idx ? 'on' : ''}`} onMouseEnter={() => setIdx(i)} onClick={() => pick(s, false)}>
              <div className="grow">
                <div className="palette-name">{s.name}</div>
                <div className="palette-cmd mono">{s.command.split('\n')[0]}{s.command.includes('\n') ? ' …' : ''}</div>
              </div>
              <button className="btn sm" title="Paste (Enter)" onClick={(e) => (e.stopPropagation(), pick(s, false))}>
                <CornerDownLeft size={12} /> Paste
              </button>
              <button className="btn sm primary" title="Paste and run (Ctrl+Enter)" onClick={(e) => (e.stopPropagation(), pick(s, true))}>
                <Play size={12} /> Run
              </button>
            </div>
          ))}
        </div>
        <div className="palette-foot muted small">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> select · <kbd>Enter</kbd> paste · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> run
          </span>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault()
              close()
              useStore.getState().setActive('snippets')
            }}
          >
            Manage snippets
          </a>
        </div>
      </div>
    </div>
  )
}
