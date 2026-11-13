import { FolderOpen, LoaderCircle, Pencil, RotateCw, SquareTerminal, TriangleExclamationPoint, Unplug } from 'lucide-react'
import { useStore } from '../store'
import { TerminalPane } from './TerminalPane'
import { FileManager } from './FileManager'
import { api } from '../api'

export function SessionView({ id, visible }: { id: string; visible: boolean }) {
  const s = useStore((st) => st.sessions[id])
  const setView = useStore((st) => st.setView)
  const reconnect = useStore((st) => st.reconnect)
  const host = useStore((st) => st.hosts.find((h) => h.id === s?.hostId))
  if (!s) return null

  const connected = s.status === 'connected'
  const busy = s.status === 'connecting' || s.status === 'authenticating'
  const ended = s.status === 'closed' || s.status === 'error'

  return (
    <div className="session" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="session-toolbar">
        <div className="segmented">
          <button className={s.view === 'terminal' ? 'on' : ''} onClick={() => setView(id, 'terminal')}>
            <SquareTerminal size={14} /> Terminal
          </button>
          <button className={s.view === 'files' ? 'on' : ''} onClick={() => setView(id, 'files')} disabled={!connected && !s.filesOpened}>
            <FolderOpen size={14} /> Files
          </button>
        </div>
        <div className="session-title">
          <b>{s.label}</b> <span className="muted">{s.subtitle}</span>
        </div>
        <div className="grow" />
        {ended ? (
          <button className="btn sm primary" onClick={() => void reconnect(id)}>
            <RotateCw size={13} /> Reconnect
          </button>
        ) : (
          <button className="btn sm" onClick={() => void api.ssh.close(id)} disabled={!connected && !busy}>
            <Unplug size={13} /> Disconnect
          </button>
        )}
      </div>

      <div className="session-body">
        <div className="pane-stack" style={{ display: s.view === 'terminal' ? 'flex' : 'none' }}>
          <TerminalPane sessionId={id} visible={visible && s.view === 'terminal'} />
        </div>
        {s.filesOpened && (
          <div className="pane-stack" style={{ display: s.view === 'files' ? 'flex' : 'none' }}>
            <FileManager sessionId={id} connected={connected} />
          </div>
        )}

        {busy && (
          <div className="overlay">
            <div className="overlay-card">
              <LoaderCircle className="spin" size={26} />
              <div>{s.message ?? 'Connecting…'}</div>
              <button className="btn sm" onClick={() => void api.ssh.close(id)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {ended && (
          <div className="overlay soft">
            <div className={`overlay-card ${s.status === 'error' ? 'err' : ''}`}>
              {s.status === 'error' ? <TriangleExclamationPoint size={26} /> : <Unplug size={26} />}
              <div className="overlay-title">{s.status === 'error' ? 'Connection failed' : 'Disconnected'}</div>
              {s.message && <div className="muted">{s.message}</div>}
              <div className="row gap">
                <button className="btn primary" onClick={() => void reconnect(id)}>
                  <RotateCw size={14} /> Reconnect
                </button>
                {host && (
                  <button className="btn" onClick={() => useStore.getState().openEditor(host)}>
                    <Pencil size={14} /> Edit host
                  </button>
                )}
                <button className="btn" onClick={() => useStore.getState().closeTab(id)}>
                  Close tab
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
