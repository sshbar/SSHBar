import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { FileSync, MASTER_PASSWORD_ID } from '../src/main/fileSync'
import { HostStore } from '../src/main/store/hosts'
import { SecretStore, type Cipher } from '../src/main/store/secrets'
import { SettingsStore } from '../src/main/store/settings'
import { SnippetStore } from '../src/main/store/snippets'
import { WrongPasswordError, decryptVault, deriveKey, encryptVault, newKdf, parseEnvelope } from '../src/main/vaultFile'
import { emptyHost } from '../src/shared/defaults'

// stand-in for the OS keychain
const cipher: Cipher = {
  info: async () => ({ available: true, backend: 'test' }),
  encrypt: async (s) => Buffer.from('k:' + s),
  decrypt: async (b) => b.toString().slice(2)
}

const PASSWORD = 'correct horse battery'
const devices: FileSync[] = []

function device(dir = mkdtempSync(join(tmpdir(), 'sb-dev-'))) {
  const hosts = new HostStore(dir)
  const secrets = new SecretStore(dir, cipher)
  const settings = new SettingsStore(dir)
  const snippets = new SnippetStore(dir)
  const sync = new FileSync({ hosts, secrets, settings, snippets, onStatus: () => undefined, kdfN: 2 ** 14 })
  devices.push(sync)
  return { dir, hosts, secrets, settings, snippets, sync }
}

const until = async (fn: () => boolean, ms = 6000): Promise<void> => {
  const t = Date.now()
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 50))
  }
}

afterAll(() => devices.forEach((d) => d.dispose()))

describe('vault file crypto', () => {
  it('round-trips and detects wrong passwords and tampering', async () => {
    const kdf = newKdf(2 ** 14)
    const key = await deriveKey('pw-1234567', kdf)
    const env = encryptVault({ v: 1, at: 1, hosts: [], deleted: { x: 1 }, secrets: { h: { password: 'hunter2' } }, snippets: [], snippetsDeleted: {} }, key, kdf)
    expect(JSON.stringify(env)).not.toContain('hunter2')
    expect(decryptVault(parseEnvelope(JSON.stringify(env)), key).secrets.h.password).toBe('hunter2')
    await expect(deriveKey('wrong-pass', kdf).then((k) => decryptVault(env, k))).rejects.toBeInstanceOf(WrongPasswordError)
    expect(() => decryptVault({ ...env, kdf: { ...env.kdf, N: 2 ** 15 } }, key)).toThrow(WrongPasswordError) // header is authenticated
    const flipped = Buffer.from(env.data, 'base64')
    flipped[0] ^= 1
    expect(() => decryptVault({ ...env, data: flipped.toString('base64') }, key)).toThrow(WrongPasswordError)
    expect(() => parseEnvelope('{"hello":1}')).toThrow(/not an SSHbar sync file/)
  })
})

