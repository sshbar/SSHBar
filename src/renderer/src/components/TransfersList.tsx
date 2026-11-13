import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronRight, CircleCheck, CircleX, X } from 'lucide-react'
import { api } from '../api'
import { useStore } from '../store'
import { bytes, rate } from '../format'

export function TransfersList({ sessionId }: { sessionId: string }) {
  const all = useStore((s) => s.transfers)
  const [open, setOpen] = useState(true)
  const list = useMemo(
    () => Object.values(all).filter((t) => t.sessionId === sessionId).sort((a, b) => b.startedAt - a.startedAt),
    [all, sessionId]
  )
  if (list.length === 0) return null
  const active = list.filter((t) => t.state === 'running' || t.state === 'queued').length

  const clear = (): void => {
    void api.sftp.clearTransfers(sessionId)
    useStore.setState((s) => ({
      transfers: Object.fromEntries(
        Object.entries(s.transfers).filter(([, t]) => t.sessionId !== sessionId || t.state === 'running' || t.state === 'queued')
      )
    }))
  }

  return (
    <div className={`transfers ${open ? 'open' : ''}`}>
      <div className="tr-head" onClick={() => setOpen(!open)}>
        <ChevronRight size={14} className="chev" />
        <b>Transfers</b>
        <span className="muted">{active ? `${active} active` : 'all done'}</span>
        <div className="grow" />
        <button
          className="btn sm"
          onClick={(e) => {
            e.stopPropagation()
            clear()
          }}
        >
          Clear finished
        </button>
      </div>
      {open && (
        <div className="tr-list">
          {list.map((t) => {
            const pct = t.bytesTotal ? Math.min(100, (t.bytesDone / t.bytesTotal) * 100) : t.state === 'done' ? 100 : 0
            return (
              <div key={t.id} className={`tr-row st-${t.state}`}>
                {t.direction === 'upload' ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
                <div className="tr-name" title={`${t.source} → ${t.destination}`}>
                  {t.name}
                  {t.filesTotal > 1 && <span className="muted"> · {t.filesDone}/{t.filesTotal} files</span>}
                </div>
                <div className="tr-bar">
                  <div style={{ width: `${pct}%` }} />
                </div>
                <div className="tr-meta muted">
                  {t.state === 'running' && `${bytes(t.bytesDone)} / ${bytes(t.bytesTotal)} · ${rate(t.bytesPerSec)}`}
                  {t.state === 'queued' && 'Queued'}
                  {t.state === 'done' && bytes(t.bytesTotal)}
                  {t.state === 'cancelled' && 'Cancelled'}
                  {t.state === 'error' && <span className="err-text">{t.error}</span>}
                </div>
                {t.state === 'running' || t.state === 'queued' ? (
                  <button className="icon-btn" title="Cancel" onClick={() => void api.sftp.cancelTransfer(t.id)}>
                    <X size={14} />
                  </button>
                ) : t.state === 'done' ? (
                  <CircleCheck size={15} className="ok-text" />
                ) : (
                  <CircleX size={15} className="err-text" />
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
