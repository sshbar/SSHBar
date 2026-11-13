import { createHash } from 'node:crypto'
import { promises as fs, watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { FileSyncStatus, Host, SecretKind, SyncResult } from '../shared/types'
import type { HostStore } from './store/hosts'
import { sanitizeHost } from './store/hosts'
import type { SecretStore } from './store/secrets'
import type { SettingsStore } from './store/settings'
import { writeJson } from './store/jsonFile'
import { countDiff, mergeHosts } from './sync'
import {
  WrongPasswordError,
  decryptVault,
  deriveKey,
  encryptVault,
  newKdf,
  parseEnvelope,
  type HostSecrets,
  type KdfParams,
  type VaultPayload
} from './vaultFile'

/**
 * Serverless sync: every device reads and writes one encrypted JSON file that lives in a folder
 * the user already syncs (Dropbox, OneDrive, iCloud, Syncthing, Proton Drive, a NAS share…).
 * Devices merge per host (newest edit wins, deletions propagate); saved secrets travel with the
 * host version that wins. Each device keeps its own copy, so it works offline and converges later.
 */

/** Pseudo host id under which the master password is remembered in the OS-keychain store. */
export const MASTER_PASSWORD_ID = '__sync_file__'
const KINDS: SecretKind[] = ['password', 'key', 'passphrase']
const POLL_MS = 30_000

export interface FileSyncDeps {
  hosts: HostStore
  secrets: SecretStore
  settings: SettingsStore
  onStatus(s: FileSyncStatus): void
  /** scrypt cost for newly created files (tests use a cheaper value) */
  kdfN?: number
}

/** JSON.stringify with sorted object keys, so equal data always hashes the same. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

function digest(p: Pick<VaultPayload, 'hosts' | 'deleted' | 'secrets'>): string {
  const hosts = [...p.hosts].sort((a, b) => a.id.localeCompare(b.id))
  const secrets = Object.fromEntries(Object.entries(p.secrets).filter(([, s]) => Object.keys(s).length))
  return createHash('sha256').update(canon({ hosts, deleted: p.deleted, secrets })).digest('hex')
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

  private async localSecrets(hosts: Host[]): Promise<Record<string, HostSecrets>> {
    const out: Record<string, HostSecrets> = {}
    for (const h of hosts) {
      const s = await this.deps.secrets.getAll(h.id)
      if (Object.keys(s).length) out[h.id] = s
    }
    return out
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

      let remote: VaultPayload = { v: 1, at: 0, hosts: [], deleted: {}, secrets: {} }
      let kdf: KdfParams
      let key: Buffer
      if (text !== undefined) {
        const env = parseEnvelope(text)
        key = await this.keyFor(env.kdf)
        remote = decryptVault(env, key)
        kdf = env.kdf
        const clean: Host[] = []
        for (const h of remote.hosts) {
          try {
            clean.push(sanitizeHost(h))
          } catch {
            /* skip invalid entries */
          }
        }
        remote.hosts = clean
      } else {
        kdf = newKdf(this.deps.kdfN)
        key = await this.keyFor(kdf)
      }

      const include = s.includeSecrets
      const localHosts = this.deps.hosts.list()
      const local = { hosts: localHosts, deleted: this.deps.hosts.tombstones() }
      const mine = include ? await this.localSecrets(localHosts) : {}
      const merged = mergeHosts(local, remote, at)

      // secrets follow the winning version of each host; on a tie (same version) keep the union
      const localById = new Map(localHosts.map((h) => [h.id, h]))
      const remoteById = new Map(remote.hosts.map((h) => [h.id, h]))
      const secrets: Record<string, HostSecrets> = {}
      for (const h of merged.hosts) {
        const l = localById.get(h.id)?.updatedAt
        const r = remoteById.get(h.id)?.updatedAt
        let chosen: HostSecrets
        if (!include) chosen = remote.secrets[h.id] ?? {}
        else if (l !== undefined && r !== undefined && l === r) chosen = { ...(remote.secrets[h.id] ?? {}), ...(mine[h.id] ?? {}) }
        else if (l === h.updatedAt) chosen = mine[h.id] ?? {}
        else chosen = remote.secrets[h.id] ?? {}
        if (Object.keys(chosen).length) secrets[h.id] = chosen
      }

      // apply the merge locally
      this.applying = true
      try {
        const localFp = digest({ hosts: local.hosts, deleted: local.deleted, secrets: {} })
        if (digest({ hosts: merged.hosts, deleted: merged.deleted, secrets: {} }) !== localFp) {
          await this.deps.hosts.replaceAll(merged.hosts, merged.deleted)
        }
        const mergedIds = new Set(merged.hosts.map((h) => h.id))
        for (const id of localById.keys()) if (!mergedIds.has(id)) await this.deps.secrets.removeHost(id)
        if (include && (await this.deps.secrets.backend()).available) {
          for (const h of merged.hosts) {
            const want = secrets[h.id] ?? {}
            const have = mine[h.id] ?? {}
            for (const k of KINDS) {
              if (want[k] === have[k]) continue
              if (want[k]) await this.deps.secrets.set(h.id, k, want[k]!)
              else await this.deps.secrets.remove(h.id, k)
            }
          }
        }
      } finally {
        this.applying = false
      }

      // write the file only when its content would change (or to re-key it)
      const payload: VaultPayload = { v: 1, at, hosts: merged.hosts, deleted: merged.deleted, secrets }
      if (text === undefined || this.rekey || digest(payload) !== digest(remote)) {
        if (this.rekey) {
          kdf = this.rekey.kdf
          key = this.rekey.key
        }
        const env = encryptVault(payload, key, kdf)
        await writeJson(s.path, env)
        this.lastSeen = sha(JSON.stringify(env, null, 2))
        if (this.rekey) {
          this.password = this.rekey.password
          this.keyCache = { salt: kdf.salt, key }
        }
      } else {
        this.lastSeen = sha(text)
      }
      this.rekey = undefined

      await this.deps.settings.update({ fileSync: { ...this.deps.settings.get().fileSync, lastSyncAt: at, lastError: '' } })
      return {
        ok: true,
        message: `Synced ${merged.hosts.length} host${merged.hosts.length === 1 ? '' : 's'}`,
        pulled: countDiff(local, merged),
        pushed: countDiff(remote, merged),
        at
      }
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
