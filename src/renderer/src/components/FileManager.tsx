import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DirListing } from '../../../shared/types'
import { api } from '../api'
import { useStore } from '../store'
import { errorText } from '../format'
import { FilePane, type FileSource } from './FilePane'
import { TransfersList } from './TransfersList'
import { ConfirmDialog } from './Modal'

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p
const posixJoin = (dir: string, name: string): string => (dir.endsWith('/') ? dir + name : `${dir}/${name}`)

export function FileManager({ sessionId, connected }: { sessionId: string; connected: boolean }) {
  const toast = useStore((s) => s.toast)
  const transfers = useStore((s) => s.transfers)
  const [localKey, setLocalKey] = useState(0)
  const [remoteKey, setRemoteKey] = useState(0)
  const local = useRef<DirListing | null>(null)
  const remote = useRef<DirListing | null>(null)
  const [confirm, setConfirm] = useState<null | { names: string[]; run: () => void }>(null)

  const onError = useCallback((msg: string) => toast('error', msg), [toast])

  const startTransfer = useCallback(
    (direction: 'upload' | 'download', paths: string[]) => {
      const target = direction === 'upload' ? remote.current : local.current
      if (!target) return
      const existing = new Set(target.entries.map((e) => e.name))
      const clashes = paths.map(baseName).filter((n) => existing.has(n))
      const run = (): void => {
        const p =
          direction === 'upload'
            ? api.sftp.upload(sessionId, paths, target.path)
            : api.sftp.download(sessionId, paths, target.path)
        p.catch((e) => toast('error', errorText(e)))
      }
      if (clashes.length) setConfirm({ names: clashes, run })
      else run()
    },
    [sessionId, toast]
  )

  const localSource = useMemo<FileSource>(
    () => ({
      kind: 'local',
      title: 'This computer',
      home: async () => (await api.local.roots()).home,
      list: (p) => api.local.list(p),
      mkdir: (p) => api.local.mkdir(p),
      rename: (a, b) => api.local.rename(a, b),
      remove: (paths) => api.local.trash(paths),
      join: (d, n) => api.local.join(d, n),
      open: (e) => void api.local.open(e.path).catch((err) => toast('error', errorText(err)))
    }),
    [toast]
  )

  const remoteSource = useMemo<FileSource>(
    () => ({
      kind: 'remote',
      title: 'Remote',
      home: () => api.sftp.home(sessionId),
      list: (p) => api.sftp.list(sessionId, p),
      mkdir: (p) => api.sftp.mkdir(sessionId, p),
      rename: (a, b) => api.sftp.rename(sessionId, a, b),
      remove: (paths) => api.sftp.remove(sessionId, paths),
      join: posixJoin,
      open: (e) => startTransfer('download', [e.path])
    }),
    [sessionId, startTransfer]
  )

  // Refresh the destination pane when a transfer into it finishes.
  const seen = useRef(new Set<string>())
  useEffect(() => {
    for (const t of Object.values(transfers)) {
      if (t.sessionId !== sessionId || seen.current.has(t.id)) continue
      if (t.state === 'done' || t.state === 'error' || t.state === 'cancelled') {
        seen.current.add(t.id)
        if (t.state === 'error') toast('error', `${t.name}: ${t.error}`)
        if (t.direction === 'download' && local.current?.path === t.destination) setLocalKey((k) => k + 1)
        if (t.direction === 'upload' && remote.current?.path === t.destination) setRemoteKey((k) => k + 1)
      }
    }
  }, [transfers, sessionId, toast])

  const onLocalListing = useCallback((l: DirListing) => {
    local.current = l
  }, [])
  const onRemoteListing = useCallback((l: DirListing) => {
    remote.current = l
  }, [])

  return (
    <div className="file-manager">
      <div className="fm-panes">
        <FilePane
          source={localSource}
          refreshKey={localKey}
          onListing={onLocalListing}
          onTransfer={(paths) => startTransfer('upload', paths)}
          onDropFromPane={(paths) => startTransfer('download', paths)}
          transferLabel="Upload"
          onError={onError}
        />
        <FilePane
          source={remoteSource}
          refreshKey={remoteKey}
          disabled={!connected}
          onListing={onRemoteListing}
          onTransfer={(paths) => startTransfer('download', paths)}
          onDropFromPane={(paths) => startTransfer('upload', paths)}
          onDropFromOs={(paths) => startTransfer('upload', paths)}
          transferLabel="Download"
          onError={onError}
        />
      </div>
      <TransfersList sessionId={sessionId} />
      {confirm && (
        <ConfirmDialog
          title="Replace existing files?"
          confirmLabel="Replace"
          danger
          message={
            <>
              {confirm.names.length === 1 ? (
                <>
                  <b>{confirm.names[0]}</b> already exists
                </>
              ) : (
                <>
                  {confirm.names.length} items already exist ({confirm.names.slice(0, 3).join(', ')}
                  {confirm.names.length > 3 ? ', …' : ''})
                </>
              )}{' '}
              in the destination. Files with the same name will be overwritten.
            </>
          }
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            confirm.run()
            setConfirm(null)
          }}
        />
      )}
    </div>
  )
}
