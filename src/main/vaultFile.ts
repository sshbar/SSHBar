import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from 'node:crypto'
import type { Host, SecretKind, Snippet } from '../shared/types'

/**
 * The encrypted sync file: a small JSON envelope around an AES-256-GCM ciphertext. The key is
 * derived from the user's master password with scrypt. The envelope header (format, KDF
 * parameters, IV) is bound to the ciphertext as additional authenticated data, so tampering
 * with any part of the file is detected on decrypt.
 */

export const VAULT_FORMAT = 'sshbar-vault' as const
/** Files written before the app was renamed from SSHBuddy still open (and are rewritten in the new format). */
const LEGACY_FORMATS = ['sshbuddy-vault']

export interface KdfParams {
  name: 'scrypt'
  N: number
  r: number
  p: number
  salt: string
}

export interface VaultEnvelope {
  format: string
  version: 1
  kdf: KdfParams
  cipher: { name: 'aes-256-gcm'; iv: string }
  tag: string
  data: string
}

export type HostSecrets = Partial<Record<SecretKind, string>>

export interface VaultPayload {
  v: 1
  at: number
  hosts: Host[]
  deleted: Record<string, number>
  /** hostId -> saved secrets (only when "include secrets" is on) */
  secrets: Record<string, HostSecrets>
  snippets: Snippet[]
  snippetsDeleted: Record<string, number>
}

export class WrongPasswordError extends Error {
  constructor() {
    super('Wrong master password (or the sync file is damaged)')
  }
}

export function newKdf(N = 2 ** 17): KdfParams {
  return { name: 'scrypt', N, r: 8, p: 1, salt: randomBytes(16).toString('base64') }
}

export function deriveKey(password: string, kdf: KdfParams): Promise<Buffer> {
  if (kdf.name !== 'scrypt' || !Number.isInteger(kdf.N) || kdf.N < 2 ** 14 || kdf.N > 2 ** 22 || kdf.r < 1 || kdf.r > 32 || kdf.p < 1 || kdf.p > 16) {
    return Promise.reject(new Error('Unsupported key derivation parameters in the sync file'))
  }
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize('NFC'), Buffer.from(kdf.salt, 'base64'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 512 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key)
    )
  )
}

function aad(e: Pick<VaultEnvelope, 'format' | 'version' | 'kdf' | 'cipher'>): Buffer {
  return Buffer.from(JSON.stringify([e.format, e.version, e.kdf, e.cipher]))
}

export function encryptVault(payload: VaultPayload, key: Buffer, kdf: KdfParams): VaultEnvelope {
  const iv = randomBytes(12)
  const head = { format: VAULT_FORMAT, version: 1 as const, kdf, cipher: { name: 'aes-256-gcm' as const, iv: iv.toString('base64') } }
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(aad(head))
  const data = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()])
  return { ...head, tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }
}

export function parseEnvelope(text: string): VaultEnvelope {
  let e: VaultEnvelope
  try {
    e = JSON.parse(text) as VaultEnvelope
  } catch {
    throw new Error('This is not an SSHbar sync file (invalid JSON)')
  }
  if (e?.format !== VAULT_FORMAT && !LEGACY_FORMATS.includes(e?.format)) throw new Error('This is not an SSHbar sync file')
  if (e.version !== 1) throw new Error(`Unsupported sync file version ${String(e.version)} — update SSHbar`)
  if (e.cipher?.name !== 'aes-256-gcm' || !e.cipher.iv || !e.tag || typeof e.data !== 'string') throw new Error('The sync file is damaged')
  return e
}

export function decryptVault(e: VaultEnvelope, key: Buffer): VaultPayload {
  let plain: string
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(e.cipher.iv, 'base64'))
    d.setAAD(aad(e))
    d.setAuthTag(Buffer.from(e.tag, 'base64'))
    plain = Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()]).toString('utf8')
  } catch {
    throw new WrongPasswordError()
  }
  const raw = JSON.parse(plain) as Partial<VaultPayload>
  return {
    v: 1,
    at: Number(raw.at) || 0,
    hosts: Array.isArray(raw.hosts) ? raw.hosts : [],
    deleted: raw.deleted && typeof raw.deleted === 'object' ? raw.deleted : {},
    secrets: raw.secrets && typeof raw.secrets === 'object' ? raw.secrets : {},
    snippets: Array.isArray(raw.snippets) ? raw.snippets : [],
    snippetsDeleted: raw.snippetsDeleted && typeof raw.snippetsDeleted === 'object' ? raw.snippetsDeleted : {}
  }
}
