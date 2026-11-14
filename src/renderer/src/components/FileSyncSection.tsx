import { useState } from 'react'
import { CircleCheck, CircleX, FilePlus2, FolderOpen, HardDrive, LoaderCircle, Lock, RefreshCw } from 'lucide-react'
import { api } from '../api'
import { useStore } from '../store'
import { errorText } from '../format'
import { SmbBrowser } from './SmbBrowser'

type Setup = { mode: 'create' | 'open'; path: string }

/** Settings section: serverless sync through one encrypted file in a folder the user already syncs. */
export function FileSyncSection() {
  const status = useStore((s) => s.fileSync)
  const toast = useStore((s) => s.toast)
  const [setup, setSetup] = useState<Setup | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [includeSecrets, setIncludeSecrets] = useState(true)
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [changing, setChanging] = useState(false)
  const [nas, setNas] = useState(false)

  if (!status) return null

  const reset = (): void => {
    setPassword('')
    setConfirm('')
    setError('')
    setBusy(false)
  }

  const run = async (fn: () => Promise<{ ok: boolean; message: string } | void>, success?: string): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const r = await fn()
      if (r && !r.ok) setError(r.message)
      else {
        if (success || r) toast('success', success ?? (r as { message: string }).message)
        reset()
        setSetup(null)
        setChanging(false)
      }
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const choose = async (mode: Setup['mode']): Promise<void> => {
    const path = await api.fileSync.choosePath(mode)
    if (path) {
      reset()
      setSetup({ mode, path })
    }
  }

  const passwordForm = (withConfirm: boolean) => (
    <div className="grid-2">
      <label className="field">
        <span>{withConfirm ? 'New master password' : 'Master password'}</span>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="new-password" />
      </label>
      {withConfirm && (
        <label className="field">
          <span>Repeat it</span>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </label>
      )}
    </div>
  )

  const mismatch = (withConfirm: boolean): string | null => {
    if (password.length < 8) return 'Use at least 8 characters'
    if (withConfirm && password !== confirm) return 'The passwords do not match'
    return null
  }

  // ----- not set up yet -----
  if (!status.enabled) {
    if (!setup && nas) {
      return (
        <SmbBrowser
          onPick={(path, mode) => {
            reset()
            setNas(false)
            setSetup({ mode, path })
          }}
          onCancel={() => setNas(false)}
        />
      )
    }
    if (!setup) {
      return (
        <>
          <p className="muted small">
            {api.fileSync.smb
              ? 'Keep the file on your NAS (SMB): SSHbar opens the share itself. A file in Google Drive, Proton Drive, OneDrive or Dropbox works too: choose “Use existing sync file”, then tap ☰ (top left) in the picker. Enter the same master password as on your computer.'
              : 'Put the file in any folder your computers already sync — Dropbox, OneDrive, iCloud Drive, Syncthing, Proton Drive or a NAS share. No server or account is needed. Everything in it is encrypted with your master password (scrypt + AES-256-GCM).'}
          </p>
          <div className="row gap wrap">
            {api.fileSync.smb && (
              <button className="btn primary" onClick={() => (setError(''), setNas(true))}>
                <HardDrive size={14} /> On a NAS (SMB)…
              </button>
            )}
            <button className={api.fileSync.smb ? 'btn' : 'btn primary'} onClick={() => void choose('create')}>
              <FilePlus2 size={14} /> Create sync file…
            </button>
            <button className="btn" onClick={() => void choose('open')}>
              <FolderOpen size={14} /> Use existing sync file…
            </button>
          </div>
        </>
      )
    }
    const create = setup.mode === 'create'
    return (
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          const m = mismatch(create)
          if (m) return setError(m)
          void run(() => api.fileSync.enable({ path: setup.path, password, includeSecrets, rememberPassword: remember, create }))
        }}
      >
        <div className="field">
          <span>{create ? 'New sync file' : 'Sync file'}</span>
          <code className="path-line">{api.fileSync.describePath?.(setup.path) ?? setup.path}</code>
        </div>
        {passwordForm(create)}
        {create && <p className="muted small">If the file already exists there, it is opened with this password instead of being replaced.</p>}
        <label className="check">
          <input type="checkbox" checked={includeSecrets} onChange={(e) => setIncludeSecrets(e.target.checked)} />
          Include passwords and keys saved on this device
        </label>
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember the master password on this device (OS keychain)
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="row gap">
          <button type="button" className="btn" onClick={() => setSetup(null)}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy && <LoaderCircle size={14} className="spin" />} {create ? 'Create & sync' : 'Open & sync'}
          </button>
        </div>
      </form>
    )
  }

  // ----- enabled -----
  return (
    <>
      <div className="field">
        <span>Sync file</span>
        <code className="path-line">{status.pathLabel || api.fileSync.describePath?.(status.path) || status.path}</code>
      </div>

      <div className="status-line">
        {status.locked ? (
          <>
            <Lock size={15} className="warn-text" /> Locked — enter the master password to sync on this device.
          </>
        ) : status.syncing ? (
          <>
            <LoaderCircle size={15} className="spin" /> Syncing…
          </>
        ) : status.lastError ? (
          <>
            <CircleX size={15} className="err-text" /> <span className="err-text">{status.lastError}</span>
          </>
        ) : status.lastSyncAt ? (
          <>
            <CircleCheck size={15} className="ok-text" /> Last synced {new Date(status.lastSyncAt).toLocaleString()}
          </>
        ) : null}
      </div>

      {status.locked ? (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault()
            void run(() => api.fileSync.unlock(password, remember))
          }}
        >
          {passwordForm(false)}
          <label className="check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Remember on this device
          </label>
          {error && <div className="form-error">{error}</div>}
          <div className="row gap">
            <button type="submit" className="btn primary" disabled={busy || !password}>
              {busy && <LoaderCircle size={14} className="spin" />} Unlock
            </button>
          </div>
        </form>
      ) : changing ? (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault()
            const m = mismatch(true)
            if (m) return setError(m)
            void run(() => api.fileSync.changePassword(password), 'Master password changed. Other devices will ask for the new one.')
          }}
        >
          {passwordForm(true)}
          {error && <div className="form-error">{error}</div>}
          <div className="row gap">
            <button type="button" className="btn" onClick={() => (setChanging(false), reset())}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={busy}>
              Change password
            </button>
          </div>
        </form>
      ) : (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={status.includeSecrets}
              onChange={(e) => void api.fileSync.setIncludeSecrets(e.target.checked).catch((err) => toast('error', errorText(err)))}
            />
            Include passwords and keys saved on this device
          </label>
          {api.platform !== 'android' && (
            <label className="check" title="Phones have no Proton Pass CLI, so they cannot fetch these themselves">
              <input
                type="checkbox"
                checked={status.sharePassSecrets}
                onChange={(e) => void run(() => api.fileSync.setSharePassSecrets(e.target.checked))}
              />
              <span>
                Share Proton Pass keys and passwords with my phones
                <span className="muted small"> — copies the ones your hosts use into this encrypted file (switch off to remove them)</span>
              </span>
            </label>
          )}
          <div className="row gap wrap">
            <button className="btn" disabled={status.syncing} onClick={() => void run(() => api.fileSync.syncNow())}>
              <RefreshCw size={14} className={status.syncing ? 'spin' : ''} /> Sync now
            </button>
            <button className="btn" onClick={() => (reset(), setChanging(true))}>
              Change master password
            </button>
            <button className="btn" onClick={() => void run(() => api.fileSync.disable(), 'Sync turned off. The file itself was left in place.')}>
              Turn off
            </button>
          </div>
          {error && <div className="form-error">{error}</div>}
        </>
      )}
    </>
  )
}
