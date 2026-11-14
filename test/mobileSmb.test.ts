/**
 * The sync file on a NAS (SMB share) on Android: path handling, the saved login, and a full
 * desktop ⇄ phone round trip through a fake share. The native smbj code (SmbFiles.java) is checked
 * against a real Samba server with scripts/smb-server.sh.
 */
import { scryptSync } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanSmbDir,
  formatSmbPath,
  joinSmb,
  parentSmb,
  parseServerInput,
  parseSmbPath,
  smbLabel,
  smbSecretKey
} from '../src/shared/smbPath'

// ----- fake native module: app files, Keystore storage and one SMB share -----
const files = new Map<string, string>()
const secure = new Map<string, string>()
const share = new Map<string, string>() // "Nicolae/SSHSyncFile/sshbar-sync.json" -> text
const smbCalls: { method: string; host: string; port: number; share: string; username: string; password: string; path: string }[] = []
const NAS = { host: '192.0.2.10', port: 445, share: 'NAS', username: 'nick', password: 'nas pw' }

type T = { host: string; port: number; share: string; username: string; password: string; path: string }
function checkLogin(method: string, o: T): void {
  smbCalls.push({ method, ...o })
  if (o.host !== NAS.host || o.port !== NAS.port) throw new Error(`Can't connect to ${o.host}`)
  if (o.share !== NAS.share) throw new Error(`There is no share called “${o.share}” on ${o.host}`)
  if (o.username !== NAS.username || o.password !== NAS.password) throw new Error('The NAS did not accept this username and password')
}

vi.mock('../src/mobile/native', () => ({
  Native: {
    scrypt: async (o: { password: string; salt: string; N: number; r: number; p: number; dkLen: number }) => ({
      key: scryptSync(o.password, Buffer.from(o.salt, 'base64'), o.dkLen, { N: o.N, r: o.r, p: o.p, maxmem: 512 * 1024 * 1024 }).toString('base64')
    }),
    readText: async (o: { name: string }) => ({ data: files.get(o.name) ?? null }),
    writeText: async (o: { name: string; data: string }) => void files.set(o.name, o.data),
    secureGet: async (o: { key: string }) => ({ value: secure.get(o.key) ?? null }),
    secureSet: async (o: { key: string; value: string }) => void secure.set(o.key, o.value),
    secureRemove: async (o: { key: string }) => void secure.delete(o.key),
    readUri: async () => {
      throw new Error('the document picker path must not be used for smb://')
    },
    writeUri: async () => {
      throw new Error('the document picker path must not be used for smb://')
    },
    smbList: async (o: T) => {
      checkLogin('list', o)
      const prefix = o.path ? `${o.path}/` : ''
      const names = new Map<string, boolean>()
      for (const k of share.keys()) {
        if (!k.startsWith(prefix)) continue
        const [first, ...rest] = k.slice(prefix.length).split('/')
        names.set(first, rest.length > 0)
      }
      return { entries: [...names].map(([name, dir]) => ({ name, dir, size: dir ? 0 : share.get(prefix + name)!.length, modified: 0 })) }
    },
    smbRead: async (o: T) => {
      checkLogin('read', o)
      return { data: share.get(o.path) ?? null }
    },
    smbWrite: async (o: T & { data: string }) => {
      checkLogin('write', o)
      share.set(o.path, o.data)
    }
  }
}))

const { smbChoose, smbList, smbSaved } = await import('../src/mobile/smb')
const { MobileFileSync } = await import('../src/mobile/fileSync')
const { MobileHosts, MobileSettings, MobileSnippets } = await import('../src/mobile/stores')
const desktop = await import('../src/main/vaultFile')
const { newKdf, parseEnvelope } = await import('../src/shared/vaultSync')
const { sanitizeHost } = await import('../src/shared/hostModel')

