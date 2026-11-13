import { useEffect, useMemo, useState } from 'react'
import { ArrowRightLeft, Copy, Play, Plus, Square, Trash } from 'lucide-react'
import type { ForwardState, PortForward } from '../../../shared/types'
import { describeForward } from '../../../shared/forwards'
import { api } from '../api'
import { useStore } from '../store'
import { errorText } from '../format'
import { ForwardForm, ForwardPill } from './Forwards'

/** Session view: saved and ad-hoc port forwards with live status. */
export function PortsPanel({ sessionId, connected }: { sessionId: string; connected: boolean }) {
  const s = useStore((st) => st.sessions[sessionId])
  const host = useStore((st) => st.hosts.find((h) => h.id === s?.hostId))
  const toast = useStore((st) => st.toast)
  const [adding, setAdding] = useState(false)
  const [adhoc, setAdhoc] = useState<PortForward[]>([])

  useEffect(() => {
    if (connected) void api.ssh.listForwards(sessionId).then((forwards) => useStore.getState().setForwards(sessionId, forwards))
  }, [sessionId, connected])

  const running = useMemo(() => new Map((s?.forwards ?? []).map((f) => [f.id, f])), [s?.forwards])
  const rows: { f: PortForward; saved: boolean; state?: ForwardState }[] = useMemo(() => {
    const saved = (host?.forwards ?? []).map((f) => ({ f, saved: true, state: running.get(f.id) }))
    const ids = new Set(saved.map((r) => r.f.id))
    const extra = [...adhoc, ...(s?.forwards ?? []).map((st) => st.forward)]
      .filter((f, i, arr) => !ids.has(f.id) && arr.findIndex((x) => x.id === f.id) === i)
      .map((f) => ({ f, saved: false, state: running.get(f.id) }))
    return [...saved, ...extra]
  }, [host?.forwards, adhoc, running, s?.forwards])

  if (!s) return null

  const start = (f: PortForward): void => {
    api.ssh
      .startForward(sessionId, f)
      .then((st) => st.status === 'error' && toast('error', `${f.label || 'Forward'}: ${st.error}`))
      .catch((e) => toast('error', errorText(e)))
  }
  const stop = (id: string): void => void api.ssh.stopForward(sessionId, id)

  const saveForwards = async (forwards: PortForward[]): Promise<void> => {
    if (!host) return
    try {
      await api.hosts.save({ ...host, forwards })
    } catch (e) {
      toast('error', errorText(e))
    }
  }

  const add = (f: PortForward, save: boolean): void => {
    setAdding(false)
    if (save && host) void saveForwards([...host.forwards, f])
    else setAdhoc((a) => [...a, f])
    if (connected) start(f)
  }

  const remove = (row: { f: PortForward; saved: boolean }): void => {
    stop(row.f.id)
    if (row.saved && host) void saveForwards(host.forwards.filter((x) => x.id !== row.f.id))
    else setAdhoc((a) => a.filter((x) => x.id !== row.f.id))
  }

  return (
    <div className="ports page">
      <div className="page-head">
        <h1>Port forwarding</h1>
        <span className="muted">{host?.label}</span>
        <div className="grow" />
        {!adding && (
          <button className="btn primary" onClick={() => setAdding(true)}>
            <Plus size={15} /> New forward
          </button>
        )}
      </div>

      {adding && <ForwardForm onAdd={add} onCancel={() => setAdding(false)} saveOption />}

      {rows.length === 0 && !adding ? (
        <div className="empty">
          <ArrowRightLeft size={36} />
          <p>No port forwards yet. Tunnel a database, reach a dashboard on the server, or browse its network through a SOCKS proxy.</p>
        </div>
      ) : (
        <div className="fwd-list">
          {rows.map(({ f, saved, state }) => {
            const active = state?.status === 'active'
            const addr = `${f.bindAddress === '0.0.0.0' ? 'localhost' : f.bindAddress}:${state?.boundPort ?? f.bindPort}`
            return (
              <div key={f.id} className={`fwd-row ${state?.status ?? 'stopped'}`}>
                <ForwardPill type={f.type} />
                <div className="fwd-info">
                  <div>
                    <b>{f.label || (f.type === 'dynamic' ? 'SOCKS proxy' : `${f.destHost}:${f.destPort}`)}</b>
                    {!saved && <span className="badge">not saved</span>}
                    {saved && f.autoStart && <span className="badge">auto</span>}
                  </div>
                  <div className="muted mono small">{describeForward(f, state?.boundPort)}</div>
                  {state?.status === 'error' && <div className="err-text small">{state.error}</div>}
                </div>
                <div className="fwd-status small">
                  {active ? (
                    <span className="ok-text">
                      ● Active{state.connections ? ` · ${state.connections} conn` : ''}
                    </span>
                  ) : state?.status === 'starting' ? (
                    <span className="muted">Starting…</span>
                  ) : state?.status === 'error' ? (
                    <span className="err-text">Failed</span>
                  ) : (
                    <span className="muted">Stopped</span>
                  )}
                </div>
                <div className="row">
                  {active && f.type !== 'remote' && (
                    <button className="icon-btn" title={`Copy ${addr}`} onClick={() => void api.clipboard.write(addr).then(() => toast('info', `Copied ${addr}`))}>
                      <Copy size={14} />
                    </button>
                  )}
                  {active ? (
                    <button className="btn sm" onClick={() => stop(f.id)}>
                      <Square size={12} /> Stop
                    </button>
                  ) : (
                    <button className="btn sm" disabled={!connected} onClick={() => start(f)}>
                      <Play size={12} /> Start
                    </button>
                  )}
                  <button className="icon-btn danger" title={saved ? 'Remove from host' : 'Remove'} onClick={() => remove({ f, saved })}>
                    <Trash size={14} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
