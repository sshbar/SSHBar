import { join } from 'node:path'
import type { SecretBackendInfo, SecretKind } from '../../shared/types'
import { readJsonSync, writeJson } from './jsonFile'

/** Minimal interface over Electron's safeStorage so the store can be tested outside Electron. */
export interface Cipher {
  info(): Promise<SecretBackendInfo>
  encrypt(plain: string): Promise<Buffer>
  decrypt(data: Buffer): Promise<string>
}

interface SecretsFile {
  version: 1
  /** `${hostId}:${kind}` -> base64(ciphertext) */
  entries: Record<string, string>
}

/**
 * Per-device secret storage. Values are encrypted with the OS keychain
 * (Keychain on macOS, DPAPI on Windows, libsecret/kwallet on Linux) and are
 * never synced or sent to the renderer.
 */
export class SecretStore {
  private file: string
  private data: SecretsFile
  private listeners = new Set<() => void>()

  constructor(
    dir: string,
    private cipher: Cipher
  ) {
    this.file = join(dir, 'secrets.json')
    this.data = { version: 1, entries: readJsonSync<SecretsFile>(this.file, { version: 1, entries: {} }).entries ?? {} }
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private async persist(): Promise<void> {
    await writeJson(this.file, this.data)
    for (const l of this.listeners) l()
  }

  /** All saved secrets for one host (decrypted). */
  async getAll(hostId: string): Promise<Partial<Record<SecretKind, string>>> {
    const out: Partial<Record<SecretKind, string>> = {}
    for (const k of ['password', 'key', 'passphrase'] as SecretKind[]) {
      const v = await this.get(hostId, k)
      if (v !== undefined) out[k] = v
    }
    return out
  }

  backend(): Promise<SecretBackendInfo> {
    return this.cipher.info()
  }

  private async assertAvailable(): Promise<void> {
    const info = await this.cipher.info()
    if (!info.available) {
      throw new Error(
        `Secure storage is unavailable (${info.reason ?? info.backend}). Use "Ask every time" or Proton Pass instead.`
      )
    }
  }

  async set(hostId: string, kind: SecretKind, value: string): Promise<void> {
    await this.assertAvailable()
    if (!value) return this.remove(hostId, kind)
    this.data.entries[`${hostId}:${kind}`] = (await this.cipher.encrypt(value)).toString('base64')
    await this.persist()
  }

  async get(hostId: string, kind: SecretKind): Promise<string | undefined> {
    const enc = this.data.entries[`${hostId}:${kind}`]
    if (!enc) return undefined
    try {
      return await this.cipher.decrypt(Buffer.from(enc, 'base64'))
    } catch {
      return undefined
    }
  }

  has(hostId: string): Record<SecretKind, boolean> {
    return {
      password: `${hostId}:password` in this.data.entries,
      key: `${hostId}:key` in this.data.entries,
      passphrase: `${hostId}:passphrase` in this.data.entries
    }
  }

  async remove(hostId: string, kind: SecretKind): Promise<void> {
    delete this.data.entries[`${hostId}:${kind}`]
    await this.persist()
  }

  async removeHost(hostId: string): Promise<void> {
    for (const k of Object.keys(this.data.entries)) {
      if (k.startsWith(`${hostId}:`)) delete this.data.entries[k]
    }
    await this.persist()
  }

  async copyHost(fromId: string, toId: string): Promise<void> {
    for (const [k, v] of Object.entries(this.data.entries)) {
      if (k.startsWith(`${fromId}:`)) this.data.entries[`${toId}:${k.slice(fromId.length + 1)}`] = v
    }
    await this.persist()
  }
}