beforeEach(() => {
  files.clear()
  secure.clear()
  share.clear()
  smbCalls.length = 0
  vi.stubGlobal('document', { addEventListener: () => undefined, visibilityState: 'hidden' })
})

describe('smb paths', () => {
  it('round-trips locations, including domain users, ports and odd characters', () => {
    const l = { host: 'nas.local', port: 4450, share: 'My Files', username: 'HOME\\nick', path: 'Nicolae/Sync #1/sshbar-sync.json' }
    const p = formatSmbPath(l)
    expect(p).toBe('smb://HOME%5Cnick@nas.local:4450/My%20Files/Nicolae/Sync%20%231/sshbar-sync.json')
    expect(parseSmbPath(p)).toEqual(l)
    expect(parseSmbPath('smb://192.0.2.10/NAS/a.json')).toEqual({ host: '192.0.2.10', port: 445, share: 'NAS', username: '', path: 'a.json' })
    expect(() => parseSmbPath('content://x/y')).toThrow(/Not a NAS location/)
  })

  it('shows Windows-style labels and never includes the user or password', () => {
    expect(smbLabel({ host: '192.0.2.10', port: 445, share: 'NAS', path: 'Nicolae/SSHSyncFile/sshbar-sync.json' })).toBe(
      '\\\\192.0.2.10\\NAS\\Nicolae\\SSHSyncFile\\sshbar-sync.json'
    )
    expect(smbLabel({ host: 'nas', port: 4450, share: 'NAS', path: '' })).toBe('\\\\nas:4450\\NAS')
  })

  it('understands what people paste as the NAS address', () => {
    expect(parseServerInput('192.0.2.10')).toEqual({ host: '192.0.2.10', port: 445 })
    expect(parseServerInput(' nas.local:4450 ')).toEqual({ host: 'nas.local', port: 4450 })
    expect(parseServerInput('\\\\192.0.2.10\\NAS\\Nicolae\\SSHSyncFile')).toEqual({ host: '192.0.2.10', port: 445, share: 'NAS', dir: 'Nicolae/SSHSyncFile' })
    expect(parseServerInput('smb://nick@nas/home/')).toEqual({ host: 'nas', port: 445, share: 'home' })
    expect(parseServerInput('//nas/home/a/b.json')).toEqual({ host: 'nas', port: 445, share: 'home', dir: 'a/b.json' })
  })

  it('joins and walks folders', () => {
    expect(cleanSmbDir('\\a//b\\c/')).toBe('a/b/c')
    expect(joinSmb('', 'x')).toBe('x')
    expect(joinSmb('a/b', 'c.json')).toBe('a/b/c.json')
    expect(parentSmb('a/b/c')).toBe('a/b')
    expect(parentSmb('a')).toBe('')
  })
})

describe('NAS login on the phone', () => {
  it('keeps the password in secure storage, not in the sync path or the saved login', async () => {
    const path = await smbChoose(NAS, 'Nicolae/SSHSyncFile/sshbar-sync.json')
    expect(path).toBe('smb://nick@192.0.2.10/NAS/Nicolae/SSHSyncFile/sshbar-sync.json')
    expect(path).not.toContain('nas pw')
    expect(secure.get(smbSecretKey(NAS))).toBe('nas pw')
    expect(files.get('smb-login.json')).not.toContain('nas pw')
    expect(await smbSaved()).toEqual({ host: NAS.host, port: 445, share: 'NAS', username: 'nick', dir: 'Nicolae/SSHSyncFile', hasPassword: true })
  })

  it('an empty password means the saved one', async () => {
    share.set('Nicolae/SSHSyncFile/sshbar-sync.json', '{}')
    await expect(smbList({ ...NAS, password: '' }, '')).rejects.toThrow(/did not accept/)
    await smbChoose(NAS, 'Nicolae/SSHSyncFile/sshbar-sync.json')
    expect(await smbList({ ...NAS, password: '' }, 'Nicolae')).toEqual([{ name: 'SSHSyncFile', dir: true, size: 0, modified: 0 }])
  })
})

