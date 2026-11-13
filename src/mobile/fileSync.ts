// The encrypted sync file on Android: the shared merge core (src/shared/vaultSync.ts) with WebCrypto
// AES-GCM, native scrypt, and the file reached through Android's document providers (Drive, Dropbox…).
import type { FileSyncStatus, SecretKind, SyncResult } from '../shared/types'
import {
  VAULT_FORMAT,
  WrongPasswordError,
  aadString,
  fromB64,
  newKdf,
  normalizePayload,
  parseEnvelope,
  syncVault,
  toB64,
  type KdfParams,
  type PassSecret,
  type VaultEnvelope,
  type VaultPayload
} from '../shared/vaultSync'
import { Native } from './native'
import type { MobileHosts, MobileSettings, MobileSnippets } from './stores'

const MASTER_KEY = '__sync_file__:password'
const PASS_REFS_FILE = 'pass-refs.json'
const KINDS: SecretKind[] = ['password', 'key', 'passphrase']
const POLL_MS = 60_000
const enc = new TextEncoder()
const dec = new TextDecoder()

export async function deriveKey(password: string, kdf: KdfParams): Promise<CryptoKey> {
  const { key } = await Native.scrypt({ password: password.normalize('NFC'), salt: kdf.salt, N: kdf.N, r: kdf.r, p: kdf.p, dkLen: 32 })
  return crypto.subtle.importKey('raw', fromB64(key) as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function encryptVault(payload: VaultPayload, key: CryptoKey, kdf: KdfParams): Promise<VaultEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const head = { format: VAULT_FORMAT, version: 1 as const, kdf, cipher: { name: 'aes-256-gcm' as const, iv: toB64(iv) } }
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aadString(head)), tagLength: 128 }, key, enc.encode(JSON.stringify(payload)))
  )
  // WebCrypto appends the 16-byte tag; the file stores it separately (same layout as the desktop)
  return { ...head, tag: toB64(sealed.subarray(sealed.length - 16)), data: toB64(sealed.subarray(0, sealed.length - 16)) }
}

export async function decryptVault(e: VaultEnvelope, key: CryptoKey): Promise<VaultPayload> {
  const data = fromB64(e.data)
  const tag = fromB64(e.tag)
  const sealed = new Uint8Array(data.length + tag.length)
  sealed.set(data)
  sealed.set(tag, data.length)
  let plain: ArrayBuffer
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(e.cipher.iv) as BufferSource, additionalData: enc.encode(aadString(e)), tagLength: 128 }, key, sealed)
  } catch {
    throw new WrongPasswordError()
  }
  return normalizePayload(JSON.parse(dec.decode(plain)) as Partial<VaultPayload>)
}

const secretKey = (owner: string, kind: SecretKind): string => `${owner}:${kind}`

export class MobileFileSync {
  private password?: string
  private keyCache?: { salt: string; key: CryptoKey }
  private rekey?: { kdf: KdfParams; key: CryptoKey; password: string }
  private running?: Promise<SyncResult>
  private debounce?: ReturnType<typeof setTimeout>
  private poll?: ReturnType<typeof setInterval>
  private lastText = ''
  applying = false

  constructor(
    private deps: {
      hosts: MobileHosts
      snippets: MobileSnippets
      settings: MobileSettings
      onStatus(s: FileSyncStatus): void
    }
  ) {}

  status(): FileSyncStatus {
    const s = this.deps.settings.get().fileSync
    return { ...s, locked: s.enabled && !this.password, syncing: !!this.running }
  }

  private emit(): void {
    this.deps.onStatus(this.status())
  }

  async init(): Promise<void> {
    const s = this.deps.settings.get().fileSync
    if (s.enabled && s.rememberPassword) this.password = (await Native.secureGet({ key: MASTER_KEY })).value ?? undefined
    this.watch()
    this.emit()
    if (s.enabled && this.password) await this.sync()
  }

  async pick(mode: 'open' | 'create'): Promise<{ uri: string; name: string } | null> {
    const r = await Native.pickDocument({ mode, name: 'sshbar-sync.json' })
    return r.uri ? { uri: r.uri, name: r.name ?? 'sync file' } : null
  }

  async enable(opts: { path: string; label: string; password: string; includeSecrets: boolean; rememberPassword: boolean; create: boolean }): Promise<SyncResult> {
    if (!opts.path) throw new Error('Choose the sync file first')
    if (opts.password.length < 8) throw new Error('Use a master password of at least 8 characters')
    const text = await this.read(opts.path)
    if (text === undefined && !opts.create) throw new Error('That file is empty — pick the sync file your computer created, or create a new one')
    if (text !== undefined) {
      // never overwrite an existing file: it must open with this password and is then merged
      const env = parseEnvelope(text)
      const key = await deriveKey(opts.password, env.kdf)
      await decryptVault(env, key)
      this.keyCache = { salt: env.kdf.salt, key }
    } else {
      this.keyCache = undefined
    }
    this.password = opts.password
    await this.deps.settings.update({
      fileSync: { ...this.deps.settings.get().fileSync, enabled: true, path: opts.path, pathLabel: opts.label, includeSecrets: opts.includeSecrets, rememberPassword: opts.rememberPassword, lastError: '' }
    })
    await this.rememberPassword(opts.rememberPassword)
    this.watch()
    return this.sync()
  }

  async unlock(password: string, remember: boolean): Promise<SyncResult> {
    this.password = password
    this.keyCache = undefined
    const res = await this.sync()
    if (!res.ok && !this.password) throw new Error(res.message)
    await this.deps.settings.update({ fileSync: { ...this.deps.settings.get().fileSync, rememberPassword: remember } })
    await this.rememberPassword(remember)
    this.emit()
    return res
  }

