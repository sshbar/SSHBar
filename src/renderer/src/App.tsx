import { useEffect } from 'react'
import { Braces, LoaderCircle, Server, Settings as SettingsIcon, SquareTerminal, X } from 'lucide-react'
import { useStore } from './store'
import { HostsView } from './components/HostsView'
import { HostEditor } from './components/HostEditor'
import { SessionView } from './components/SessionView'
import { SettingsView } from './components/SettingsView'
import { StatsBar } from './components/StatsBar'
import { PromptDialog } from './components/PromptDialog'
import { Toasts } from './components/Toasts'
import { StatusDot } from './components/StatusDot'
import { SnippetsView } from './components/SnippetsView'
import { SnippetPalette } from './components/SnippetPalette'

export function App() {
  const ready = useStore((s) => s.ready)
  const active = useStore((s) => s.active)
  const tabs = useStore((s) => s.tabs)
  const sessions = useStore((s) => s.sessions)
  const setActive = useStore((s) => s.setActive)
  const closeTab = useStore((s) => s.closeTab)
  const editor = useStore((s) => s.editor)

  useEffect(() => {
    void useStore.getState().init()
  }, [])

  // Ctrl/Cmd+W closes the active session tab, Ctrl+Tab cycles tabs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      const { active, tabs, closeTab, setActive } = useStore.getState()
      if (mod && e.shiftKey && e.key.toLowerCase() === 'w' && tabs.includes(active)) {
        e.preventDefault()
        closeTab(active)
      } else if (e.ctrlKey && e.key === 'Tab' && tabs.length) {
        e.preventDefault()
        const order = ['hosts', ...tabs]
        const i = order.indexOf(active)
        setActive(order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length])
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  if (!ready) {
    return (
      <div className="boot">
        <LoaderCircle className="spin" size={28} />
      </div>
    )
  }

  const activeSession = sessions[active]

  return (
    <div className="app">
      <nav className="rail">
        <div className="rail-logo" title="SSHbar">
          <SquareTerminal size={22} />
        </div>
        <button className={`rail-btn ${active === 'hosts' ? 'on' : ''}`} onClick={() => setActive('hosts')} title="Hosts">
          <Server size={19} />
          <span>Hosts</span>
        </button>
        <button className={`rail-btn ${active === 'snippets' ? 'on' : ''}`} onClick={() => setActive('snippets')} title="Snippets">
          <Braces size={19} />
          <span>Snippets</span>
        </button>
        <div className="rail-spacer" />
        <button className={`rail-btn ${active === 'settings' ? 'on' : ''}`} onClick={() => setActive('settings')} title="Settings">
          <SettingsIcon size={19} />
          <span>Settings</span>
        </button>
      </nav>

      <div className="main">
        <div className="tabbar">
          <button className={`tab tab-home ${['hosts', 'snippets', 'settings'].includes(active) ? 'on' : ''}`} onClick={() => setActive('hosts')}>
            {active === 'settings' ? <SettingsIcon size={14} /> : active === 'snippets' ? <Braces size={14} /> : <Server size={14} />}
            <span>{active === 'settings' ? 'Settings' : active === 'snippets' ? 'Snippets' : 'Hosts'}</span>
          </button>
          {tabs.map((id) => {
            const s = sessions[id]
            if (!s) return null
            return (
              <div
                key={id}
                className={`tab ${active === id ? 'on' : ''}`}
                onClick={() => setActive(id)}
                onAuxClick={(e) => e.button === 1 && closeTab(id)}
                title={`${s.subtitle}${s.message ? ' — ' + s.message : ''}`}
              >
                <StatusDot status={s.status} />
                <span className="tab-label">{s.label}</span>
                <button
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(id)
                  }}
                  title="Close (Ctrl+Shift+W)"
                >
                  <X size={13} />
                </button>
              </div>
            )
          })}
        </div>

        <div className="content">
          {active === 'hosts' && <HostsView />}
          {active === 'snippets' && <SnippetsView />}
          {active === 'settings' && <SettingsView />}
          {tabs.map((id) => (
            <SessionView key={id} id={id} visible={active === id} />
          ))}
        </div>

        {activeSession && <StatsBar session={activeSession} />}
      </div>

      {editor && <HostEditor initial={editor} />}
      <PromptDialog />
      <SnippetPalette />
      <Toasts />
    </div>
  )
}
