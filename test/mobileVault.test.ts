/**
 * The Android sync-file codec (WebCrypto AES-GCM + native scrypt) must read and write exactly the
 * same files as the desktop (Node crypto). Native scrypt is stood in for by Node's scrypt here; the
 * phone's BouncyCastle scrypt is checked against the RFC 7914 vector on a device.
 */
import { scryptSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/mobile/native', () => ({
  Native: {
    scrypt: async (o: { password: string; salt: string; N: number; r: number; p: number; dkLen: number }) => ({
      key: scryptSync(o.password, Buffer.from(o.salt, 'base64'), o.dkLen, { N: o.N, r: o.r, p: o.p, maxmem: 512 * 1024 * 1024 }).toString('base64')
    })
  }
}))

const phone = await import('../src/mobile/fileSync')
const desktop = await import('../src/main/vaultFile')
const { newKdf, parseEnvelope, WrongPasswordError } = await import('../src/shared/vaultSync')

const payload = {
  v: 1 as const,
  at: 1,
  hosts: [],
  deleted: { gone: 5 },
  secrets: { h1: { password: 'pässwörd ✓' } },
  snippets: [],
  snippetsDeleted: {},
  passSecrets: { 'S:I': { privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n' } }
}

describe('phone and desktop sync files are interchangeable', () => {
  it('a desktop-written file opens on the phone', async () => {
    const kdf = newKdf(2 ** 14)
    const env = desktop.encryptVault(payload, await desktop.deriveKey('master pass', kdf), kdf)
    const back = await phone.decryptVault(parseEnvelope(JSON.stringify(env)), await phone.deriveKey('master pass', kdf))
    expect(back.secrets.h1.password).toBe('pässwörd ✓')
    expect(back.passSecrets?.['S:I'].privateKey).toContain('OPENSSH')
  })

  it('a phone-written file opens on the desktop', async () => {
    const kdf = newKdf(2 ** 14)
    const env = await phone.encryptVault(payload, await phone.deriveKey('master pass', kdf), kdf)
    expect(env.tag).toHaveLength(24) // 16-byte tag, stored separately like the desktop does
    const back = desktop.decryptVault(parseEnvelope(JSON.stringify(env)), await desktop.deriveKey('master pass', kdf))
    expect(back.deleted).toEqual({ gone: 5 })
  })

  it('the phone rejects a wrong password and a tampered header', async () => {
    const kdf = newKdf(2 ** 14)
    const env = desktop.encryptVault(payload, await desktop.deriveKey('master pass', kdf), kdf)
    await expect(phone.decryptVault(env, await phone.deriveKey('wrong pass', kdf))).rejects.toBeInstanceOf(WrongPasswordError)
    const key = await phone.deriveKey('master pass', kdf)
    await expect(phone.decryptVault({ ...env, cipher: { ...env.cipher, iv: Buffer.alloc(12).toString('base64') } }, key)).rejects.toBeInstanceOf(WrongPasswordError)
  })
})