describe('sync file on the NAS', () => {
  async function phone() {
    const hosts = new MobileHosts()
    const snippets = new MobileSnippets()
    const settings = new MobileSettings()
    await Promise.all([hosts.init(), snippets.init(), settings.init()])
    const sync = new MobileFileSync({ hosts, snippets, settings, onStatus: () => undefined })
    return { hosts, settings, sync }
  }

  it('opens a file the computer wrote, merges, and writes back what the computer can read', async () => {
    const kdf = newKdf(2 ** 14)
    const key = await desktop.deriveKey('master pass', kdf)
    const fromComputer = sanitizeHost({ id: 'h-desk', label: 'plex', hostname: '192.0.2.20', username: 'nick' })
    const env = desktop.encryptVault(
      { v: 1, at: 1, hosts: [fromComputer], deleted: {}, secrets: { 'h-desk': { password: 'server pw' } }, snippets: [], snippetsDeleted: {} },
      key,
      kdf
    )
    share.set('Nicolae/SSHSyncFile/sshbar-sync.json', JSON.stringify(env))

    const { hosts, settings, sync } = await phone()
    const path = await smbChoose(NAS, 'Nicolae/SSHSyncFile/sshbar-sync.json')
    const res = await sync.enable({ path, label: 'NAS', password: 'master pass', includeSecrets: true, rememberPassword: true, create: false })
    expect(res).toMatchObject({ ok: true })
    expect(hosts.list().map((h) => h.label)).toEqual(['plex'])
    expect(secure.get('h-desk:password')).toBe('server pw')

    await hosts.save(sanitizeHost({ id: 'h-phone', label: 'from phone', hostname: '192.0.2.30', username: 'pi' }))
    expect(await sync.sync()).toMatchObject({ ok: true })
    const written = parseEnvelope(share.get('Nicolae/SSHSyncFile/sshbar-sync.json')!)
    const back = desktop.decryptVault(written, await desktop.deriveKey('master pass', written.kdf))
    expect(back.hosts.map((h) => h.label).sort()).toEqual(['from phone', 'plex'])
    expect(settings.get().fileSync).toMatchObject({ enabled: true, path, lastError: '' })
    // every NAS call used the saved login; the document-picker path was never touched
    expect(smbCalls.every((c) => c.password === 'nas pw' && c.share === 'NAS')).toBe(true)
  })

  it('creates a new file in the chosen folder', async () => {
    share.set('Nicolae/SSHSyncFile/.keep', '')
    const { sync } = await phone()
    const path = await smbChoose(NAS, 'Nicolae/SSHSyncFile/sshbar-sync.json')
    expect(await sync.enable({ path, label: 'NAS', password: 'master pass', includeSecrets: true, rememberPassword: false, create: true })).toMatchObject({ ok: true })
    const env = parseEnvelope(share.get('Nicolae/SSHSyncFile/sshbar-sync.json')!)
    expect(env.format).toBe('sshbar-vault')
  }, 20_000)

  it('explains what to do when the NAS password is gone from the phone', async () => {
    share.set('Nicolae/SSHSyncFile/sshbar-sync.json', JSON.stringify(desktop.encryptVault({ v: 1, at: 1, hosts: [], deleted: {}, secrets: {}, snippets: [], snippetsDeleted: {} }, await desktop.deriveKey('master pass', newKdf(2 ** 14)), newKdf(2 ** 14))))
    const { sync, settings } = await phone()
    const path = await smbChoose(NAS, 'Nicolae/SSHSyncFile/sshbar-sync.json')
    await settings.update({ fileSync: { ...settings.get().fileSync, enabled: true, path } })
    secure.delete(smbSecretKey(NAS))
    await sync.unlock('master pass', false).catch(() => undefined)
    expect(settings.get().fileSync.lastError).toMatch(/NAS password is no longer saved/)
  })
})
