import { createHash } from 'node:crypto'
import { promises as fs, watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { FileSyncStatus, SyncResult } from '../shared/types'
import type { HostStore } from './store/hosts'
import type { SecretStore } from './store/secrets'
import type { SettingsStore } from './store/settings'
import { writeText } from './store/jsonFile'
import type { SnippetStore } from './store/snippets'
import { syncVault, type VaultStores } from '../shared/vaultSync'
import { WrongPasswordError, decryptVault, deriveKey, encryptVault, newKdf, parseEnvelope, type KdfParams } from './vaultFile'

/**
 * Serverless sync: every device reads and writes one encrypted JSON file that lives in a folder
 * the user already syncs (Dropbox, OneDrive, iCloud, Syncthing, Proton Drive, a NAS share…).
 * Devices merge per host (newest edit wins, deletions propagate); saved secrets travel with the
 * host version that wins. Each device keeps its own copy, so it works offline and converges later.
 */

/** Pseudo host id under which the master password is remembered in the OS-keychain store. */
export const MASTER_PASSWORD_ID = '__sync_file__'
const POLL_MS = 30_000

export interface FileSyncDeps {
  hosts: HostStore
  secrets: SecretStore
  settings: SettingsStore
  snippets?: SnippetStore
  /** Proton Pass copies for phones (desktop, when the user opted in) */
  passSecrets?: () => VaultStores['passSecrets']
  onStatus(s: FileSyncStatus): void
  /** scrypt cost for newly created files (tests use a cheaper value) */
  kdfN?: number
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

export class FileSync {
  private password?: string
  private keyCache?: { salt: string; key: Buffer }
  private rekey?: { kdf: KdfParams; key: Buffer; password: string }
  private running?: Promise<SyncResult>
  private watcher?: FSWatcher
  private pollTimer?: NodeJS.Timeout
  private debounce?: NodeJS.Timeout
  /** hash of the file content we last read or wrote (to ignore our own writes) */
  private lastSeen = ''
  /** true while remote changes are being written into the local stores */
  applying = false

  constructor(private deps: FileSyncDeps) {}

  status(): FileSyncStatus {
    const s = this.deps.settings.get().fileSync
    return { ...s, locked: s.enabled && !this.password, syncing: !!this.running }
  }

  private emit(): void {
    this.deps.onStatus(this.status())
  }

  /** Called at app start. */
  async init(): Promise<void> {
    const s = this.deps.settings.get().fileSync
    if (!s.enabled) return
    if (s.rememberPassword) this.password = await this.deps.secrets.get(MASTER_PASSWORD_ID, 'password')
    this.startWatching()
    this.emit()
    if (this.password) await this.sync()
  }

  async enable(opts: { path: string; password: string; includeSecrets: boolean; rememberPassword: boolean; create: boolean }): Promise<SyncResult> {
    if (!opts.path) throw new Error('Choose where to keep the sync file')
    if (opts.password.length < 8) throw new Error('Use a master password of at least 8 characters')
    const exists = await fs
      .access(opts.path)
      .then(() => true)
      .catch(() => false)
    if (!exists && !opts.create) throw new Error(`No sync file at ${opts.path}`)
    if (exists) {
      // never overwrite an existing file: it must open with this password and is then merged
      const env = parseEnvelope(await fs.readFile(opts.path, 'utf8'))
      const key = await deriveKey(opts.password, env.kdf)
      decryptVault(env, key)
      this.keyCache = { salt: env.kdf.salt, key }
    } else {
      this.keyCache = undefined
    }
    this.password = opts.password
    const remember = opts.rememberPassword && (await this.deps.secrets.backend()).available
    await this.deps.settings.update({
      fileSync: { ...this.deps.settings.get().fileSync, enabled: true, path: opts.path, includeSecrets: opts.includeSecrets, rememberPassword: remember, lastError: '' }
    })
    await this.rememberPassword(remember)
    this.startWatching()
    return this.sync()
  }

  async unlock(password: string, remember: boolean): Promise<SyncResult> {
    const s = this.deps.settings.get().fileSync
    if (!s.enabled) throw new Error('Sync file is not enabled')
    this.password = password
    this.keyCache = undefined
    const res = await this.sync()
    if (!res.ok && !this.password) throw new Error(res.message) // wrong password: still locked
    const canRemember = remember && (await this.deps.secrets.backend()).available
    await this.deps.settings.update({ fileSync: { ...this.deps.settings.get().fileSync, rememberPassword: canRemember } })
    await this.rememberPassword(canRemember)
    this.emit()
    return res
  }

  async disable(): Promise<void> {
    this.stopWatching()
    this.password = undefined
    this.keyCache = undefined
    await this.deps.secrets.remove(MASTER_PASSWORD_ID, 'password').catch(() => undefined)
    await this.deps.settings.update({ fileSync: { ...this.deps.settings.get().fileSync, enabled: false, lastError: '' } })
    this.emit()
  }

  async changePassword(newPassword: string): Promise<SyncResult> {
    if (!this.password) throw new Error('Unlock the sync file first')
    if (newPassword.length < 8) throw new Error('Use a master password of at least 8 characters')
    const kdf = newKdf(this.deps.kdfN)
    this.rekey = { kdf, key: await deriveKey(newPassword, kdf), password: newPassword }
    const res = await this.sync()
    if (res.ok) await this.rememberPassword(this.deps.settings.get().fileSync.rememberPassword)
    return res
  }

  /** When switched off, the next sync removes every Proton Pass copy from the file. */
  private stripPassSecrets = false

  async setSharePassSecrets(share: boolean): Promise<SyncResult> {
    await this.deps.settings.update({ fileSync: { ...this.deps.settings.get().fileSync, sharePassSecrets: share } })
    if (!share) this.stripPassSecrets = true
    return this.sync()
  }

  async setIncludeSecrets(include: boolean): Promise<SyncResult> {
    await this.deps.settings.update({ fileSync: { ...this.deps.settings.get().fileSync, includeSecrets: include } })
    return this.sync()
  }

  /** Debounced sync after a local change. */
  scheduleSync(delayMs = 2000): void {
    const s = this.deps.settings.get().fileSync
    if (!s.enabled || !this.password || this.applying) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => void this.sync(), delayMs)
  }

  sync(): Promise<SyncResult> {
    if (this.running) return this.running.then(() => this.sync())
    this.running = this.doSync().finally(() => {
      this.running = undefined
      this.emit()
    })
    this.emit()
    return this.running
  }

  dispose(): void {
    this.stopWatching()
    if (this.debounce) clearTimeout(this.debounce)
  }

  // ---------------------------------------------------------------------------

  private async rememberPassword(remember: boolean): Promise<void> {
    if (remember && this.password) await this.deps.secrets.set(MASTER_PASSWORD_ID, 'password', this.password).catch(() => undefined)
    else await this.deps.secrets.remove(MASTER_PASSWORD_ID, 'password').catch(() => undefined)
  }

  private async keyFor(kdf: KdfParams): Promise<Buffer> {
    if (this.keyCache?.salt === kdf.salt) return this.keyCache.key
    const key = await deriveKey(this.password!, kdf)
    this.keyCache = { salt: kdf.salt, key }
    return key
  }

  private async doSync(): Promise<SyncResult> {
    const s = this.deps.settings.get().fileSync
    const at = Date.now()
    if (!s.enabled) return { ok: false, message: 'Sync file is not enabled', pulled: 0, pushed: 0, at }
    if (!this.password) return { ok: false, message: 'Sync file is locked — enter the master password', pulled: 0, pushed: 0, at }
    try {
      let text: string | undefined
      try {
        text = await fs.readFile(s.path, 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
      const rekey = this.rekey
      this.applying = true
      let res
      try {
        res = await syncVault<Buffer>({
          text,
          includeSecrets: s.includeSecrets,
          rekey: rekey && { kdf: rekey.kdf, key: rekey.key },
          now: at,
          codec: {
            newKdf: () => newKdf(this.deps.kdfN),
            keyFor: (kdf) => this.keyFor(kdf),
            encrypt: async (payload, key, kdf) => encryptVault(payload, key, kdf),
            decrypt: async (env, key) => decryptVault(env, key)
          },
          stores: {
            hosts: this.deps.hosts,
            snippets: this.deps.snippets,
            secrets: {
              getAll: (id) => this.deps.secrets.getAll(id),
              set: (id, kind, value) => this.deps.secrets.set(id, kind, value),
              remove: (id, kind) => this.deps.secrets.remove(id, kind),
              removeHost: (id) => this.deps.secrets.removeHost(id),
              available: async () => (await this.deps.secrets.backend()).available
            },
            passSecrets: s.sharePassSecrets
              ? this.deps.passSecrets?.()
              : this.stripPassSecrets
                ? { collect: async () => null }
                : undefined
          }
        })
      } finally {
        this.applying = false
      }
      if (res.write !== undefined) await writeText(s.path, res.write)
      this.stripPassSecrets = false
      this.lastSeen = sha(res.text)
      if (rekey) {
        this.password = rekey.password
        this.keyCache = { salt: rekey.kdf.salt, key: rekey.key }
      }
      this.rekey = undefined

      await this.deps.settings.update({ fileSync: { ...this.deps.settings.get().fileSync, lastSyncAt: at, lastError: '' } })
      return { ok: true, message: `Synced ${res.hostCount} host${res.hostCount === 1 ? '' : 's'}`, pulled: res.pulled, pushed: res.pushed, at }
    } catch (e) {
      this.rekey = undefined
      if (e instanceof WrongPasswordError) {
        // another device may have changed the master password: lock until it is entered again
        this.password = undefined
        this.keyCache = undefined
      }
      const message = (e as Error).message
      await this.deps.settings.update({ fileSync: { ...this.deps.settings.get().fileSync, lastError: message } })
      return { ok: false, message, pulled: 0, pushed: 0, at }
    }
  }

  // ----- noticing changes written by other devices -----

  private startWatching(): void {
    this.stopWatching()
    const path = this.deps.settings.get().fileSync.path
    if (!path) return
    const base = basename(path)
    try {
      this.watcher = watch(dirname(path), (_ev, name) => {
        if (!name || name.toString() === base) this.onMaybeChanged(1500)
      })
      this.watcher.on('error', () => undefined)
    } catch {
      /* folder not watchable (e.g. some network mounts): polling below still works */
    }
    // network shares and some sync clients don't deliver watch events reliably
    this.pollTimer = setInterval(() => this.onMaybeChanged(0), POLL_MS)
  }

  private stopWatching(): void {
    this.watcher?.close()
    this.watcher = undefined
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = undefined
  }

  private onMaybeChanged(delayMs: number): void {
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(async () => {
      const s = this.deps.settings.get().fileSync
      if (!s.enabled || !this.password) return
      const text = await fs.readFile(s.path, 'utf8').catch(() => undefined)
      if (text !== undefined && sha(text) !== this.lastSeen) void this.sync()
    }, delayMs)
  }
}
