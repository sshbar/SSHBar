import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 520,
  danger
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
  danger?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${danger ? 'modal-danger' : ''}`} style={{ width }} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

/** Small text-input dialog (rename, new folder). */
export function InputDialog({
  title,
  label,
  initial,
  confirmLabel,
  onSubmit,
  onClose
}: {
  title: string
  label: string
  initial: string
  confirmLabel: string
  onSubmit: (value: string) => void
  onClose: () => void
}) {
  return (
    <Modal title={title} onClose={onClose} width={420}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          const v = (new FormData(e.currentTarget).get('value') as string).trim()
          if (v) onSubmit(v)
        }}
      >
        <label className="field">
          <span>{label}</span>
          <input
            name="value"
            defaultValue={initial}
            autoFocus
            onFocus={(e) => {
              const dot = initial.lastIndexOf('.')
              e.currentTarget.setSelectionRange(0, dot > 0 ? dot : initial.length)
            }}
          />
        </label>
        <div className="modal-foot inline">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onClose
}: {
  title: string
  message: ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={440}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm-msg">{message}</div>
    </Modal>
  )
}
