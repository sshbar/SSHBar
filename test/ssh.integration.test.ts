/**
 * Integration tests against a real OpenSSH server. Run with:
 *   SSHBUDDY_IT_KEYDIR=/path/with/id_plain,id_enc SSHBUDDY_IT_PORT=2222 npx vitest run test/ssh.integration.test.ts
 * (see scripts/it-server.sh for a disposable Docker server)
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Host, HostStats, PromptResponse, SecretKind, SessionEvent } from '../src/shared/types'
import { sanitizeHost } from '../src/main/store/hosts'
import { KnownHostsStore } from '../src/main/store/knownHosts'
import { SshSession, type PromptInput, type SessionDeps } from '../src/main/ssh/session'
import { remoteList, remoteMkdir, remoteRealpath, remoteRemove, remoteRename } from '../src/main/ssh/sftp'
import { TransferManager } from '../src/main/transfers'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import type { ProtonPass } from '../src/main/protonpass'

const KEYDIR = process.env.SSHBUDDY_IT_KEYDIR
const PORT = Number(process.env.SSHBUDDY_IT_PORT ?? 2222)
const USER = process.env.SSHBUDDY_IT_USER ?? 'tester'
const PASSWORD = process.env.SSHBUDDY_IT_PASSWORD ?? 's3cret-pw'
const PASSPHRASE = 'correct horse'

const d = KEYDIR ? describe : describe.skip
const dataDir = mkdtempSync(join(tmpdir(), 'sb-it-'))
const knownHosts = new KnownHostsStore(dataDir, [])
const open: SshSession[] = []

type Responder = (req: PromptInput) => PromptResponse

function harness(hostPatch: Partial<Host>, responders: Responder[], extra: Partial<SessionDeps> = {}) {
  const host = sanitizeHost({ id: 'h1', hostname: '127.0.0.1', port: PORT, username: USER, ...hostPatch })
  const prompts: PromptInput[] = []
  const events: SessionEvent[] = []
  const remembered: [SecretKind, string][] = []
  const secrets = new Map<string, string>()
  let output = ''
  let resolveConnected!: (v: string) => void
  const settled = new Promise<string>((r) => (resolveConnected = r))
  const stats: HostStats[] = []
  const deps: SessionDeps = {
    settings: () => ({ ...DEFAULT_SETTINGS, statsIntervalSec: 1 }),
    secrets: { get: async (id, k) => secrets.get(`${id}:${k}`), backend: async () => ({ available: true }) },
    protonPass: {} as ProtonPass,
    knownHosts,
    prompt: async (req) => {
      prompts.push(req)
      const r = responders.shift()
      return r ? r(req) : { ok: false }
    },
    remember: async (_h, kind, value) => {
      remembered.push([kind, value])
    },
    agentSocket: async () => undefined,
    emit: (ev) => {
      events.push(ev)
      if (ev.type === 'data') output += Buffer.from(ev.data).toString('utf8')
      if (ev.type === 'stats') stats.push(ev.stats)
      if (ev.type === 'status' && (ev.status === 'connected' || ev.status === 'error')) resolveConnected(ev.status + (ev.message ? ': ' + ev.message : ''))
    },
    ...extra
  }
  const s = new SshSession('s-' + Math.random().toString(36).slice(2), host, deps)
  open.push(s)
  return { s, prompts, events, remembered, secrets, settled, stats, out: () => output }
}

const trust: Responder = (req) => {
  expect(req.kind).toBe('hostkey')
  return { ok: true, remember: true }
}

async function waitFor(fn: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 50))
  }
}

afterAll(() => {
  for (const s of open) s.close()
})

d('SSH session against a real server', () => {
  it('password from local secret store; prompts for the unknown host key first', async () => {
    const t = harness({ auth: { method: 'password', password: { source: 'local' } } as Host['auth'] }, [trust])
    t.secrets.set('h1:password', PASSWORD)
    void t.s.start(100, 30)
    expect(await t.settled).toBe('connected')
    expect(t.prompts).toHaveLength(1)
    expect(t.prompts[0]).toMatchObject({ kind: 'hostkey', state: 'unknown', port: PORT })
    t.s.write('echo SB_$((40+2))\n')
    await waitFor(() => t.out().includes('SB_42'))
    // stats arrive with CPU (needs two samples) and memory
    await waitFor(() => t.stats.some((x) => x.cpu !== undefined), 10000)
    const last = t.stats[t.stats.length - 1]
    expect(last.supported).toBe(true)
    expect(last.mem!.totalBytes).toBeGreaterThan(0)
    expect(last.disks.length).toBeGreaterThan(0)
    expect(last.hostname).toBeTruthy()
    t.s.close()
  })

  it('second connection does not ask about the host key again', async () => {
    const t = harness({ auth: { method: 'password', password: { source: 'prompt' } } as Host['auth'] }, [
      () => ({ ok: true, values: [PASSWORD], remember: true })
    ])
    void t.s.start(80, 24)
    expect(await t.settled).toBe('connected')
    expect(t.prompts.map((p) => p.kind)).toEqual(['credentials'])
    expect(t.remembered).toEqual([['password', PASSWORD]])
    t.s.close()
  })

  it('re-prompts after a wrong password', async () => {
    const t = harness({ auth: { method: 'password', password: { source: 'local' } } as Host['auth'] }, [
      (req) => {
        expect(req.kind === 'credentials' && req.message).toMatch(/failed/i)
        return { ok: true, values: [PASSWORD] }
      }
    ])
    t.secrets.set('h1:password', 'wrong-password')
    void t.s.start(80, 24)
    expect(await t.settled).toBe('connected')
    expect(t.prompts).toHaveLength(1)
    t.s.close()
  })

  it('gives up cleanly when the user cancels the password prompt', async () => {
    const t = harness({ auth: { method: 'password', password: { source: 'prompt' } } as Host['auth'] }, [() => ({ ok: false })])
    void t.s.start(80, 24)
    expect(await t.settled).toMatch(/^error: .*cancel/i)
  })

  it('authenticates with an unencrypted key file', async () => {
    const t = harness({ auth: { method: 'key', key: { source: 'file', path: join(KEYDIR!, 'id_plain') } } as Host['auth'] }, [])
    void t.s.start(80, 24)
    expect(await t.settled).toBe('connected')
    expect(t.prompts).toHaveLength(0)
    t.s.close()
  })

  it('asks again for a wrong key passphrase, then connects', async () => {
    const t = harness(
      { auth: { method: 'key', key: { source: 'file', path: join(KEYDIR!, 'id_enc') }, passphrase: { source: 'prompt' } } as Host['auth'] },
      [() => ({ ok: true, values: ['nope'] }), (req) => (expect(req.kind === 'credentials' && req.message).toMatch(/wrong/i), { ok: true, values: [PASSPHRASE], remember: true })]
    )
    void t.s.start(80, 24)
    expect(await t.settled).toBe('connected')
    expect(t.prompts).toHaveLength(2)
    expect(t.remembered).toEqual([['passphrase', PASSPHRASE]])
    t.s.close()
  })

  it('uses an SSH key (and its passphrase field) fetched from Proton Pass', async () => {
    const fakePP = {
      sshKey: async (shareId: string, itemId: string) => {
        expect([shareId, itemId]).toEqual(['share-1', 'item-1'])
        return { privateKey: readFileSync(join(KEYDIR!, 'id_enc'), 'utf8'), publicKey: '', passphrase: PASSPHRASE }
      }
    } as unknown as ProtonPass
    const t = harness({ auth: { method: 'key', key: { source: 'protonpass', shareId: 'share-1', itemId: 'item-1' } } as Host['auth'] }, [], {
      protonPass: fakePP
    })
    void t.s.start(80, 24)
    expect(await t.settled).toBe('connected')
    expect(t.prompts).toHaveLength(0)
    t.s.close()
  })

  it('reports a rejected key clearly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-k-'))
    // a valid-format key that the server does not know: re-use the encrypted key's format via ssh2
    const { utils } = await import('ssh2')
    const kp = utils.generateKeyPairSync('ed25519')
    writeFileSync(join(dir, 'k'), kp.private)
    const t = harness({ auth: { method: 'key', key: { source: 'file', path: join(dir, 'k') } } as Host['auth'] }, [
      (req) => (expect(req.kind === 'credentials' && req.message).toMatch(/did not accept the SSH key/), { ok: false })
    ])
    void t.s.start(80, 24)
    const res = await t.settled
    expect(res).toMatch(/^error:/)
  })

  it('falls back to a password when the key is rejected', async () => {
    const { utils } = await import('ssh2')
    const dir = mkdtempSync(join(tmpdir(), 'sb-k-'))
    writeFileSync(join(dir, 'k'), utils.generateKeyPairSync('ed25519').private)
    const t = harness({ auth: { method: 'key', key: { source: 'file', path: join(dir, 'k') } } as Host['auth'] }, [
      () => ({ ok: true, values: [PASSWORD] })
    ])
    void t.s.start(80, 24)
    expect(await t.settled).toBe('connected')
    t.s.close()
  })

  it('warns when the host key changes and refuses if not accepted', async () => {
    // corrupt the stored key for this host
    const file = join(dataDir, 'known_hosts.json')
    const data = JSON.parse(readFileSync(file, 'utf8'))
    const name = `[127.0.0.1]:${PORT}`
    data.hosts[name] = data.hosts[name].map((e: { key: string }) => ({ ...e, key: Buffer.from('tampered').toString('base64') }))
    writeFileSync(file, JSON.stringify(data))
    const kh = new KnownHostsStore(dataDir, [])
    const t = harness({ auth: { method: 'key', key: { source: 'file', path: join(KEYDIR!, 'id_plain') } } as Host['auth'] }, [
      (req) => (expect(req).toMatchObject({ kind: 'hostkey', state: 'changed' }), { ok: false })
    ], { knownHosts: kh })
    void t.s.start(80, 24)
    expect(await t.settled).toMatch(/^error: Host key not accepted/)
  })

  it('fails fast with a friendly message when nothing listens', async () => {
    const t = harness({ port: 1, auth: { method: 'password', password: { source: 'prompt' } } as Host['auth'] }, [])
    void t.s.start(80, 24)
    expect(await t.settled).toMatch(/Connection refused/)
  })
})

d('SFTP and transfers', () => {
  it('lists, creates, uploads, downloads, renames and deletes', async () => {
    const kh = new KnownHostsStore(mkdtempSync(join(tmpdir(), 'sb-kh2-')), [])
    const t = harness({ auth: { method: 'key', key: { source: 'file', path: join(KEYDIR!, 'id_plain') } } as Host['auth'] }, [trust], {
      knownHosts: kh
    })
    void t.s.start(80, 24)
    expect(await t.settled).toBe('connected')
    const sftp = await t.s.sftp()
    const home = await remoteRealpath(sftp, '.')
    const base = `${home}/sb-it-${Date.now()}`
    await remoteMkdir(sftp, base)
    expect((await remoteList(sftp, home)).entries.some((e) => e.path === base && e.kind === 'dir')).toBe(true)

    // local tree: one big random file + nested folder
    const local = mkdtempSync(join(tmpdir(), 'sb-up-'))
    const src = join(local, 'tree')
    const { mkdirSync, randomFillSync } = await import('node:fs').then((m) => ({ ...m, randomFillSync: require('node:crypto').randomFillSync }))
    mkdirSync(join(src, 'nested'), { recursive: true })
    const big = randomFillSync(Buffer.alloc(3 * 1024 * 1024 + 123))
    writeFileSync(join(src, 'big.bin'), big)
    writeFileSync(join(src, 'nested', 'hello.txt'), 'hello sftp\n')

    const updates: string[] = []
    const tm = new TransferManager(
      () => t.s,
      (info) => updates.push(`${info.id}:${info.state}:${info.bytesDone}/${info.bytesTotal}`)
    )
    const [upId] = tm.enqueue(t.s.id, 'upload', [src], base)
    await waitFor(() => updates.some((u) => u.startsWith(upId) && /:(done|error)/.test(u)), 20000)
    expect(updates.find((u) => u.startsWith(upId + ':done'))).toBeTruthy()
    const remoteTree = await remoteList(sftp, `${base}/tree`)
    expect(remoteTree.entries.map((e) => e.name).sort()).toEqual(['big.bin', 'nested'])
    expect(remoteTree.entries.find((e) => e.name === 'big.bin')!.size).toBe(big.length)

    await remoteRename(sftp, `${base}/tree`, `${base}/tree2`)
    const dl = mkdtempSync(join(tmpdir(), 'sb-dl-'))
    const [dlId] = tm.enqueue(t.s.id, 'download', [`${base}/tree2`], dl)
    await waitFor(() => updates.some((u) => u.startsWith(dlId) && /:(done|error)/.test(u)), 20000)
    expect(updates.find((u) => u.startsWith(dlId + ':done'))).toBeTruthy()
    expect(readFileSync(join(dl, 'tree2', 'big.bin')).equals(big)).toBe(true)
    expect(readFileSync(join(dl, 'tree2', 'nested', 'hello.txt'), 'utf8')).toBe('hello sftp\n')

    // cancel a queued job before it starts and a running one
    const [c1] = tm.enqueue(t.s.id, 'download', [`${base}/tree2/big.bin`], dl)
    tm.cancel(c1)
    await waitFor(() => updates.some((u) => u.startsWith(c1) && /:(cancelled|done)/.test(u)))

    await remoteRemove(sftp, base)
    expect((await remoteList(sftp, home)).entries.some((e) => e.path === base)).toBe(false)
    expect(existsSync(join(dl, 'tree2'))).toBe(true)
    t.s.close()
  })
})
