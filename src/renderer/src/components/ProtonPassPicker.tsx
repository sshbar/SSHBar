import { useEffect, useMemo, useState } from 'react'
import { KeyRound, LoaderCircle, Lock, RefreshCw, Search } from 'lucide-react'
import type { PPItem, PPVault } from '../../../shared/types'
import { api } from '../api'
import { errorText } from '../format'

let vaultCache: PPVault[] | null = null

export interface PPRef {
  shareId: string
  itemId: string
  title?: string
}

/** Pick a login or SSH key item from Proton Pass via the CLI. */
export function ProtonPassPicker({
  type,
  value,
  onChange
}: {
  type: 'login' | 'ssh-key'
  value: PPRef | null
  onChange: (ref: PPRef) => void
}) {
  const [open, setOpen] = useState(!value?.itemId)
  const [vaults, setVaults] = useState<PPVault[] | null>(vaultCache)
  const [shareId, setShareId] = useState(value?.shareId ?? '')
  const [items, setItems] = useState<PPItem[] | null>(null)
  const [q, setQ] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const loadVaults = async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const v = await api.protonPass.vaults()
      vaultCache = v
      setVaults(v)
      if (!shareId && v[0]) setShareId(v[0].shareId)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open && !vaults) void loadVaults()
    else if (open && vaults && !shareId && vaults[0]) setShareId(vaults[0].shareId)
  }, [open])

  useEffect(() => {
    if (!open || !shareId) return
    let cancelled = false
    setItems(null)
    setError('')
    api.protonPass
      .items(shareId, type)
      .then((list) => !cancelled && setItems(list))
      .catch((e) => !cancelled && setError(errorText(e)))
    return () => {
      cancelled = true
    }
  }, [open, shareId, type])

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase()
    return (items ?? []).filter((i) => !n || i.title.toLowerCase().includes(n)).slice(0, 300)
  }, [items, q])

  const vaultName = vaults?.find((v) => v.shareId === value?.shareId)?.name

  if (!open && value?.itemId) {
    return (
      <div className="pp-selected">
        <span className="pp-logo">P</span>
        <div className="grow">
          <div>{value.title || value.itemId}</div>
          {vaultName && <div className="muted small">{vaultName}</div>}
        </div>
        <button type="button" className="btn sm" onClick={() => setOpen(true)}>
          Change
        </button>
      </div>
    )
  }

  return (
    <div className="pp-picker">
      {error ? (
        <div className="pp-error">
          <div>
            <b>Proton Pass CLI:</b> {error}
          </div>
          <div className="muted small">
            Make sure <code>pass-cli</code> is installed and you are logged in (<code>pass-cli login</code>). The CLI path can be changed in Settings.
          </div>
          <button type="button" className="btn sm" onClick={() => void loadVaults()}>
            <RefreshCw size={13} /> Retry
          </button>
        </div>
      ) : (
        <>
          <div className="row gap">
            <select value={shareId} onChange={(e) => setShareId(e.target.value)} disabled={!vaults}>
              {!vaults && <option>Loading vaults…</option>}
              {vaults?.map((v) => (
                <option key={v.shareId} value={v.shareId}>
                  {v.name}
                </option>
              ))}
            </select>
            <div className="search grow">
              <Search size={14} />
              <input placeholder={type === 'ssh-key' ? 'Search SSH keys…' : 'Search logins…'} value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
          <div className="pp-list">
            {(loading || (shareId && items === null)) && (
              <div className="muted center pad">
                <LoaderCircle className="spin" size={16} /> Loading…
              </div>
            )}
            {items && filtered.length === 0 && (
              <div className="muted center pad">{type === 'ssh-key' ? 'No SSH key items in this vault.' : 'No matching logins.'}</div>
            )}
            {filtered.map((i) => (
              <button
                type="button"
                key={i.id}
                className={`pp-item ${value?.itemId === i.id ? 'on' : ''}`}
                onClick={() => {
                  onChange({ shareId: i.shareId, itemId: i.id, title: i.title })
                  setOpen(false)
                }}
              >
                {type === 'ssh-key' ? <KeyRound size={14} /> : <Lock size={14} />}
                <span>{i.title || '(untitled)'}</span>
              </button>
            ))}
          </div>
          {value?.itemId && (
            <button type="button" className="btn sm" onClick={() => setOpen(false)}>
              Keep current: {value.title}
            </button>
          )}
        </>
      )}
    </div>
  )
}
