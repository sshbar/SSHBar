import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import {
  ArrowUp,
  Download,
  Eye,
  EyeOff,
  File as FileIcon,
  Folder,
  FolderPlus,
  House,
  Link,
  LoaderCircle,
  Monitor,
  Pencil,
  RefreshCw,
  Server,
  Trash,
  Upload
} from 'lucide-react'
import type { DirListing, FileEntry } from '../../../shared/types'
import { bytes, dateTime, errorText } from '../format'
import { ConfirmDialog, InputDialog } from './Modal'

export interface FileSource {
  kind: 'local' | 'remote'
  title: string
  home(): Promise<string>
  list(path: string): Promise<DirListing>
  mkdir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(paths: string[]): Promise<void>
  join(dir: string, name: string): Promise<string> | string
  /** Double-click on a file */
  open(entry: FileEntry): void
}

export const DRAG_MIME = 'application/x-sshbar-files'

type SortKey = 'name' | 'size' | 'mtime'

function isDir(e: FileEntry): boolean {
  return e.kind === 'dir' || (e.kind === 'link' && !!e.isDirLink)
}

export function FilePane({
  source,
  refreshKey,
  disabled,
  onListing,
  onTransfer,
  onDropFromOs,
  onDropFromPane,
  transferLabel,
  onError
}: {
  source: FileSource
  refreshKey: number
  disabled?: boolean
  onListing: (l: DirListing) => void
  /** Send the given paths to the other pane */
  onTransfer: (paths: string[]) => void
  /** Files dropped from the operating system */
  onDropFromOs?: (paths: string[]) => void
  /** Files dragged here from the other pane */
  onDropFromPane: (paths: string[]) => void
  transferLabel: string
  onError: (msg: string) => void
}) {
  const [listing, setListing] = useState<DirListing | null>(null)
  const [pathInput, setPathInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: 'name', asc: true })
  const [dialog, setDialog] = useState<null | { kind: 'mkdir' } | { kind: 'rename'; entry: FileEntry } | { kind: 'delete'; paths: string[] }>(null)
  const [dragOver, setDragOver] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const pathRef = useRef<string>('')

  const load = useCallback(
    async (path: string, keepSelection = false) => {
      setLoading(true)
      setError('')
      try {
        const l = await source.list(path)
        pathRef.current = l.path
        setListing(l)
        setPathInput(l.path)
        onListing(l)
        if (!keepSelection) setSelected(new Set())
      } catch (e) {
        setError(errorText(e))
        setPathInput(pathRef.current)
      } finally {
        setLoading(false)
      }
    },
    [source, onListing]
  )

  useEffect(() => {
    if (disabled) return
    if (!pathRef.current) {
      source
        .home()
        .then((h) => load(h))
        .catch((e) => setError(errorText(e)))
    } else {
      void load(pathRef.current, true)
    }
  }, [refreshKey, disabled])

  const entries = useMemo(() => {
    const list = (listing?.entries ?? []).filter((e) => showHidden || !e.name.startsWith('.'))
    const dir = (e: FileEntry): number => (isDir(e) ? 0 : 1)
    return list.sort((a, b) => {
      if (dir(a) !== dir(b)) return dir(a) - dir(b)
      let c = 0
      if (sort.key === 'name') c = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      else if (sort.key === 'size') c = a.size - b.size
      else c = a.mtime - b.mtime
      return sort.asc ? c : -c
    })
  }, [listing, showHidden, sort])

  const selectedEntries = entries.filter((e) => selected.has(e.path))

  const clickRow = (e: React.MouseEvent, entry: FileEntry): void => {
    const next = new Set(e.ctrlKey || e.metaKey ? selected : [])
    if (e.shiftKey && anchor) {
      const a = entries.findIndex((x) => x.path === anchor)
      const b = entries.findIndex((x) => x.path === entry.path)
      const [lo, hi] = a < b ? [a, b] : [b, a]
      for (let i = lo; i <= hi; i++) next.add(entries[i].path)
    } else if ((e.ctrlKey || e.metaKey) && selected.has(entry.path)) {
      next.delete(entry.path)
    } else {
      next.add(entry.path)
      setAnchor(entry.path)
    }
    setSelected(next)
  }

  const activate = (entry: FileEntry): void => {
    if (isDir(entry)) void load(entry.path)
    else source.open(entry)
  }

  const goUp = (): void => {
    if (listing?.parent) void load(listing.parent)
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    if (e.key === 'Backspace') {
      e.preventDefault()
      goUp()
    } else if (e.key === 'Delete' && selected.size) {
      setDialog({ kind: 'delete', paths: [...selected] })
    } else if (e.key === 'F2' && selectedEntries.length === 1) {
      setDialog({ kind: 'rename', entry: selectedEntries[0] })
    } else if (e.key === 'Enter' && selectedEntries.length === 1) {
      activate(selectedEntries[0])
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      setSelected(new Set(entries.map((x) => x.path)))
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const idx = entries.findIndex((x) => x.path === anchor)
      const n = Math.max(0, Math.min(entries.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)))
      const entry = entries[n]
      if (entry) {
        setSelected(new Set([entry.path]))
        setAnchor(entry.path)
        listRef.current?.querySelector(`[data-idx="${n}"]`)?.scrollIntoView({ block: 'nearest' })
      }
    }
  }

  // ----- drag & drop -----
  const onDragStart = (e: DragEvent, entry: FileEntry): void => {
    const paths = selected.has(entry.path) ? [...selected] : [entry.path]
    if (!selected.has(entry.path)) setSelected(new Set([entry.path]))
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ from: source.kind, paths }))
    e.dataTransfer.effectAllowed = 'copy'
  }

  const onDragOver = (e: DragEvent): void => {
    const types = e.dataTransfer.types
    const internal = types.includes(DRAG_MIME)
    const osFiles = types.includes('Files') && !!onDropFromOs
    if (internal || osFiles) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setDragOver(true)
    }
  }

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    setDragOver(false)
    const raw = e.dataTransfer.getData(DRAG_MIME)
    if (raw) {
      const data = JSON.parse(raw) as { from: string; paths: string[] }
      // dropping onto the pane it came from does nothing
      if (data.from !== source.kind) onDropFromPane(data.paths)
      return
    }
    if (onDropFromOs && e.dataTransfer.files.length) {
      const paths = [...e.dataTransfer.files].map((f) => window.sshbar.pathForFile(f)).filter(Boolean)
      if (paths.length) onDropFromOs(paths)
    }
  }

  const sortHeader = (key: SortKey, label: string, cls: string) => (
    <button className={`th ${cls}`} onClick={() => setSort((s) => ({ key, asc: s.key === key ? !s.asc : true }))}>
      {label}
      {sort.key === key ? (sort.asc ? ' ↑' : ' ↓') : ''}
    </button>
  )

  return (
    <div
      className={`file-pane ${dragOver ? 'drag-over' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false)
      }}
      onDrop={onDrop}
    >
      <div className="fp-head">
        <div className="fp-title">
          {source.kind === 'local' ? <Monitor size={14} /> : <Server size={14} />}
          {source.title}
        </div>
        <div className="fp-tools">
          <button className="icon-btn" title="Up (Backspace)" onClick={goUp} disabled={!listing?.parent}>
            <ArrowUp size={15} />
          </button>
          <button className="icon-btn" title="Home" onClick={() => source.home().then((h) => load(h))}>
            <House size={15} />
          </button>
          <button className="icon-btn" title="Refresh" onClick={() => listing && load(listing.path, true)}>
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
          </button>
          <button className="icon-btn" title="New folder" onClick={() => setDialog({ kind: 'mkdir' })} disabled={!listing}>
            <FolderPlus size={15} />
          </button>
          <button
            className="icon-btn"
            title="Rename (F2)"
            onClick={() => selectedEntries.length === 1 && setDialog({ kind: 'rename', entry: selectedEntries[0] })}
            disabled={selectedEntries.length !== 1}
          >
            <Pencil size={15} />
          </button>
          <button
            className="icon-btn danger"
            title={source.kind === 'local' ? 'Move to trash (Del)' : 'Delete (Del)'}
            onClick={() => setDialog({ kind: 'delete', paths: [...selected] })}
            disabled={!selected.size}
          >
            <Trash size={15} />
          </button>
          <button className="icon-btn" title={showHidden ? 'Hide hidden files' : 'Show hidden files'} onClick={() => setShowHidden(!showHidden)}>
            {showHidden ? <Eye size={15} /> : <EyeOff size={15} />}
          </button>
          <button className="btn sm primary" disabled={!selected.size} onClick={() => onTransfer([...selected])} title={transferLabel}>
            {source.kind === 'local' ? <Upload size={13} /> : <Download size={13} />}
            {transferLabel}
          </button>
        </div>
      </div>

      <form
        className="fp-path"
        onSubmit={(e) => {
          e.preventDefault()
          if (pathInput.trim()) void load(pathInput.trim())
        }}
      >
        <input value={pathInput} onChange={(e) => setPathInput(e.target.value)} spellCheck={false} className="mono" />
      </form>

      <div className="fp-table" tabIndex={0} onKeyDown={onKeyDown} ref={listRef}>
        <div className="fp-row fp-header">
          {sortHeader('name', 'Name', 'c-name')}
          {sortHeader('size', 'Size', 'c-size')}
          {sortHeader('mtime', 'Modified', 'c-date')}
          <span className="th c-perm">Permissions</span>
        </div>
        {error && <div className="fp-error">{error}</div>}
        {disabled && <div className="muted center pad">Not connected</div>}
        {!error && !disabled && !listing && (
          <div className="muted center pad">
            <LoaderCircle className="spin" size={16} />
          </div>
        )}
        {listing?.parent && (
          <div className="fp-row" onDoubleClick={goUp}>
            <span className="c-name">
              <Folder size={15} className="ico-dir" /> ..
            </span>
          </div>
        )}
        {entries.map((entry, i) => (
          <div
            key={entry.path}
            data-idx={i}
            className={`fp-row ${selected.has(entry.path) ? 'sel' : ''}`}
            onClick={(e) => clickRow(e, entry)}
            onDoubleClick={() => activate(entry)}
            draggable
            onDragStart={(e) => onDragStart(e, entry)}
          >
            <span className="c-name" title={entry.name}>
              {isDir(entry) ? (
                <Folder size={15} className="ico-dir" />
              ) : entry.kind === 'link' ? (
                <Link size={15} className="ico-link" />
              ) : (
                <FileIcon size={15} className="ico-file" />
              )}
              <span className="name">{entry.name}</span>
            </span>
            <span className="c-size">{isDir(entry) ? '' : bytes(entry.size)}</span>
            <span className="c-date">{dateTime(entry.mtime)}</span>
            <span className="c-perm mono">{entry.permissions}</span>
          </div>
        ))}
        {listing && entries.length === 0 && <div className="muted center pad">Empty folder</div>}
      </div>
      <div className="fp-foot muted small">
        {listing ? `${entries.length} items` : ''}
        {selected.size ? ` · ${selected.size} selected (${bytes(selectedEntries.reduce((a, e) => a + (isDir(e) ? 0 : e.size), 0))})` : ''}
        {source.kind === 'remote' && onDropFromOs ? ' · drop files here to upload' : ''}
      </div>

      {dialog?.kind === 'mkdir' && listing && (
        <InputDialog
          title="New folder"
          label="Folder name"
          initial=""
          confirmLabel="Create"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            setDialog(null)
            try {
              await source.mkdir(await source.join(listing.path, name))
              await load(listing.path)
            } catch (e) {
              onError(errorText(e))
            }
          }}
        />
      )}
      {dialog?.kind === 'rename' && listing && (
        <InputDialog
          title="Rename"
          label="New name"
          initial={dialog.entry.name}
          confirmLabel="Rename"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const entry = dialog.entry
            setDialog(null)
            if (name === entry.name) return
            try {
              await source.rename(entry.path, await source.join(listing.path, name))
              await load(listing.path)
            } catch (e) {
              onError(errorText(e))
            }
          }}
        />
      )}
      {dialog?.kind === 'delete' && listing && (
        <ConfirmDialog
          title={source.kind === 'local' ? 'Move to trash' : 'Delete from server'}
          danger
          confirmLabel={source.kind === 'local' ? 'Move to trash' : 'Delete permanently'}
          message={
            <>
              {source.kind === 'local' ? 'Move' : 'Permanently delete'} {dialog.paths.length === 1 ? <b>{dialog.paths[0]}</b> : <b>{dialog.paths.length} items</b>}
              {source.kind === 'remote' ? ' from the server? Folders are deleted with everything inside. This cannot be undone.' : ' to the trash?'}
            </>
          }
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const paths = dialog.paths
            setDialog(null)
            try {
              await source.remove(paths)
            } catch (e) {
              onError(errorText(e))
            }
            await load(listing.path)
          }}
        />
      )}
    </div>
  )
}
