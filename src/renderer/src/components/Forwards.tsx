import { useState } from 'react'
import { Plus, TriangleExclamationPoint } from 'lucide-react'
import type { ForwardType, PortForward } from '../../../shared/types'
import { isLoopback } from '../../../shared/forwards'

export const FORWARD_TYPES: { value: ForwardType; label: string; short: string; help: string }[] = [
  {
    value: 'local',
    label: 'Local',
    short: 'L',
    help: 'Open a port on this computer that leads to a service reachable from the server (ssh -L). E.g. localhost:5432 → a database on the server.'
  },
  {
    value: 'remote',
    label: 'Remote',
    short: 'R',
    help: 'Open a port on the server that leads back to a service reachable from this computer (ssh -R). E.g. let the server reach your local dev server.'
  },
  {
    value: 'dynamic',
    label: 'SOCKS proxy',
    short: 'D',
    help: 'A SOCKS5 proxy on this computer; every connection goes out from the server (ssh -D). Point a browser at it to browse the server’s network.'
  }
]

export function ForwardPill({ type }: { type: ForwardType }) {
  const t = FORWARD_TYPES.find((x) => x.value === type)!
  return (
    <span className={`fwd-pill fwd-${type}`} title={t.label}>
      {t.short}
    </span>
  )
}

const blank = (type: ForwardType): Omit<PortForward, 'id'> => ({
  type,
  label: '',
  bindAddress: '127.0.0.1',
  bindPort: type === 'dynamic' ? 1080 : 0,
  destHost: type === 'remote' ? '127.0.0.1' : 'localhost',
  destPort: 0,
  autoStart: true
})

/** Form to define a port forward. */
export function ForwardForm({
  onAdd,
  onCancel,
  saveOption
}: {
  onAdd: (f: PortForward, save: boolean) => void
  onCancel?: () => void
  /** show a "save to host" checkbox (session view); the host editor always saves */
  saveOption?: boolean
}) {
  const [f, setF] = useState<Omit<PortForward, 'id'>>(blank('local'))
  const [save, setSave] = useState(true)
  const [error, setError] = useState('')
  const set = <K extends keyof PortForward>(k: K, v: PortForward[K]): void => setF((p) => ({ ...p, [k]: v }))
  const help = FORWARD_TYPES.find((t) => t.value === f.type)!.help
  const exposed = f.type !== 'remote' && !isLoopback(f.bindAddress)
  const remoteExposed = f.type === 'remote' && !isLoopback(f.bindAddress)

  const submit = (): void => {
    if (f.bindPort < 0 || f.bindPort > 65535) return setError('Listen port must be 0–65535 (0 = pick a free port)')
    if (f.type !== 'dynamic' && (!f.destHost.trim() || !(f.destPort > 0 && f.destPort < 65536))) return setError('Enter the destination host and port')
    setError('')
    onAdd({ ...f, id: crypto.randomUUID(), destHost: f.destHost.trim(), bindAddress: f.bindAddress.trim() || '127.0.0.1' }, save)
    setF(blank(f.type))
  }

  return (
    <div className="fwd-form">
      <div className="segmented">
        {FORWARD_TYPES.map((t) => (
          <button type="button" key={t.value} className={f.type === t.value ? 'on' : ''} onClick={() => setF({ ...blank(t.value), label: f.label })}>
            <ForwardPill type={t.value} /> {t.label}
          </button>
        ))}
      </div>
      <p className="muted small">{help}</p>
      <div className="fwd-grid">
        <label className="field">
          <span>{f.type === 'remote' ? 'Listen on server address' : 'Listen on address'}</span>
          <input className="mono" value={f.bindAddress} onChange={(e) => set('bindAddress', e.target.value)} />
        </label>
        <label className="field">
          <span>Port</span>
          <input type="number" min={0} max={65535} value={f.bindPort} onChange={(e) => set('bindPort', Number(e.target.value))} />
        </label>
        {f.type !== 'dynamic' && (
          <>
            <label className="field">
              <span>{f.type === 'local' ? 'Destination (as seen from the server)' : 'Destination (as seen from this computer)'}</span>
              <input className="mono" value={f.destHost} onChange={(e) => set('destHost', e.target.value)} />
            </label>
            <label className="field">
              <span>Port</span>
              <input type="number" min={1} max={65535} value={f.destPort || ''} onChange={(e) => set('destPort', Number(e.target.value))} />
            </label>
          </>
        )}
        <label className="field fwd-label">
          <span>Label (optional)</span>
          <input value={f.label} onChange={(e) => set('label', e.target.value)} placeholder="e.g. Postgres" />
        </label>
      </div>
      {exposed && (
        <p className="warn-text small row gap">
          <TriangleExclamationPoint size={14} /> Listening on {f.bindAddress} lets other machines on your network use this tunnel.
        </p>
      )}
      {remoteExposed && (
        <p className="warn-text small row gap">
          <TriangleExclamationPoint size={14} /> Binding to {f.bindAddress} on the server needs GatewayPorts enabled there and exposes the port to its network.
        </p>
      )}
      <div className="row gap wrap">
        <label className="check inline">
          <input type="checkbox" checked={f.autoStart} onChange={(e) => set('autoStart', e.target.checked)} /> Start automatically on connect
        </label>
        {saveOption && (
          <label className="check inline">
            <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> Save to host
          </label>
        )}
        <div className="grow" />
        {error && <span className="form-error">{error}</span>}
        {onCancel && (
          <button type="button" className="btn sm" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="button" className="btn sm primary" onClick={submit}>
          <Plus size={13} /> Add forward
        </button>
      </div>
    </div>
  )
}
