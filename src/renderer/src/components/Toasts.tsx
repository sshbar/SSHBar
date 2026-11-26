import { CircleCheck, Download, Info, TriangleExclamationPoint, X } from 'lucide-react'
import { api } from '../api'
import { useStore } from '../store'

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  return (
    <div className="toasts">
      <UpdateNotice />
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.kind === 'error' ? <TriangleExclamationPoint size={16} /> : t.kind === 'success' ? <CircleCheck size={16} /> : <Info size={16} />}
          <span>{t.text}</span>
          <button className="icon-btn" onClick={() => dismiss(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}

/** Stays until dismissed (unlike toasts): found by the startup check, see store.init. */
function UpdateNotice() {
  const notice = useStore((s) => s.updateNotice)
  const dismissUpdate = useStore((s) => s.dismissUpdate)
  if (!notice) return null
  return (
    <div className="toast toast-update" role="status">
      <Download size={16} />
      <div className="update-body">
        <div>
          <b>SSHbar {notice.latest}</b> is available. You have {notice.current}.
        </div>
        <div className="row gap">
          <button
            className="btn primary sm"
            onClick={() => {
              void api.openExternal(notice.url)
              dismissUpdate(false)
            }}
          >
            <Download size={13} /> Download
          </button>
          <button className="btn sm" onClick={() => dismissUpdate(true)} title="Don't remind me about this version">
            Skip this version
          </button>
        </div>
      </div>
      <button className="icon-btn" onClick={() => dismissUpdate(false)} title="Remind me next time">
        <X size={14} />
      </button>
    </div>
  )
}
