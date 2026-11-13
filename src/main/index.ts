import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, safeStorage, shell, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  Host,
  HostInput,
  ImportResult,
  PromptResponse,
  SecretBackendInfo,
  SecretKind,
  SessionEvent,
  Settings,
  TransferInfo
} from '../shared/types'
import { HostStore, sanitizeHost } from './store/hosts'
import { SecretStore, type Cipher } from './store/secrets'
import { SettingsStore } from './store/settings'
import { KnownHostsStore } from './store/knownHosts'
import { ProtonPass, defaultAgentSocket } from './protonpass'
import { SshSession, expandHome, type PromptInput } from './ssh/session'
import { remoteList, remoteMkdir, remoteRealpath, remoteRemove, remoteRename } from './ssh/sftp'
import { TransferManager } from './transfers'
import { localList, localMkdir, localRename, localRoots } from './localfs'
import { hostsFromSshConfig, parseSshConfig } from './sshconfig'
import { syncHosts } from './sync'
import { FileSync } from './fileSync'

// ---------------------------------------------------------------------------
// Bootstrapping
// ---------------------------------------------------------------------------

if (process.env.SSHBUDDY_DATA_DIR) app.setPath('userData', process.env.SSHBUDDY_DATA_DIR)

const isPrimaryInstance = app.requestSingleInstanceLock()
if (!isPrimaryInstance) app.quit()

let win: BrowserWindow | null = null

let cipherInfo: Promise<SecretBackendInfo> | undefined
const cipher: Cipher = {
  info() {
    if (!app.isReady()) return Promise.resolve({ available: false, backend: 'none', reason: 'app not ready' })
    cipherInfo ??= (async (): Promise<SecretBackendInfo> => {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) {
        return { available: false, backend: 'none', reason: 'OS keychain is not available' }
      }
      if (process.platform === 'linux') {
        const b = safeStorage.getSelectedStorageBackend()
        if (b === 'basic_text' || b === 'unknown') {
          return { available: false, backend: b, reason: 'no system keyring found (install GNOME Keyring or KWallet)' }
        }
        return { available: true, backend: b }
      }
      return { available: true, backend: process.platform === 'darwin' ? 'macOS Keychain' : 'Windows DPAPI' }
    })()
    return cipherInfo
  },
  encrypt: (s) => safeStorage.encryptStringAsync(s),
  decrypt: async (b) => (await safeStorage.decryptStringAsync(b)).result
}

const dataDir = app.getPath('userData')
const hosts = new HostStore(dataDir)
const secrets = new SecretStore(dataDir, cipher)
const settings = new SettingsStore(dataDir)
const knownHosts = new KnownHostsStore(dataDir, [join(homedir(), '.ssh', 'known_hosts'), join(homedir(), '.ssh', 'known_hosts2')])
const protonPass = new ProtonPass(() => settings.get().protonPassCli)
const sessions = new Map<string, SshSession>()

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

// ---------------------------------------------------------------------------
// Prompts: the main process asks, the renderer shows a dialog and answers.
// ---------------------------------------------------------------------------

const pendingPrompts = new Map<string, { resolve: (r: PromptResponse) => void; sessionId?: string }>()

function askRenderer(req: PromptInput): Promise<PromptResponse> {
  if (!win || win.isDestroyed()) return Promise.resolve({ ok: false })
  const id = randomUUID()
  return new Promise((resolve) => {
    pendingPrompts.set(id, { resolve, sessionId: req.sessionId })
    send('prompt:request', { ...req, id })
  })
}

function cancelPrompts(sessionId: string): void {
  for (const [id, p] of pendingPrompts) {
    if (p.sessionId === sessionId) {
      pendingPrompts.delete(id)
      p.resolve({ ok: false })
      send('prompt:cancel', id)
    }
  }
}

// ---------------------------------------------------------------------------
// Sessions & transfers
// ---------------------------------------------------------------------------

const transfers = new TransferManager(
  (id) => sessions.get(id),
  (t: TransferInfo) => send('transfer:update', t)
)

function emitSession(ev: SessionEvent): void {
  send('ssh:event', ev)
  if (ev.type === 'closed') {
    sessions.delete(ev.sessionId)
    transfers.cancelSession(ev.sessionId)
    cancelPrompts(ev.sessionId)
  }
}