describe('encrypted sync file across devices', () => {
  const folder = mkdtempSync(join(tmpdir(), 'sb-shared-'))
  const path = join(folder, 'sshbar-sync.json')
  const a = device()
  const b = device()
  let webId = ''

  it('creates the file without leaking hosts or secrets', async () => {
    const web = await a.hosts.save({ ...emptyHost(), label: 'web', hostname: 'web.example', username: 'deploy', auth: { ...emptyHost().auth, password: { source: 'local' } } })
    webId = web.id
    await a.secrets.set(web.id, 'password', 'pw-web')
    const res = await a.sync.enable({ path, password: PASSWORD, includeSecrets: true, rememberPassword: true, create: true })
    expect(res).toMatchObject({ ok: true, pushed: 1 })
    const text = readFileSync(path, 'utf8')
    expect(text).not.toMatch(/web\.example|pw-web|deploy/)
    expect(JSON.parse(text)).toMatchObject({ format: 'sshbar-vault', kdf: { name: 'scrypt' }, cipher: { name: 'aes-256-gcm' } })
    // master password remembered via the keychain store
    expect(await a.secrets.get(MASTER_PASSWORD_ID, 'password')).toBe(PASSWORD)
  })

  it('a second device opens it and gets hosts and secrets', async () => {
    const res = await b.sync.enable({ path, password: PASSWORD, includeSecrets: true, rememberPassword: true, create: false })
    expect(res).toMatchObject({ ok: true, pulled: 1 })
    expect(b.hosts.list().map((h) => h.label)).toEqual(['web'])
    expect(await b.secrets.get(webId, 'password')).toBe('pw-web')
  })

  it('refuses a wrong password and never overwrites an existing file', async () => {
    const c = device()
    await c.hosts.save({ ...emptyHost(), hostname: 'c-only.example' })
    const before = readFileSync(path, 'utf8')
    await expect(c.sync.enable({ path, password: 'not the password', includeSecrets: true, rememberPassword: false, create: true })).rejects.toThrow(
      /Wrong master password/
    )
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(c.settings.get().fileSync.enabled).toBe(false)
  })

  it('propagates edits, removed secrets and deletions', async () => {
    // B stops saving the password (editor saves the host, then removes the secret)
    const h = b.hosts.get(webId)!
    await b.hosts.save({ ...h, label: 'web-1', auth: { ...h.auth, password: { source: 'prompt' } } })
    await b.secrets.remove(webId, 'password')
    const db = await b.hosts.save({ ...emptyHost(), label: 'db', hostname: 'db.example' })
    await b.secrets.set(db.id, 'password', 'pw-db')
    await b.sync.sync()
    await a.sync.sync()
    expect(a.hosts.get(webId)?.label).toBe('web-1')
    expect(await a.secrets.get(webId, 'password')).toBeUndefined()
    expect(await a.secrets.get(db.id, 'password')).toBe('pw-db')

    await a.hosts.remove(db.id)
    await a.secrets.removeHost(db.id)
    await a.sync.sync()
    await b.sync.sync()
    expect(b.hosts.list().map((x) => x.label)).toEqual(['web-1'])
    expect(await b.secrets.get(db.id, 'password')).toBeUndefined()
  })

  it('merges concurrent offline edits from both devices', async () => {
    const x = await a.hosts.save({ ...emptyHost(), label: 'from-a', hostname: 'a.example' })
    const y = await b.hosts.save({ ...emptyHost(), label: 'from-b', hostname: 'b.example' })
    await a.sync.sync()
    await b.sync.sync()
    await a.sync.sync()
    const labels = (s: HostStore) => s.list().map((h) => h.label).sort()
    expect(labels(a.hosts)).toEqual(['from-a', 'from-b', 'web-1'])
    expect(labels(b.hosts)).toEqual(labels(a.hosts))
    expect([x.id, y.id].every((id) => b.hosts.get(id))).toBe(true)
  })

  it('a device that does not include secrets leaves them intact for the others', async () => {
    const d = device()
    await d.sync.enable({ path, password: PASSWORD, includeSecrets: false, rememberPassword: false, create: false })
    await a.secrets.set(webId, 'key', 'KEY-MATERIAL')
    await a.hosts.save({ ...a.hosts.get(webId)!, notes: 'key added' })
    await a.sync.sync()
    await d.sync.sync()
    expect(await d.secrets.get(webId, 'key')).toBeUndefined()
    await d.hosts.save({ ...d.hosts.get(webId)!, label: 'web-renamed-by-d' })
    await d.sync.sync()
    await b.sync.sync()
    expect(b.hosts.get(webId)?.label).toBe('web-renamed-by-d')
    expect(await b.secrets.get(webId, 'key')).toBe('KEY-MATERIAL')
  })

  it('syncs snippets, including edits and deletions', async () => {
    const s1 = await a.snippets.save({ name: 'disk', command: 'df -h' })
    const s2 = await a.snippets.save({ name: 'logs', command: 'journalctl -f' })
    await a.sync.sync()
    await b.sync.sync()
    expect(b.snippets.list().map((s) => s.command).sort()).toEqual(['df -h', 'journalctl -f'])
    await b.snippets.save({ ...s1, command: 'df -hT' })
    await b.snippets.remove(s2.id)
    await b.sync.sync()
    await a.sync.sync()
    expect(a.snippets.list().map((s) => s.command)).toEqual(['df -hT'])
    expect(readFileSync(path, 'utf8')).not.toContain('df -hT')
  })

  it('picks up changes written by another device automatically', async () => {
    const z = await a.hosts.save({ ...emptyHost(), label: 'watched', hostname: 'w.example' })
    await a.sync.sync()
    await until(() => !!b.hosts.get(z.id), 8000)
  })

  it('locks other devices after a password change until they unlock', async () => {
    expect((await a.sync.changePassword('a brand new passphrase')).ok).toBe(true)
    const res = await b.sync.sync()
    expect(res.ok).toBe(false)
    expect(b.sync.status().locked).toBe(true)
    await expect(b.sync.unlock(PASSWORD, true)).rejects.toThrow(/Wrong master password/)
    expect((await b.sync.unlock('a brand new passphrase', true)).ok).toBe(true)
    expect(b.sync.status().locked).toBe(false)
  })

  it('unlocks automatically on restart with a remembered password', async () => {
    const again = device(b.dir)
    await again.sync.init()
    expect(again.sync.status()).toMatchObject({ enabled: true, locked: false })
  })

  it('rejects a corrupted file without touching local data', async () => {
    const before = a.hosts.list().length
    writeFileSync(path, readFileSync(path, 'utf8').replace(/"data": "./, '"data": "A'))
    const res = await a.sync.sync()
    expect(res.ok).toBe(false)
    expect(a.hosts.list()).toHaveLength(before)
  })
})

describe('sync files written before the rename', () => {
  it('still opens a file in the old "sshbuddy-vault" format', async () => {
    const { createCipheriv, randomBytes } = await import('node:crypto')
    const kdf = newKdf(2 ** 14)
    const key = await deriveKey('legacy-pass-123', kdf)
    const iv = randomBytes(12)
    const head = { format: 'sshbuddy-vault', version: 1 as const, kdf, cipher: { name: 'aes-256-gcm' as const, iv: iv.toString('base64') } }
    const c = createCipheriv('aes-256-gcm', key, iv)
    c.setAAD(Buffer.from(JSON.stringify([head.format, head.version, head.kdf, head.cipher])))
    const data = Buffer.concat([c.update(JSON.stringify({ v: 1, at: 1, hosts: [], deleted: {}, secrets: { h: { password: 'old' } } })), c.final()])
    const env = parseEnvelope(JSON.stringify({ ...head, tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }))
    expect(decryptVault(env, key).secrets.h.password).toBe('old')
  })
})

describe('sharing Proton Pass secrets with phones', () => {
  it('copies the referenced items into the file, passes them on, and removes them when switched off', async () => {
    const { syncVault, passRef } = await import('../src/shared/vaultSync')
    const { encryptVault, decryptVault } = await import('../src/main/vaultFile')
    const folder = mkdtempSync(join(tmpdir(), 'sb-pass-'))
    const path = join(folder, 'sync.json')
    const dir = mkdtempSync(join(tmpdir(), 'sb-dev-'))
    const hosts = new HostStore(dir)
    const secrets = new SecretStore(dir, cipher)
    const settings = new SettingsStore(dir)
    let fetched = 0
    const desktop = new FileSync({
      hosts,
      secrets,
      settings,
      onStatus: () => undefined,
      kdfN: 2 ** 14,
      passSecrets: () => ({
        collect: async (list) => {
          fetched++
          const out: Record<string, { privateKey: string }> = {}
          for (const h of list) if (h.auth.method === 'key' && h.auth.key.source === 'protonpass') out[passRef(h.auth.key.shareId, h.auth.key.itemId)] = { privateKey: 'PP-KEY' }
          return out
        }
      })
    })
    devices.push(desktop)
    await hosts.save({ ...emptyHost(), label: 'pp-host', hostname: 'pp.example', auth: { ...emptyHost().auth, method: 'key', key: { source: 'protonpass', shareId: 'S', itemId: 'I' } } })
    await desktop.enable({ path, password: PASSWORD, includeSecrets: true, rememberPassword: false, create: true })
    expect(fetched).toBe(0) // off by default
    await desktop.setSharePassSecrets(true)
    expect(fetched).toBe(1)

    // a phone-like device: no collect, only apply
    const { deriveKey } = await import('../src/main/vaultFile')
    const phoneApplied: Record<string, unknown>[] = []
    const phoneHosts = { list: () => [], tombstones: () => ({}), replaceAll: async () => undefined }
    const phoneSync = async () => {
      const text = readFileSync(path, 'utf8')
      return syncVault<Buffer>({
        text,
        includeSecrets: true,
        codec: {
          newKdf: () => { throw new Error('unused') },
          keyFor: (kdf) => deriveKey(PASSWORD, kdf),
          encrypt: async (p, k, kdf) => encryptVault(p, k, kdf),
          decrypt: async (e, k) => decryptVault(e, k)
        },
        stores: {
          hosts: phoneHosts,
          secrets: { getAll: async () => ({}), set: async () => undefined, remove: async () => undefined, removeHost: async () => undefined, available: async () => true },
          passSecrets: { apply: async (m) => void phoneApplied.push(m) }
        }
      })
    }
    await phoneSync()
    expect(phoneApplied.at(-1)).toEqual({ 'S:I': { privateKey: 'PP-KEY' } })
    expect(readFileSync(path, 'utf8')).not.toContain('PP-KEY')

    await desktop.setSharePassSecrets(false)
    await phoneSync()
    expect(phoneApplied.at(-1)).toEqual({})
  })
})
