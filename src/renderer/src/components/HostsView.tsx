import { useMemo, useState, type ReactElement } from 'react'
import { Copy, Import, KeyRound, Lock, Pencil, Plus, Search, Server, Trash, Upload, Plug } from 'lucide-react'
import type { Host } from '../../../shared/types'
import { emptyHost } from '../../../shared/defaults'
import { api } from '../api'
import { useStore } from '../store'
import { errorText } from '../format'
import { ConfirmDialog } from './Modal'

function authBadge(h: Host): { icon: ReactElement; text: string; proton: boolean } {
  const a = h.auth
  if (a.method === 'key') {
    return { icon: <KeyRound size={12} />, text: 'Key', proton: a.key.source === 'protonpass' }
  }
  if (a.method === 'agent') {
    return { icon: <Plug size={12} />, text: a.agent === 'protonpass' ? 'Pass agent' : 'Agent', proton: a.agent === 'protonpass' }
  }
  return { icon: <Lock size={12} />, text: 'Password', proton: a.password.source === 'protonpass' }
}

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6', '#ec4899', '#84cc16']
function colorFor(s: string): string {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return COLORS[h % COLORS.length]
}

export function HostsView() {
  const hosts = useStore((s) => s.hosts)
  const connect = useStore((s) => s.connect)
  const openEditor = useStore((s) => s.openEditor)
  const toast = useStore((s) => s.toast)
  const [q, setQ] = useState('')
  const [deleting, setDeleting] = useState<Host | null>(null)

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const filtered = hosts.filter(
      (h) =>
        !needle ||
        [h.label, h.hostname, h.username, h.group, ...h.tags].some((f) => f.toLowerCase().includes(needle))
    )
    const map = new Map<string, Host[]>()
    for (const h of filtered) {
      const g = h.group || ''
      map.set(g, [...(map.get(g) ?? []), h])
    }
    return [...map.entries()]
      .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
      .map(([g, list]) => [g, list.sort((x, y) => x.label.localeCompare(y.label))] as const)
  }, [hosts, q])

  const importSsh = async (): Promise<void> => {
    try {
      const r = await api.hosts.importSshConfig()
      toast('success', `Imported ${r.added} host${r.added === 1 ? '' : 's'} from ~/.ssh/config${r.skipped ? ` (${r.skipped} already present)` : ''}`)
    } catch (e) {
      toast('error', errorText(e))
    }
  }

  const importJson = async (): Promise<void> => {
    try {
      const r = await api.hosts.importJson()
      if (r.added || r.skipped) toast('success', `Imported ${r.added} host(s)${r.skipped ? `, skipped ${r.skipped}` : ''}`)
    } catch (e) {
      toast('error', errorText(e))
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Hosts</h1>
        <div className="search">
          <Search size={15} />
          <input placeholder="Search hosts, groups, tags…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="grow" />
        <button className="btn" onClick={importSsh} title="Import hosts from ~/.ssh/config">
          <Import size={15} /> SSH config
        </button>
        <button className="btn" onClick={importJson} title="Import hosts from an SSHBuddy JSON export">
          <Upload size={15} /> Import
        </button>
        <button className="btn primary" onClick={() => openEditor(emptyHost())}>
          <Plus size={15} /> New host
        </button>
      </div>

      {hosts.length === 0 ? (
        <div className="empty">
          <Server size={42} />
          <h2>No hosts yet</h2>
          <p>Add a server to get a terminal, a file manager and live resource stats.</p>
          <div className="row gap">
            <button className="btn primary" onClick={() => openEditor(emptyHost())}>
              <Plus size={15} /> Add a host
            </button>
            <button className="btn" onClick={importSsh}>
              <Import size={15} /> Import ~/.ssh/config
            </button>
          </div>
        </div>
      ) : (
        <div className="host-groups">
          {groups.map(([group, list]) => (
            <section key={group || '_'}>
              <h3 className="group-title">
                {group || 'Ungrouped'} <span className="muted">{list.length}</span>
              </h3>
              <div className="host-grid">
                {list.map((h) => {
                  const badge = authBadge(h)
                  return (
                    <div
                      key={h.id}
                      className="host-card"
                      onDoubleClick={() => void connect(h.id)}
                      onKeyDown={(e) => e.key === 'Enter' && void connect(h.id)}
                      tabIndex={0}
                    >
                      <div className="host-avatar" style={{ background: colorFor(h.group + h.label) }}>
                        {h.label.slice(0, 2).toUpperCase()}
                      </div>
                      <div className="host-info">
                        <div className="host-label">{h.label}</div>
                        <div className="host-sub">
                          {h.username ? `${h.username}@` : ''}
                          {h.hostname}
                          {h.port !== 22 ? `:${h.port}` : ''}
                        </div>
                        <div className="host-badges">
                          <span className="badge">
                            {badge.icon}
                            {badge.text}
                          </span>
                          {badge.proton && <span className="badge proton">Proton Pass</span>}
                          {h.tags.map((t) => (
                            <span key={t} className="badge tag">
                              {t}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="host-actions">
                        <button className="btn primary sm" onClick={() => void connect(h.id)}>
                          Connect
                        </button>
                        <div className="row">
                          <button className="icon-btn" title="Edit" onClick={() => openEditor(h)}>
                            <Pencil size={14} />
                          </button>
                          <button
                            className="icon-btn"
                            title="Duplicate"
                            onClick={() => api.hosts.duplicate(h.id).catch((e) => toast('error', errorText(e)))}
                          >
                            <Copy size={14} />
                          </button>
                          <button className="icon-btn danger" title="Delete" onClick={() => setDeleting(h)}>
                            <Trash size={14} />
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
          {groups.length === 0 && <p className="muted center">No hosts match “{q}”.</p>}
        </div>
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete host"
          message={
            <>
              Delete <b>{deleting.label}</b>? Passwords or keys saved on this device for it are removed too. Items in Proton Pass are not touched.
            </>
          }
          confirmLabel="Delete"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            api.hosts.remove(deleting.id).catch((e) => toast('error', errorText(e)))
            setDeleting(null)
          }}
        />
      )}
    </div>
  )
}
