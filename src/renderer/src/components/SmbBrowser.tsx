import { useEffect, useState } from 'react'
import { CornerLeftUp, FilePlus2, FileText, Folder, LoaderCircle } from 'lucide-react'
import { api } from '../api'
import { bytes, errorText } from '../format'
import type { SmbEntry, SmbLogin } from '../../../shared/types'
import { SMB_PORT, joinSmb, parentSmb, parseServerInput, smbLabel } from '../../../shared/smbPath'

const SYNC_NAME = 'sshbar-sync.json'
const noAuto = { autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false } as const

/**
 * Android: find the sync file on a NAS (SMB share) without a separate app. Log in once, browse to the
 * file the computer uses (or a folder for a new one); the login is kept in the phone's secure storage.
 */
export function SmbBrowser({ onPick, onCancel }: { onPick(path: string, mode: 'open' | 'create'): void; onCancel(): void }) {
  const smb = api.fileSync.smb!
  const [server, setServer] = useState('')
  const [share, setShare] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [savedPw, setSavedPw] = useState(false)
  const [startDir, setStartDir] = useState('')
  const [login, setLogin] = useState<SmbLogin | null>(null)
  const [dir, setDir] = useState('')
  const [entries, setEntries] = useState<SmbEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void smb
      .saved()
      .then((s) => {
        if (!s) return
        setServer(s.port !== SMB_PORT ? `${s.host}:${s.port}` : s.host)
        setShare(s.share)
        setUsername(s.username)
        setStartDir(s.dir)
        setSavedPw(s.hasPassword)
      })
      .catch(() => undefined)
  }, [smb])

  const open = async (l: SmbLogin, d: string, fallbackToRoot = false): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      let target = d
      let list: SmbEntry[]
      try {
        list = await smb.list(l, target)
      } catch (e) {
        // the folder used last time may be gone; the share itself still opens
        if (!fallbackToRoot || !target || !/^Not found/.test(errorText(e))) throw e
        target = ''
        list = await smb.list(l, target)
      }
      setLogin(l)
      setDir(target)
      setEntries(list)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const connect = (): void => {
    const p = parseServerInput(server)
    if (!p.host) return setError('Enter the NAS address')
    const shareName = (p.share ?? share).replace(/^[\\/]+|[\\/]+$/g, '')
    if (!shareName) return setError('Enter the share name')
    // pasted \\nas\share\folder: split it into the fields, and keep the folder for the next try
    if (p.share) setShare(p.share)
    if (p.dir) setStartDir(p.dir)
    setServer(p.port !== SMB_PORT ? `${p.host}:${p.port}` : p.host)
    void open({ host: p.host, port: p.port, share: shareName, username: username.trim(), password }, p.dir ?? startDir, true)
  }

  const choose = async (name: string, mode: 'open' | 'create'): Promise<void> => {
    if (!login) return
    setBusy(true)
    setError('')
    try {
      onPick(await smb.choose(login, joinSmb(dir, name)), mode)
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  // ----- login -----
  if (!login) {
    return (
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          connect()
        }}
      >
        <p className="muted small">Use the same NAS share where your computer keeps the sync file. You can also paste a path like \\192.168.0.10\share\folder.</p>
        <div className="grid-2">
          <label className="field">
            <span>NAS address</span>
            <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="192.168.0.10 or nas.local" inputMode="url" autoFocus {...noAuto} />
          </label>
          <label className="field">
            <span>Share</span>
            <input value={share} onChange={(e) => setShare(e.target.value)} placeholder="e.g. NAS, home, Public" {...noAuto} />
          </label>
          <label className="field">
            <span>Username</span>
            <input value={username} onChange={(e) => (setUsername(e.target.value), setSavedPw(false))} placeholder="empty for guest access" autoComplete="username" {...noAuto} />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={savedPw ? 'saved on this phone' : ''}
              autoComplete="current-password"
            />
          </label>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="row gap">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy && <LoaderCircle size={14} className="spin" />} Connect
          </button>
        </div>
      </form>
    )
  }

  // ----- browse -----
  const hasSyncFile = entries.some((e) => !e.dir && e.name.toLowerCase() === SYNC_NAME)
  return (
    <div className="form">
      <div className="field">
        <span>Choose the sync file, or a folder for a new one</span>
        <code className="path-line">{smbLabel({ ...login, path: dir })}</code>
      </div>
      <div className="pp-list smb-list">
        {dir && (
          <button className="pp-item" disabled={busy} onClick={() => void open(login, parentSmb(dir))}>
            <CornerLeftUp size={15} className="ico-dir" /> <span>Up</span>
          </button>
        )}
        {entries.map((e) => (
          <button
            key={e.name}
            className={`pp-item${!e.dir && e.name.toLowerCase().endsWith('.json') ? ' on' : ''}`}
            disabled={busy}
            onClick={() => void (e.dir ? open(login, joinSmb(dir, e.name)) : choose(e.name, 'open'))}
          >
            {e.dir ? <Folder size={15} className="ico-dir" /> : <FileText size={15} className="ico-file" />}
            <span className="smb-name">{e.name}</span>
            {!e.dir && <span className="muted small">{bytes(e.size)}</span>}
          </button>
        ))}
        {!entries.length && <div className="muted small pad">This folder is empty</div>}
      </div>
      {error && <div className="form-error">{error}</div>}
      <div className="row gap wrap">
        <button className="btn" onClick={() => (setLogin(null), setError(''))}>
          Back
        </button>
        {!hasSyncFile && (
          <button className="btn primary" disabled={busy} onClick={() => void choose(SYNC_NAME, 'create')}>
            <FilePlus2 size={14} /> New sync file here
          </button>
        )}
        {busy && <LoaderCircle size={16} className="spin" />}
      </div>
    </div>
  )
}