  async disable(): Promise<void> {
    this.password = undefined
    this.keyCache = undefined
    await Native.secureRemove({ key: MASTER_KEY })
    await this.deps.settings.update({ fileSync: { ...this.deps.settings.get().fileSync, enabled: false, lastError: '' } })
    this.emit()
  }

  async changePassword(newPassword: string): Promise<SyncResult> {
    if (!this.password) throw new Error('Unlock the sync file first')
    if (newPassword.length < 8) throw new Error('Use a master password of at least 8 characters')
    const kdf = newKdf()
    this.rekey = { kdf, key: await deriveKey(newPassword, kdf), password: newPassword }
    const res = await this.sync()
    if (res.ok) await this.rememberPassword(this.deps.settings.get().fileSync.rememberPassword)
    return res
  }

  async setIncludeSecrets(include: boolean): Promise<SyncResult> {
    await this.deps.settings.update({ fileSync: { ...this.deps.settings.get().fileSync, includeSecrets: include } })
    return this.sync()
  }

  scheduleSync(delayMs = 2000): void {
    if (!this.deps.settings.get().fileSync.enabled || !this.password || this.applying) return
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

  // ---------------------------------------------------------------------------

  private async read(uri: string): Promise<string | undefined> {
    const { data } = await Native.readUri({ uri })
    return data && data.trim() ? data : undefined
  }

  private async rememberPassword(remember: boolean): Promise<void> {
    if (remember && this.password) await Native.secureSet({ key: MASTER_KEY, value: this.password })
    else await Native.secureRemove({ key: MASTER_KEY })
  }

  private async keyFor(kdf: KdfParams): Promise<CryptoKey> {
    if (this.keyCache?.salt === kdf.salt) return this.keyCache.key
    const key = await deriveKey(this.password!, kdf)
    this.keyCache = { salt: kdf.salt, key }
    return key
  }

  /** Store Proton Pass copies from the file in the Keystore-backed storage ("pp:share:item:kind"). */
  private async applyPassSecrets(map: Record<string, PassSecret>): Promise<void> {
    const prev = JSON.parse((await Native.readText({ name: PASS_REFS_FILE })).data ?? '[]') as string[]
    for (const ref of prev) {
      if (map[ref]) continue
      for (const k of KINDS) await Native.secureRemove({ key: secretKey(`pp:${ref}`, k) })
    }
    for (const [ref, s] of Object.entries(map)) {
      const values: Record<SecretKind, string | undefined> = { password: s.password, key: s.privateKey, passphrase: s.passphrase }
      for (const k of KINDS) {
        const v = values[k]
        if (v) await Native.secureSet({ key: secretKey(`pp:${ref}`, k), value: v })
        else await Native.secureRemove({ key: secretKey(`pp:${ref}`, k) })
      }
    }
    await Native.writeText({ name: PASS_REFS_FILE, data: JSON.stringify(Object.keys(map)) })
  }

  private async doSync(): Promise<SyncResult> {
    const s = this.deps.settings.get().fileSync
    const at = Date.now()
    if (!s.enabled) return { ok: false, message: 'Sync file is not enabled', pulled: 0, pushed: 0, at }
    if (!this.password) return { ok: false, message: 'Sync file is locked — enter the master password', pulled: 0, pushed: 0, at }
    const rekey = this.rekey
    try {
      const text = await this.read(s.path)
      this.applying = true
      let res
      try {
        res = await syncVault<CryptoKey>({
          text,
          includeSecrets: s.includeSecrets,
          rekey: rekey && { kdf: rekey.kdf, key: rekey.key },
          now: at,
          codec: { newKdf: () => newKdf(), keyFor: (kdf) => this.keyFor(kdf), encrypt: encryptVault, decrypt: decryptVault },
          stores: {
            hosts: this.deps.hosts,
            snippets: this.deps.snippets,
            secrets: {
              getAll: async (id) => {
                const out: Partial<Record<SecretKind, string>> = {}
                for (const k of KINDS) {
                  const v = (await Native.secureGet({ key: secretKey(id, k) })).value
                  if (v) out[k] = v
                }
                return out
              },
              set: (id, k, v) => Native.secureSet({ key: secretKey(id, k), value: v }),
              remove: (id, k) => Native.secureRemove({ key: secretKey(id, k) }),
              removeHost: async (id) => {
                for (const k of KINDS) await Native.secureRemove({ key: secretKey(id, k) })
              },
              available: async () => true
            },
            passSecrets: { apply: (m) => this.applyPassSecrets(m) }
          }
        })
      } finally {
        this.applying = false
      }
      if (res.write !== undefined) await Native.writeUri({ uri: s.path, data: res.write })
      this.lastText = res.text
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
        this.password = undefined
        this.keyCache = undefined
      }
      const message = (e as Error).message
      await this.deps.settings.update({ fileSync: { ...this.deps.settings.get().fileSync, lastError: message } })
      return { ok: false, message, pulled: 0, pushed: 0, at }
    }
  }

  /** Pick up changes other devices wrote: when the app comes back to the foreground, and every minute. */
  private watch(): void {
    if (this.poll) return
    const check = async (): Promise<void> => {
      const s = this.deps.settings.get().fileSync
      if (!s.enabled || !this.password || this.running || document.visibilityState !== 'visible') return
      const text = await this.read(s.path).catch(() => undefined)
      if (text !== undefined && text !== this.lastText) void this.sync()
    }
    document.addEventListener('visibilitychange', () => void check())
    this.poll = setInterval(() => void check(), POLL_MS)
  }
}
