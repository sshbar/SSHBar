// window.sshbar for the Android app: the same SSHbarApi the desktop UI uses, backed by the native
// sshj bridge and app-private storage instead of Electron IPC.
import type { SSHbarApi, Unsubscribe } from '../shared/api'
import type { FileSyncStatus, PromptRequest, PromptResponse, SecretKind, SessionEvent, TransferInfo } from '../shared/types'
import { Native, b64ToBytes } from './native'
import { MobileHosts, MobileKnownHosts, MobileSettings, MobileSnippets } from './stores'
import { MobileSession, type PromptInput } from './session'
import { MobileFileSync } from './fileSync'
import { smbChoose, smbList, smbSaved } from './smb'
import { isSmbPath, parseSmbPath, smbLabel } from '../shared/smbPath'
import { checkForUpdate } from '../shared/updateCheck'

const notOnAndroid = (what: string) => (): Promise<never> => Promise.reject(new Error(`${what} is not available on Android yet`))

function listeners<T>() {
  const set = new Set<(v: T) => void>()
  return {
    on(cb: (v: T) => void): Unsubscribe {
      set.add(cb)
      return () => set.delete(cb)
    },
    emit(v: T): void {
      for (const l of set) l(v)
    }
  }
}

export async function createMobileApi(): Promise<SSHbarApi> {
  const hosts = new MobileHosts()
  const snippets = new MobileSnippets()
  const settings = new MobileSettings()
  const knownHosts = new MobileKnownHosts()
  await Promise.all([hosts.init(), snippets.init(), settings.init(), knownHosts.init()])

  const sessionEvents = listeners<SessionEvent>()
  const promptRequests = listeners<PromptRequest>()
  const promptCancels = listeners<string>()
  const transferEvents = listeners<TransferInfo>()
  const sessions = new Map<string, MobileSession>()
  const pending = new Map<string, { resolve: (r: PromptResponse) => void; sessionId?: string }>()
  const decoder = new TextDecoder()

  const secretKey = (hostId: string, kind: SecretKind): string => `${hostId}:${kind}`
  const secret = async (hostId: string, kind: SecretKind): Promise<string | undefined> =>
    (await Native.secureGet({ key: secretKey(hostId, kind) })).value ?? undefined

  const prompt = (req: PromptInput): Promise<PromptResponse> => {
    const id = crypto.randomUUID()
    return new Promise((resolve) => {
      pending.set(id, { resolve, sessionId: req.sessionId })
      promptRequests.emit({ ...req, id } as PromptRequest)
    })
  }

  const cancelPrompts = (sessionId: string): void => {
    for (const [id, p] of pending) {
      if (p.sessionId !== sessionId) continue
      pending.delete(id)
      p.resolve({ ok: false })
      promptCancels.emit(id)
    }
  }

  const emit = (ev: SessionEvent): void => {
    sessionEvents.emit(ev)
    if (ev.type === 'closed') {
      sessions.delete(ev.sessionId)
      cancelPrompts(ev.sessionId)
    }
  }

  const sessionByNative = (nativeId: string): MobileSession | undefined => {
    for (const s of sessions.values()) if (s.ownsNativeId(nativeId)) return s
    return undefined
  }

  // ----- native events -----
  void Native.addListener('data', (e) => sessions.get(e.id)?.onData(b64ToBytes(e.data)))
  void Native.addListener('closed', (e) => sessionByNative(e.id)?.onNativeClosed(e.id, e.reason))
  void Native.addListener('execData', (e) => sessions.get(e.id)?.onExecData(e.execId, decoder.decode(b64ToBytes(e.data))))
  void Native.addListener('execClosed', (e) => sessions.get(e.id)?.onExecClosed(e.execId))
  void Native.addListener('kbdPrompt', (e) => {
    const s = sessionByNative(e.id)?.sessionFor(e.id)
    const answer = s ? s.answerKeyboard(e.instruction, e.prompt, e.echo) : Promise.resolve(null)
    void answer.then((a) => Native.sshKeyboardRespond({ requestId: e.requestId, answer: a }))
  })

  const fileSyncEvents = listeners<FileSyncStatus>()
  const fileSync = new MobileFileSync({ hosts, snippets, settings, onStatus: (s) => fileSyncEvents.emit(s) })
  const picked = new Map<string, string>() // content:// uri -> display name from the picker
  hosts.changed.on(() => !fileSync.applying && fileSync.scheduleSync())
  snippets.changed.on(() => !fileSync.applying && fileSync.scheduleSync())
  void fileSync.init()

  const api: SSHbarApi = {
    platform: 'android',

    hosts: {
      list: async () => hosts.list(),
      save: (h) => hosts.save(h),
      remove: async (id) => {
        await hosts.remove(id)
        for (const k of ['password', 'key', 'passphrase'] as SecretKind[]) await Native.secureRemove({ key: secretKey(id, k) })
      },
      duplicate: async (id) => {
        const h = hosts.get(id)
        if (!h) throw new Error('Host not found')
        const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = h
        const copy = await hosts.save({ ...rest, label: `${h.label} (copy)` })
        for (const k of ['password', 'key', 'passphrase'] as SecretKind[]) {
          const v = await secret(id, k)
          if (v) await Native.secureSet({ key: secretKey(copy.id, k), value: v })
        }
        return copy
      },
      importSshConfig: notOnAndroid('Importing ~/.ssh/config'),
      exportJson: notOnAndroid('Export'),
      importJson: notOnAndroid('Import'),
      onChanged: (cb) => hosts.changed.on(cb)
    },

    snippets: {
      list: async () => snippets.list(),
      save: (s) => snippets.save(s),
      remove: (id) => snippets.remove(id),
      onChanged: (cb) => snippets.changed.on(cb)
    },

    secrets: {
      backend: async () => ({ available: true, backend: 'Android Keystore' }),
      set: async (hostId, kind, value) => {
        if (value) await Native.secureSet({ key: secretKey(hostId, kind), value })
        else await Native.secureRemove({ key: secretKey(hostId, kind) })
        fileSync.scheduleSync()
      },
      has: async (hostId) => ({
        password: !!(await secret(hostId, 'password')),
        key: !!(await secret(hostId, 'key')),
        passphrase: !!(await secret(hostId, 'passphrase'))
      }),
      remove: async (hostId, kind) => Native.secureRemove({ key: secretKey(hostId, kind) })
    },

    settings: {
      get: async () => settings.get(),
      update: (patch) => settings.update(patch),
      onChanged: (cb) => settings.changed.on(cb)
    },

    knownHosts: {
      list: async () => knownHosts.list(),
      remove: (hostKey) => knownHosts.remove(hostKey)
    },

    protonPass: {
      status: async () => ({ installed: false, loggedIn: false, error: 'The Proton Pass CLI is not available on Android' }),
      vaults: notOnAndroid('Proton Pass'),
      items: notOnAndroid('Proton Pass'),
      agentStatus: async () => ({ running: false, socketPath: '', detail: 'Not available on Android' }),
      agentStart: notOnAndroid('The Proton Pass SSH agent'),
      agentStop: notOnAndroid('The Proton Pass SSH agent'),
      sync: notOnAndroid('Proton Pass sync')
    },

    fileSync: {
      status: async () => fileSync.status(),
      choosePath: async (mode) => {
        const r = await fileSync.pick(mode)
        if (!r) return null
        picked.set(r.uri, r.name)
        return r.uri
      },
      describePath: (path) =>
        picked.get(path) ||
        (path === settings.get().fileSync.path && settings.get().fileSync.pathLabel) ||
        (isSmbPath(path) ? smbLabel(parseSmbPath(path)) : path),
      smb: {
        saved: () => smbSaved(),
        list: (login, dir) => smbList(login, dir),
        choose: async (login, filePath) => {
          const path = await smbChoose(login, filePath)
          picked.set(path, smbLabel(parseSmbPath(path)))
          return path
        }
      },
      enable: (opts) => fileSync.enable({ ...opts, label: picked.get(opts.path) ?? 'sync file' }),
      unlock: (password, remember) => fileSync.unlock(password, remember),
      disable: () => fileSync.disable(),
      syncNow: () => fileSync.sync(),
      changePassword: (pw) => fileSync.changePassword(pw),
      setIncludeSecrets: (v) => fileSync.setIncludeSecrets(v),
      setSharePassSecrets: notOnAndroid('Sharing Proton Pass secrets'),
      onStatus: (cb) => fileSyncEvents.on(cb)
    },

    ssh: {
      open: async (hostId, cols, rows) => {
        const host = hosts.get(hostId)
        if (!host) throw new Error('Host not found')
        const id = crypto.randomUUID()
        const s = new MobileSession(id, host, {
          getHost: (hid) => hosts.get(hid),
          knownHosts,
          secret,
          // saved on this phone only; the shared host settings (synced with computers) stay as they are
          remember: async (h, kind, value) => {
            await Native.secureSet({ key: secretKey(h.id, kind), value })
          },
          saveUsername: async (h, username) => {
            const cur = hosts.get(h.id)
            if (cur && !cur.username) await hosts.save({ ...cur, username })
          },
          prompt,
          emit,
          statsIntervalSec: () => settings.get().statsIntervalSec
        })
        sessions.set(id, s)
        void s.start(Math.max(10, cols || 80), Math.max(5, rows || 24))
        return id
      },
      write: (id, data) => sessions.get(id)?.write(data),
      resize: (id, cols, rows) => sessions.get(id)?.resize(cols, rows),
      close: async (id) => sessions.get(id)?.close('Disconnected'),
      listForwards: async () => [],
      startForward: notOnAndroid('Port forwarding'),
      stopForward: async () => undefined,
      onEvent: (cb) => sessionEvents.on(cb)
    },

    prompts: {
      onRequest: (cb) => promptRequests.on(cb),
      onCancel: (cb) => promptCancels.on(cb),
      respond: (id, res) => {
        const p = pending.get(id)
        if (!p) return
        pending.delete(id)
        p.resolve({ ok: Boolean(res?.ok), values: res?.values?.map(String), remember: Boolean(res?.remember) })
      }
    },

    sftp: {
      home: notOnAndroid('The file manager'),
      list: notOnAndroid('The file manager'),
      mkdir: notOnAndroid('The file manager'),
      rename: notOnAndroid('The file manager'),
      remove: notOnAndroid('The file manager'),
      download: notOnAndroid('The file manager'),
      upload: notOnAndroid('The file manager'),
      cancelTransfer: async () => undefined,
      clearTransfers: async () => undefined,
      onTransfer: (cb) => transferEvents.on(cb)
    },

    local: {
      roots: notOnAndroid('Local files'),
      list: notOnAndroid('Local files'),
      mkdir: notOnAndroid('Local files'),
      rename: notOnAndroid('Local files'),
      trash: notOnAndroid('Local files'),
      open: notOnAndroid('Local files'),
      join: async (dir, name) => `${dir.replace(/\/$/, '')}/${name}`
    },

    dialog: {
      pickKeyFile: async () => null
    },

    clipboard: {
      read: async () => (await Native.clipboardRead()).text,
      write: (text) => Native.clipboardWrite({ text })
    },

    updates: {
      check: async () => checkForUpdate((await Native.appInfo()).version, (url, init) => fetch(url, init))
    },

    pathForFile: () => '',
    openExternal: async (url) => {
      if (/^(https?:\/\/|mailto:)/i.test(url)) await Native.openUrl({ url })
    },
    appInfo: async () => ({ version: (await Native.appInfo()).version, electron: '', platform: 'android' })
  }
  return api
}
