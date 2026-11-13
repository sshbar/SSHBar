import { useMemo, useState } from 'react'
import { Braces, Copy, Pencil, Plus, Search, Trash } from 'lucide-react'
import type { Snippet, SnippetInput } from '../../../shared/types'
import { api } from '../api'
import { useStore } from '../store'
import { errorText } from '../format'
import { ConfirmDialog, Modal } from './Modal'

function SnippetEditor({ initial, onClose }: { initial: SnippetInput; onClose: () => void }) {
  const toast = useStore((s) => s.toast)
  const [name, setName] = useState(initial.name)
  const [command, setCommand] = useState(initial.command)
  const [error, setError] = useState('')
  const save = async (): Promise<void> => {
    if (!command.trim()) return setError('Enter a command')
    try {
      await api.snippets.save({ id: initial.id, name, command })
      onClose()
    } catch (e) {
      setError(errorText(e))
      toast('error', errorText(e))
    }
  }
  return (
    <Modal
      title={initial.id ? 'Edit snippet' : 'New snippet'}
      onClose={onClose}
      width={600}
      footer={
        <>
          {error && <div className="form-error grow">{error}</div>}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div className="form">
        <label className="field">
          <span>Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Disk usage by folder" />
        </label>
        <label className="field">
          <span>Command (multi-line allowed)</span>
          <textarea
            className="mono"
            rows={7}
            value={command}
            spellCheck={false}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void save()
            }}
            placeholder="sudo du -h --max-depth=1 / | sort -h"
          />
        </label>
        <p className="muted small">
          In a session press <kbd>{api.platform === 'darwin' ? '⌘' : 'Ctrl'}</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> to paste or run a snippet. Snippets
          sync along with your hosts.
        </p>
      </div>
    </Modal>
  )
}

export function SnippetsView() {
  const snippets = useStore((s) => s.snippets)
  const toast = useStore((s) => s.toast)
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<SnippetInput | null>(null)
  const [deleting, setDeleting] = useState<Snippet | null>(null)

  const list = useMemo(() => {
    const n = q.trim().toLowerCase()
    return snippets
      .filter((s) => !n || s.name.toLowerCase().includes(n) || s.command.toLowerCase().includes(n))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [snippets, q])

  return (
    <div className="page">
      <div className="page-head">
        <h1>Snippets</h1>
        <div className="search">
          <Search size={15} />
          <input placeholder="Search snippets…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="grow" />
        <button className="btn primary" onClick={() => setEditing({ name: '', command: '' })}>
          <Plus size={15} /> New snippet
        </button>
      </div>

      {snippets.length === 0 ? (
        <div className="empty">
          <Braces size={40} />
          <h2>No snippets yet</h2>
          <p>Save commands you type often and paste or run them in any session.</p>
          <button className="btn primary" onClick={() => setEditing({ name: '', command: '' })}>
            <Plus size={15} /> Add a snippet
          </button>
        </div>
      ) : (
        <div className="snippet-list">
          {list.map((s) => (
            <div key={s.id} className="snippet-card">
              <div className="grow">
                <div className="snippet-name">{s.name}</div>
                <pre className="snippet-cmd mono">{s.command}</pre>
              </div>
              <div className="row">
                <button className="icon-btn" title="Copy" onClick={() => void api.clipboard.write(s.command).then(() => toast('info', 'Copied'))}>
                  <Copy size={14} />
                </button>
                <button className="icon-btn" title="Edit" onClick={() => setEditing(s)}>
                  <Pencil size={14} />
                </button>
                <button className="icon-btn danger" title="Delete" onClick={() => setDeleting(s)}>
                  <Trash size={14} />
                </button>
              </div>
            </div>
          ))}
          {list.length === 0 && <p className="muted center">No snippets match “{q}”.</p>}
        </div>
      )}

      {editing && <SnippetEditor initial={editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog
          title="Delete snippet"
          danger
          confirmLabel="Delete"
          message={
            <>
              Delete <b>{deleting.name}</b>?
            </>
          }
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            api.snippets.remove(deleting.id).catch((e) => toast('error', errorText(e)))
            setDeleting(null)
          }}
        />
      )}
    </div>
  )
}
