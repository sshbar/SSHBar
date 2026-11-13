/**
 * Integration tests against a real OpenSSH server. Run with:
 *   SSHBAR_IT_KEYDIR=/path/with/id_plain,id_enc SSHBAR_IT_PORT=2222 npx vitest run test/ssh.integration.test.ts
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

const KEYDIR = process.env.SSHBAR_IT_KEYDIR
const PORT = Number(process.env.SSHBAR_IT_PORT ?? 2222)
const USER = process.env.SSHBAR_IT_USER ?? 'tester'
const PASSWORD = process.env.SSHBAR_IT_PASSWORD ?? 's3cret-pw'
const PASSPHRASE = 'correct horse'

const d = KEYDIR ? describe : describe.skip
/** set SSHBAR_IT_JUMP=1 when scripts/it-server.sh also started the private "sb-target" server */
const dj = KEYDIR && process.env.SSHBAR_IT_JUMP ? describe : describe.skip
const dataDir = mkdtempSync(join(tmpdir(), 'sb-it-'))
const savedHosts = new Map<string, Host>()
const knownHosts = new KnownHostsStore(dataDir, [])
const open: SshSession[] = []

type Responder = (req: PromptInput) => PromptResponse

function harness(hostPatch: Partial<Host>, responders: Responder[], extra: Partial<SessionDeps> = {}) {
  const host = sanitizeHost({ id: 'h1', hostname: '127.0.0.1', port: PORT, username: USER, ...hostPatch })
  const prompts: PromptInput[] = []
  const events: SessionEvent[] = []
  const remembered: [SecretKind, string][] = []
  const savedUsernames: string[] = []
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
    getHost: (id) => savedHosts.get(id),
    saveUsername: async (_h, u) => {
      savedUsernames.push(u)
    },
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
  return { s, prompts, events, remembered, savedUsernames, secrets, settled, stats, out: () => output }
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

const keyAuth = (file = 'id_plain'): Host['auth'] => ({ method: 'key', key: { source: 'file', path: join(KEYDIR!, file) } }) as Host['auth']

dj('jump hosts (ProxyJump)', () => {
  const bastion = (): Host => sanitizeHost({ id: 'bastion', label: 'bastion', hostname: '127.0.0.1', port: PORT, username: USER, auth: keyAuth() })
  const target = (): Partial<Host> => ({ id: 'h1', label: 'private', hostname: 'sb-target', port: 2222, jumpHostId: 'bastion', auth: keyAuth() })

  it('the private target is not reachable directly', async () => {
    const t = harness({ hostname: 'sb-target', port: 2222, auth: keyAuth() }, [])
    void t.s.start(80, 24)
    expect(await t.settled).toMatch(/^error: .*(not found|resolve|refused|unreachable|timed out)/i)
  })

  it('connects through the bastion, verifying both host keys', async () => {
    savedHosts.set('bastion', bastion())
    const kh = new KnownHostsStore(mkdtempSync(join(tmpdir(), 'sb-khj-')), [])
    const t = harness(target(), [trust, trust], { knownHosts: kh })
    void t.s.start(80, 24)
    expect(await t.settled).toBe('connected')
    expect(t.prompts.map((p) => (p.kind === 'hostkey' ? `${p.host}:${p.port}` : p.kind))).toEqual([`127.0.0.1:${PORT}`, 'sb-target:2222'])
    expect(t.events.some((e) => e.type === 'status' && /via bastion/.test(e.message ?? ''))).toBe(true)
    t.s.write('echo HOST=$(hostname)\n')
    await waitFor(() => t.out().includes('HOST=sb-target'))
    await waitFor(() => t.stats.some((x) => x.hostname === 'sb-target'), 10000)
    // SFTP rides the same tunnelled connection
    const sftp = await t.s.sftp()
    expect((await remoteList(sftp, await remoteRealpath(sftp, '.'))).entries.length).toBeGreaterThan(0)

    // if the bastion drops, the tunnelled session closes with a clear reason
    ;(t.s as unknown as { jump: SshSession }).jump.close('test drop')
    await waitFor(() => t.events.some((e) => e.type === 'closed'))
    const closed = t.events.find((e) => e.type === 'closed') as Extract<SessionEvent, { type: 'closed' }>
    expect(closed.reason).toMatch(/Jump host bastion disconnected|closed/i)
  })

  it('attributes failures to the jump host', async () => {
    savedHosts.set('bastion', sanitizeHost({ ...bastion(), auth: keyAuth('does-not-exist') }))
    const t = harness(target(), [() => ({ ok: false })])
    void t.s.start(80, 24)
    expect(await t.settled).toMatch(/^error: Jump host bastion: Cannot read key file/)
    savedHosts.set('bastion', bastion())
  })

  it('detects loops and missing jump hosts', async () => {
    savedHosts.set('a', sanitizeHost({ id: 'a', label: 'A', hostname: '127.0.0.1', port: PORT, username: USER, jumpHostId: 'b', auth: keyAuth() }))
    savedHosts.set('b', sanitizeHost({ id: 'b', label: 'B', hostname: '127.0.0.1', port: PORT, username: USER, jumpHostId: 'a', auth: keyAuth() }))
    const loop = harness({ ...target(), jumpHostId: 'a' }, [])
    void loop.s.start(80, 24)
    expect(await loop.settled).toMatch(/loop/i)
    const missing = harness({ ...target(), jumpHostId: 'gone' }, [])
    void missing.s.start(80, 24)
    expect(await missing.settled).toMatch(/no longer exists/)
  })

  it('asks for a missing username and can save it', async () => {
    const t = harness({ username: '', auth: keyAuth() }, [
      (req) => (expect(req).toMatchObject({ kind: 'credentials', allowRemember: true }), { ok: true, values: [USER], remember: true })
    ])
    void t.s.start(80, 24)
    expect(await t.settled).toBe('connected')
    expect(t.savedUsernames).toEqual([USER])
    t.s.close()
  })
})

// ---------------------------------------------------------------------------
// Port forwarding (needs AllowTcpForwarding on the server: scripts/it-server.sh enables it)
// ---------------------------------------------------------------------------
dj('port forwarding', () => {
  const net = require('node:net') as typeof import('node:net')

  /** connect to host:port and resolve with the first line received */
  const firstLine = (port: number, send?: Buffer, host = '127.0.0.1'): Promise<string> =>
    new Promise((resolve, reject) => {
      const s = net.connect(port, host)
      let data = Buffer.alloc(0)
      s.on('connect', () => send && s.write(send))
      s.on('data', (d) => {
        data = Buffer.concat([data, d])
        const i = data.indexOf('\n')
        if (i >= 0) {
          resolve(data.subarray(0, i).toString().trim())
          s.destroy()
        }
      })
      s.on('error', reject)
      setTimeout(() => reject(new Error('no data')), 5000)
    })

  async function connected(forwards: Host['forwards'] = []) {
    const t = harness({ auth: keyAuth(), forwards }, [trust, trust])
    void t.s.start(80, 24)
    expect(await t.settled).toBe('connected')
    return t
  }

  it('local forward (-L) reaches a server-side service', async () => {
    const t = await connected()
    const st = await t.s.startForward({ id: 'l1', type: 'local', label: '', bindAddress: '127.0.0.1', bindPort: 0, destHost: 'sb-target', destPort: 2222, autoStart: false })
    expect(st).toMatchObject({ status: 'active' })
    expect(await firstLine(st.boundPort!)).toMatch(/^SSH-2\.0-OpenSSH/)
    // stopping closes the listener
    t.s.stopForward('l1')
    await expect(firstLine(st.boundPort!)).rejects.toThrow()
    t.s.close()
  })

  it('reports a local port that is already taken', async () => {
    const blocker = net.createServer().listen(0, '127.0.0.1')
    await new Promise((r) => blocker.once('listening', r))
    const busy = (blocker.address() as import('node:net').AddressInfo).port
    const t = await connected()
    const st = await t.s.startForward({ id: 'l2', type: 'local', label: '', bindAddress: '127.0.0.1', bindPort: busy, destHost: '127.0.0.1', destPort: 2222, autoStart: false })
    expect(st).toMatchObject({ status: 'error' })
    expect(st.error).toMatch(/already in use/)
    blocker.close()
    t.s.close()
  })

  it('remote forward (-R) lets the server reach a service on this computer', async () => {
    const echo = net.createServer((s) => s.on('data', (d) => s.end('pong ' + d.toString())))
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()))
    const localPort = (echo.address() as import('node:net').AddressInfo).port
    const t = await connected()
    const st = await t.s.startForward({ id: 'r1', type: 'remote', label: '', bindAddress: '127.0.0.1', bindPort: 0, destHost: '127.0.0.1', destPort: localPort, autoStart: false })
    expect(st).toMatchObject({ status: 'active' })
    expect(st.boundPort).toBeGreaterThan(0)
    const out = await new Promise<string>((resolve, reject) => {
      t.s.client.exec(`bash -c 'exec 3<>/dev/tcp/127.0.0.1/${st.boundPort}; echo ping >&3; cat <&3'`, (err, ch) => {
        if (err) return reject(err)
        let o = ''
        ch.on('data', (d: Buffer) => (o += d.toString()))
        ch.on('close', () => resolve(o.trim()))
      })
    })
    expect(out).toBe('pong ping')
    echo.close()
    t.s.close()
  })

  it('dynamic forward (-D) is a working SOCKS5 proxy with server-side name resolution', async () => {
    const t = await connected()
    const st = await t.s.startForward({ id: 'd1', type: 'dynamic', label: '', bindAddress: '127.0.0.1', bindPort: 0, destHost: '', destPort: 0, autoStart: false })
    expect(st).toMatchObject({ status: 'active' })
    const viaSocks = (atyp: 'domain' | 'ipv4', host: string, port: number): Promise<{ reply: number; line: string }> =>
      new Promise((resolve, reject) => {
        const s = net.connect(st.boundPort!, '127.0.0.1')
        let stage = 0
        let buf = Buffer.alloc(0)
        s.on('connect', () => s.write(Buffer.from([5, 1, 0])))
        s.on('data', (d) => {
          buf = Buffer.concat([buf, d])
          if (stage === 0 && buf.length >= 2) {
            expect([...buf.subarray(0, 2)]).toEqual([5, 0])
            buf = buf.subarray(2)
            stage = 1
            const p = Buffer.alloc(2)
            p.writeUInt16BE(port)
            const addr = atyp === 'domain' ? Buffer.concat([Buffer.from([3, host.length]), Buffer.from(host)]) : Buffer.from([1, ...host.split('.').map(Number)])
            s.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, p]))
          }
          if (stage === 1 && buf.length >= 10) {
            const reply = buf[1]
            buf = buf.subarray(10)
            stage = 2
            if (reply !== 0) {
              resolve({ reply, line: '' })
              s.destroy()
            }
          }
          if (stage === 2) {
            const i = buf.indexOf('\n')
            if (i >= 0) {
              resolve({ reply: 0, line: buf.subarray(0, i).toString().trim() })
              s.destroy()
            }
          }
        })
        s.on('error', reject)
        setTimeout(() => reject(new Error('socks timeout')), 6000)
      })
    expect(await viaSocks('domain', 'sb-target', 2222)).toMatchObject({ reply: 0, line: expect.stringMatching(/^SSH-2\.0/) })
    expect(await viaSocks('ipv4', '127.0.0.1', 2222)).toMatchObject({ reply: 0, line: expect.stringMatching(/^SSH-2\.0/) })
    expect((await viaSocks('ipv4', '127.0.0.1', 1)).reply).not.toBe(0)
    t.s.close()
  })

  it('starts saved forwards automatically on connect and stops them on disconnect', async () => {
    const changes: string[] = []
    const t = await connected([
      { id: 'auto', type: 'local', label: 'db', bindAddress: '127.0.0.1', bindPort: 0, destHost: '127.0.0.1', destPort: 2222, autoStart: true },
      { id: 'manual', type: 'local', label: 'off', bindAddress: '127.0.0.1', bindPort: 0, destHost: '127.0.0.1', destPort: 2222, autoStart: false }
    ])
    await waitFor(() => t.s.listForwards().some((f) => f.id === 'auto' && f.status === 'active'))
    expect(t.s.listForwards().map((f) => f.id)).toEqual(['auto'])
    const port = t.s.listForwards()[0].boundPort!
    expect(await firstLine(port)).toMatch(/^SSH-2\.0/)
    t.events.filter((e) => e.type === 'forwards').forEach(() => changes.push('x'))
    expect(changes.length).toBeGreaterThan(0)
    t.s.close()
    await expect(firstLine(port)).rejects.toThrow()
  })
})