async function agentSocketFor(host: Host): Promise<string | undefined> {
  const a = host.auth
  if (a.agent === 'custom') return a.agentSocket ? expandHome(a.agentSocket) : undefined
  if (a.agent === 'protonpass') {
    const sock = settings.get().protonPassAgentSocket || defaultAgentSocket()
    if (process.platform !== 'win32' && !existsSync(sock)) {
      await protonPass.agentStart(sock)
    }
    return sock
  }
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK
  if (process.platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent'
  return undefined
}

async function rememberSecret(host: Host, kind: SecretKind, value: string): Promise<void> {
  await secrets.set(host.id, kind, value)
  const current = hosts.get(host.id)
  if (!current) return
  if (kind === 'password') current.auth.password = { source: 'local' }
  if (kind === 'passphrase') current.auth.passphrase = { source: 'local' }
  await hosts.save(current)
}

function session(id: string): SshSession {
  const s = sessions.get(id)
  if (!s) throw new Error('This session is no longer connected')
  return s
}

// ---------------------------------------------------------------------------
// Proton Pass host sync (debounced after local edits)
// ---------------------------------------------------------------------------

let syncing = false
let syncTimer: NodeJS.Timeout | undefined

async function runSync() {
  if (syncing) return { ok: false, message: 'Sync already in progress', pulled: 0, pushed: 0, at: Date.now() }
  syncing = true
  try {
    const res = await syncHosts(protonPass, hosts, settings)
    send('settings:changed', settings.get())
    return res
  } finally {
    syncing = false
  }
}

const fileSync = new FileSync({ hosts, secrets, settings, onStatus: (s) => send('fileSync:status', s) })
secrets.onChange(() => {
  if (!fileSync.applying) fileSync.scheduleSync()
})

hosts.onChange((list) => {
  send('hosts:changed', list)
  if (!fileSync.applying) fileSync.scheduleSync()
  if (syncing || !settings.get().sync.enabled) return
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => void runSync(), 3000)
})

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function isTrustedSender(e: IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  const url = e.senderFrame?.url ?? ''
  const dev = process.env.ELECTRON_RENDERER_URL
  return url.startsWith('file://') || (!!dev && url.startsWith(dev))
}

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!isTrustedSender(e)) throw new Error('Untrusted sender')
    return fn(...(args as A))
  })
}

function str(v: unknown): string {
  if (typeof v !== 'string') throw new Error('Invalid argument')
  return v
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Error('Invalid argument')
  return v
}

