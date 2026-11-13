// Node crypto implementation of the sync-file codec (format and merge rules: src/shared/vaultSync.ts).
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from 'node:crypto'
import {
  VAULT_FORMAT,
  WrongPasswordError,
  aadString,
  checkKdf,
  newKdf as sharedNewKdf,
  normalizePayload,
  parseEnvelope,
  type HostSecrets,
  type KdfParams,
  type VaultEnvelope,
  type VaultPayload
} from '../shared/vaultSync'

export { VAULT_FORMAT, WrongPasswordError, parseEnvelope }
export type { HostSecrets, KdfParams, VaultEnvelope, VaultPayload }

export const newKdf = sharedNewKdf

export function deriveKey(password: string, kdf: KdfParams): Promise<Buffer> {
  try {
    checkKdf(kdf)
  } catch (e) {
    return Promise.reject(e)
  }
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize('NFC'), Buffer.from(kdf.salt, 'base64'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 512 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key)
    )
  )
}

export function encryptVault(payload: VaultPayload, key: Buffer, kdf: KdfParams): VaultEnvelope {
  const iv = randomBytes(12)
  const head = { format: VAULT_FORMAT, version: 1 as const, kdf, cipher: { name: 'aes-256-gcm' as const, iv: iv.toString('base64') } }
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(aadString(head)))
  const data = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()])
  return { ...head, tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }
}

export function decryptVault(e: VaultEnvelope, key: Buffer): VaultPayload {
  let plain: string
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(e.cipher.iv, 'base64'))
    d.setAAD(Buffer.from(aadString(e)))
    d.setAuthTag(Buffer.from(e.tag, 'base64'))
    plain = Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()]).toString('utf8')
  } catch {
    throw new WrongPasswordError()
  }
  return normalizePayload(JSON.parse(plain) as Partial<VaultPayload>)
}