function registerIpc(): void {
  // ----- hosts -----
  handle('hosts:list', () => hosts.list())
  handle('hosts:save', (h: HostInput) => hosts.save(h))
  handle('hosts:remove', async (id: string) => {
    await hosts.remove(str(id))
    await secrets.removeHost(id)
  })
  handle('hosts:duplicate', async (id: string) => {
    const h = hosts.get(str(id))
    if (!h) throw new Error('Host not found')
    const { id: _old, createdAt: _c, updatedAt: _u, ...rest } = h
    const copy = await hosts.save({ ...rest, label: `${h.label} (copy)` })
    await secrets.copyHost(h.id, copy.id)
    return copy
  })
  handle('hosts:importSshConfig', async (): Promise<ImportResult> => {
    const file = join(homedir(), '.ssh', 'config')
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      throw new Error(`No SSH config found at ${file}`)
    }
    const defaultKey = ['id_ed25519', 'id_ecdsa', 'id_rsa'].map((k) => join(homedir(), '.ssh', k)).find((p) => existsSync(p))
    const found = hostsFromSshConfig(parseSshConfig(text), {
      hasAgent: !!process.env.SSH_AUTH_SOCK,
      defaultKey: defaultKey?.replace(homedir(), '~')
    })
    const existing = hosts.list()
    let added = 0
    let skipped = 0
    const idByAlias = new Map(existing.map((e) => [e.label, e.id]))
    const pendingJumps: { id: string; alias: string }[] = []
    for (const { jumpAlias, ...h } of found) {
      const dup = existing.find((e) => e.hostname === h.hostname && e.port === h.port && e.username === h.username)
      if (dup) {
        idByAlias.set(h.label, dup.id)
        skipped++
        continue
      }
      const saved = await hosts.save(h)
      idByAlias.set(saved.label, saved.id)
      if (jumpAlias) pendingJumps.push({ id: saved.id, alias: jumpAlias })
      added++
    }
    // second pass: ProxyJump aliases become references to the saved jump host
    for (const { id, alias } of pendingJumps) {
      const jumpId = idByAlias.get(alias)
      const h = hosts.get(id)
      if (!h) continue
      if (jumpId && jumpId !== id) await hosts.save({ ...h, jumpHostId: jumpId })
      else await hosts.save({ ...h, notes: [h.notes, `ProxyJump ${alias} (no host with that name was found)`].filter(Boolean).join('\n') })
    }
    return { added, skipped }
  })
  handle('hosts:exportJson', async () => {
    if (!win) return false
    const res = await dialog.showSaveDialog(win, {
      title: 'Export hosts',
      defaultPath: join(app.getPath('documents'), 'sshbuddy-hosts.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return false
    await fs.writeFile(res.filePath, JSON.stringify({ app: 'SSHBuddy', version: 1, hosts: hosts.list() }, null, 2), { mode: 0o600 })
    return true
  })
  handle('hosts:importJson', async (): Promise<ImportResult> => {
    if (!win) return { added: 0, skipped: 0 }
    const res = await dialog.showOpenDialog(win, { title: 'Import hosts', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] })
    if (res.canceled || !res.filePaths[0]) return { added: 0, skipped: 0 }
    const raw = JSON.parse(await fs.readFile(res.filePaths[0], 'utf8')) as { hosts?: unknown[] }
    const existingIds = new Set(hosts.list().map((h) => h.id))
    let added = 0
    let skipped = 0
    for (const h of raw.hosts ?? []) {
      try {
        const clean = sanitizeHost(h as Host)
        if (existingIds.has(clean.id)) {
          skipped++
          continue
        }
        await hosts.save(clean)
        added++
      } catch {
        skipped++
      }
    }
    return { added, skipped }
  })

  // ----- secrets (write-only from the renderer's point of view) -----
  handle('secrets:backend', () => secrets.backend())
  handle('secrets:set', (hostId: string, kind: SecretKind, value: string) => {
    if (!['password', 'key', 'passphrase'].includes(kind)) throw new Error('Invalid secret kind')
    return secrets.set(str(hostId), kind, str(value))
  })
  handle('secrets:has', (hostId: string) => secrets.has(str(hostId)))
  handle('secrets:remove', (hostId: string, kind: SecretKind) => secrets.remove(str(hostId), kind))

  // ----- settings -----
  handle('settings:get', () => settings.get())
  handle('settings:update', async (patch: Partial<Settings>) => {
    const before = settings.get().sync
    const next = await settings.update(patch)
    if (next.sync.enabled && (!before.enabled || before.shareId !== next.sync.shareId)) void runSync()
    return next
  })

  // ----- known hosts -----
  handle('knownHosts:list', () => knownHosts.list())
  handle('knownHosts:remove', (hostKey: string) => knownHosts.remove(str(hostKey)))

  // ----- Proton Pass -----
  handle('pp:status', () => protonPass.status())
  handle('pp:vaults', () => protonPass.vaults())
  handle('pp:items', (shareId: string, type?: 'login' | 'ssh-key') => protonPass.items(str(shareId), type))
  const agentSock = (): string => settings.get().protonPassAgentSocket || defaultAgentSocket()
  handle('pp:agentStatus', () => protonPass.agentStatus(agentSock()))
  handle('pp:agentStart', (shareId?: string) => protonPass.agentStart(agentSock(), shareId || undefined))
  handle('pp:agentStop', () => protonPass.agentStop(agentSock()))
  handle('pp:sync', () => runSync())

  // ----- encrypted sync file -----
  handle('fileSync:status', () => fileSync.status())
  handle('fileSync:choosePath', async (mode: 'create' | 'open') => {
    if (!win) return null
    if (mode === 'create') {
      const res = await dialog.showSaveDialog(win, {
        title: 'Create sync file — pick a folder your devices sync (Dropbox, Syncthing, NAS…)',
        defaultPath: join(app.getPath('documents'), 'sshbuddy-sync.json'),
        filters: [{ name: 'SSHBuddy sync file', extensions: ['json'] }]
      })
      return res.canceled ? null : (res.filePath ?? null)
    }
    const res = await dialog.showOpenDialog(win, {
      title: 'Open an existing SSHBuddy sync file',
      filters: [{ name: 'SSHBuddy sync file', extensions: ['json'] }],
      properties: ['openFile']
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  handle('fileSync:enable', (opts: { path: string; password: string; includeSecrets: boolean; rememberPassword: boolean; create: boolean }) =>
    fileSync.enable({
      path: str(opts?.path),
      password: str(opts?.password),
      includeSecrets: Boolean(opts.includeSecrets),
      rememberPassword: Boolean(opts.rememberPassword),
      create: Boolean(opts.create)
    })
  )
  handle('fileSync:unlock', (password: string, remember: boolean) => fileSync.unlock(str(password), Boolean(remember)))
  handle('fileSync:disable', () => fileSync.disable())
  handle('fileSync:syncNow', () => fileSync.sync())
  handle('fileSync:changePassword', (pw: string) => fileSync.changePassword(str(pw)))
  handle('fileSync:setIncludeSecrets', (v: boolean) => fileSync.setIncludeSecrets(Boolean(v)))

  // ----- SSH -----
  handle('ssh:open', (hostId: string, cols: number, rows: number) => {
    const host = hosts.get(str(hostId))
    if (!host) throw new Error('Host not found')
    const id = randomUUID()
    const s = new SshSession(id, host, {
      settings: () => settings.get(),
      secrets,
      protonPass,
      knownHosts,
      prompt: askRenderer,
      remember: rememberSecret,
      agentSocket: agentSocketFor,
      getHost: (hid) => hosts.get(hid),
      saveUsername: async (h, username) => {
        const current = hosts.get(h.id)
        if (current && !current.username) await hosts.save({ ...current, username })
      },
      emit: emitSession
    })
    sessions.set(id, s)
    void s.start(Math.max(10, Number(cols) || 80), Math.max(5, Number(rows) || 24))
    return id
  })
  ipcMain.on('ssh:write', (e, id: string, data: string) => {
    if (isTrustedSender(e) && typeof data === 'string') sessions.get(id)?.write(data)
  })
  ipcMain.on('ssh:resize', (e, id: string, cols: number, rows: number) => {
    if (isTrustedSender(e)) sessions.get(id)?.resize(Number(cols), Number(rows))
  })
  handle('ssh:close', (id: string) => {
    sessions.get(str(id))?.close('Disconnected')
  })

  // ----- prompts -----
  ipcMain.on('prompt:respond', (e, id: string, res: PromptResponse) => {
    if (!isTrustedSender(e)) return
    const p = pendingPrompts.get(id)
    if (!p) return
    pendingPrompts.delete(id)
    p.resolve({
      ok: Boolean(res?.ok),
      values: Array.isArray(res?.values) ? res.values.map(String) : undefined,
      remember: Boolean(res?.remember)
    })
  })

  // ----- SFTP -----
  handle('sftp:home', async (id: string) => remoteRealpath(await session(str(id)).sftp(), '.'))
  handle('sftp:list', async (id: string, path: string) => remoteList(await session(str(id)).sftp(), str(path)))
  handle('sftp:mkdir', async (id: string, path: string) => remoteMkdir(await session(str(id)).sftp(), str(path)))
  handle('sftp:rename', async (id: string, from: string, to: string) => remoteRename(await session(str(id)).sftp(), str(from), str(to)))
  handle('sftp:remove', async (id: string, paths: string[]) => {
    const sftp = await session(str(id)).sftp()
    for (const p of strArray(paths)) await remoteRemove(sftp, p)
  })
  handle('sftp:download', (id: string, remotePaths: string[], localDir: string) => {
    session(str(id))
    return transfers.enqueue(id, 'download', strArray(remotePaths), str(localDir))
  })
  handle('sftp:upload', (id: string, localPaths: string[], remoteDir: string) => {
    session(str(id))
    return transfers.enqueue(id, 'upload', strArray(localPaths), str(remoteDir))
  })
  handle('sftp:cancelTransfer', (tid: string) => transfers.cancel(str(tid)))
  handle('sftp:clearTransfers', (id: string) => transfers.clear(str(id)))

  // ----- local files -----
  handle('local:roots', () => localRoots(app.getPath('downloads')))
  handle('local:list', (path: string) => localList(str(path)))
  handle('local:mkdir', (path: string) => localMkdir(str(path)))
  handle('local:rename', (from: string, to: string) => localRename(str(from), str(to)))
  handle('local:trash', async (paths: string[]) => {
    for (const p of strArray(paths)) await shell.trashItem(p)
  })
  handle('local:open', async (path: string) => {
    const err = await shell.openPath(str(path))
    if (err) throw new Error(err)
  })
  handle('local:join', (dir: string, name: string) => join(str(dir), str(name)))

  // ----- misc -----
  handle('dialog:pickKeyFile', async () => {
    if (!win) return null
    const sshDir = join(homedir(), '.ssh')
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose a private key',
      defaultPath: existsSync(sshDir) ? sshDir : homedir(),
      properties: ['openFile', 'showHiddenFiles']
    })
    if (res.canceled || !res.filePaths[0]) return null
    return res.filePaths[0].startsWith(homedir()) ? '~' + res.filePaths[0].slice(homedir().length) : res.filePaths[0]
  })
  handle('clipboard:read', () => clipboard.readText())
  handle('clipboard:write', (text: string) => clipboard.writeText(str(text)))
  handle('shell:openExternal', async (url: string) => {
    if (/^https?:\/\//i.test(str(url))) await shell.openExternal(url)
  })
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 920,
    minHeight: 560,
    show: false,
    title: 'SSHBuddy',
    backgroundColor: '#0f1218',
    autoHideMenuBar: true,
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const dev = process.env.ELECTRON_RENDERER_URL
    if (!(dev && url.startsWith(dev))) e.preventDefault()
  })
  win.on('closed', () => {
    win = null
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.whenReady().then(() => {
  if (!isPrimaryInstance) return
  registerIpc()
  buildMenu()
  createWindow()
  if (settings.get().sync.enabled) setTimeout(() => void runSync(), 1500)
  void fileSync.init()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  fileSync.dispose()
  for (const s of sessions.values()) s.close('Application closed')
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
