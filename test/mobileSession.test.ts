/**
 * The Android session orchestration (src/mobile/session.ts) against a scripted fake of the native
 * sshj bridge. The real bridge is exercised on a device; these tests pin down the policy:
 * host-key checks before any credential, auth order and fallbacks, device-only secrets, jump chains.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host, PromptResponse, SessionEvent } from '../src/shared/types'
import { sanitizeHost } from '../src/shared/hostModel'

type Call = { method: string; args: Record<string, unknown> }
const calls: Call[] = []
let script: Record<string, (args: Record<string, unknown>) => unknown> = {}

vi.mock('../src/mobile/native', () => {
  const handler = (method: string) => async (args: Record<string, unknown> = {}) => {
    calls.push({ method, args })
    const f = script[method]
    if (!f) return undefined
    return f(args)
  }
  return {
    Native: new Proxy({}, { get: (_t, prop: string) => handler(prop) }),
    nativeError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
    b64ToBytes: (s: string) => new TextEncoder().encode(atob(s))
  }
})

const { MobileSession } = await import('../src/mobile/session')
const { MobileKnownHosts } = await import('../src/mobile/stores')

const KEY = { keyType: 'ssh-ed25519', fingerprint: 'SHA256:abc', key: 'AAAAkey' }
const ok = { ok: true, allowed: [], partial: false }
const fail = (allowed: string[]) => ({ ok: false, allowed, partial: false })

function setup(hostPatch: Partial<Host>, answers: ((req: Record<string, unknown>) => PromptResponse)[], opts: { secrets?: Record<string, string>; hosts?: Host[] } = {}) {
  const host = sanitizeHost({ id: 'h1', label: 'web', hostname: 'web.example', username: 'deploy', ...hostPatch })
  const known = new MobileKnownHosts()
  const events: SessionEvent[] = []
  const prompts: Record<string, unknown>[] = []
  const remembered: string[] = []
  const all = new Map((opts.hosts ?? []).map((h) => [h.id, h]))
  all.set(host.id, host)
  let resolveDone!: (s: string) => void
  const done = new Promise<string>((r) => (resolveDone = r))
  const s = new MobileSession('s1', host, {
    getHost: (id) => all.get(id),
    knownHosts: known,
    secret: async (hostId, kind) => opts.secrets?.[`${hostId}:${kind}`],
    remember: async (_h, kind, value) => {
      remembered.push(`${kind}=${value}`)
    },
    saveUsername: async () => undefined,
    prompt: async (req) => {
      prompts.push(req as Record<string, unknown>)
      const a = answers.shift()
      return a ? a(req as Record<string, unknown>) : { ok: false }
    },
    emit: (ev) => {
      events.push(ev)
      if (ev.type === 'status' && (ev.status === 'connected' || ev.status === 'error')) resolveDone(ev.status + (ev.message ? `: ${ev.message}` : ''))
    },
    statsIntervalSec: () => 3
  })
  return { s, known, events, prompts, remembered, done }
}

const trust = (): PromptResponse => ({ ok: true, remember: true })
const methods = () => calls.map((c) => c.method)

beforeEach(() => {
  calls.length = 0
  script = { sshOpen: () => KEY, sshKeyInfo: () => ({ valid: true, needsPassphrase: false }) }
  vi.stubGlobal('localStorage', undefined)
})

describe('mobile session: host keys', () => {
  it('asks about an unknown key, stores it when trusted, and only then authenticates', async () => {
    script.sshAuthPassword = () => ok
    const t = setup({}, [trust, () => ({ ok: true, values: ['pw'] })])
    // writes to the known-hosts file go through Native.writeText (recorded, not persisted)
    void t.s.start(80, 24)
    expect(await t.done).toBe('connected')
    expect(t.prompts[0]).toMatchObject({ kind: 'hostkey', state: 'unknown', fingerprint: 'SHA256:abc' })
    const order = methods()
    expect(order.indexOf('sshOpen')).toBeLessThan(order.indexOf('sshAuthPassword'))
    expect(t.known.check('web.example', 22, 'ssh-ed25519', 'AAAAkey').state).toBe('trusted')
    expect(order).toContain('sshShell')
    expect(order).toContain('sshExec') // live stats
  })

  it('never sends a credential when the host key is rejected', async () => {
    const t = setup({}, [() => ({ ok: false })])
    void t.s.start(80, 24)
    expect(await t.done).toMatch(/^error: Host key not accepted/)
    expect(methods().filter((m) => m.startsWith('sshAuth'))).toEqual([])
    expect(methods()).toContain('sshClose')
  })

  it('warns when a trusted host presents a different key', async () => {
    const t = setup({}, [() => ({ ok: false })])
    await t.known.trust('web.example', 22, 'ssh-ed25519', 'OTHERkey', 'SHA256:old')
    void t.s.start(80, 24)
    await t.done
    expect(t.prompts[0]).toMatchObject({ kind: 'hostkey', state: 'changed', knownFingerprints: ['SHA256:old'] })
  })
})

describe('mobile session: authentication', () => {
  it('uses a password saved on the phone even when the shared host uses Proton Pass', async () => {
    script.sshAuthPassword = () => ok
    const t = setup({ auth: { method: 'password', password: { source: 'protonpass', shareId: 's', itemId: 'i' } } as Host['auth'] }, [trust], {
      secrets: { 'h1:password': 'from-phone' }
    })
    void t.s.start(80, 24)
    expect(await t.done).toBe('connected')
    expect(calls.find((c) => c.method === 'sshAuthPassword')?.args.password).toBe('from-phone')
  })

  it('re-prompts after a wrong password and remembers on request', async () => {
    let n = 0
    script.sshAuthPassword = () => (++n === 1 ? fail(['password', 'publickey']) : ok)
    const t = setup({}, [trust, () => ({ ok: true, values: ['wrong'] }), (req) => (expect(req.message).toMatch(/failed/i), { ok: true, values: ['right'], remember: true })])
    void t.s.start(80, 24)
    expect(await t.done).toBe('connected')
    expect(t.remembered).toEqual(['password=right'])
  })

  it('falls back to keyboard-interactive when the server has no password method', async () => {
    script.sshAuthPassword = () => fail(['publickey', 'keyboard-interactive'])
    script.sshAuthKeyboard = () => ok
    const t = setup({}, [trust, () => ({ ok: true, values: ['pw'] })])
    void t.s.start(80, 24)
    expect(await t.done).toBe('connected')
    // a single hidden "Password:" prompt is answered with the password typed before
    expect(await t.s.answerKeyboard('', 'Password:', false)).toBe('pw')
    // anything else goes to the user
    expect(t.s.answerKeyboard('2FA', 'Code:', true)).toBeInstanceOf(Promise)
  })

  it('uses a key saved on the phone, asking for its passphrase until it works', async () => {
    script.sshKeyInfo = (a) => (a.passphrase === undefined ? { valid: false, needsPassphrase: true } : { valid: a.passphrase === 'good', needsPassphrase: true })
    script.sshAuthKey = () => ok
    const t = setup({ auth: { method: 'key', key: { source: 'file', path: '~/.ssh/id_ed25519' } } as Host['auth'] }, [trust, () => ({ ok: true, values: ['bad'] }), (r) => (expect(r.message).toMatch(/wrong/i), { ok: true, values: ['good'] })], {
      secrets: { 'h1:key': 'PRIVATE' }
    })
    void t.s.start(80, 24)
    expect(await t.done).toBe('connected')
    expect(calls.find((c) => c.method === 'sshAuthKey')?.args).toMatchObject({ privateKey: 'PRIVATE', passphrase: 'good' })
  })

  it('explains what to do when a computer key file is not on the phone', async () => {
    const t = setup({ auth: { method: 'key', key: { source: 'file', path: '~/.ssh/id_ed25519' } } as Host['auth'] }, [trust])
    void t.s.start(80, 24)
    expect(await t.done).toMatch(/key file ~\/\.ssh\/id_ed25519 on your computer.*paste the key/)
  })

  it('offers a password when the key is rejected', async () => {
    script.sshAuthKey = () => fail(['password'])
    script.sshAuthPassword = () => ok
    const t = setup({ auth: { method: 'key', key: { source: 'local' } } as Host['auth'] }, [trust, (r) => (expect(r.message).toMatch(/did not accept the SSH key/), { ok: true, values: ['pw'] })], {
      secrets: { 'h1:key': 'PRIVATE' }
    })
    void t.s.start(80, 24)
    expect(await t.done).toBe('connected')
  })

  it('reports agents as unavailable on Android', async () => {
    const t = setup({ auth: { method: 'agent', agent: 'system' } as Host['auth'] }, [trust])
    void t.s.start(80, 24)
    expect(await t.done).toMatch(/agents are not available on Android/)
  })
})

describe('mobile session: jump hosts and stats', () => {
  it('opens the jump host first, then tunnels to the target through it', async () => {
    script.sshAuthPassword = () => ok
    const bastion = sanitizeHost({ id: 'b', label: 'bastion', hostname: 'bastion.example', username: 'ops' })
    const t = setup({ jumpHostId: 'b', hostname: 'private.lan' }, [trust, () => ({ ok: true, values: ['pw-b'] }), trust, () => ({ ok: true, values: ['pw-t'] })], {
      hosts: [bastion]
    })
    void t.s.start(80, 24)
    expect(await t.done).toBe('connected')
    const opens = calls.filter((c) => c.method === 'sshOpen').map((c) => c.args)
    expect(opens[0]).toMatchObject({ host: 'bastion.example', viaId: undefined })
    expect(opens[1]).toMatchObject({ host: 'private.lan', viaId: opens[0].id })
    // closing the session closes the target and the jump connection
    t.s.close()
    expect(calls.filter((c) => c.method === 'sshClose').map((c) => c.args.id)).toEqual(['s1', opens[0].id])
  })

  it('attributes jump host failures and detects loops', async () => {
    script.sshOpen = (a) => (a.host === 'bastion.example' ? Promise.reject(new Error('Connection refused (bastion.example:22)')) : KEY)
    const bastion = sanitizeHost({ id: 'b', label: 'bastion', hostname: 'bastion.example', username: 'ops' })
    const t = setup({ jumpHostId: 'b' }, [], { hosts: [bastion] })
    void t.s.start(80, 24)
    expect(await t.done).toMatch(/^error: Jump host bastion: Connection refused/)

    const loopA = sanitizeHost({ id: 'a', label: 'A', hostname: 'a.example', username: 'u', jumpHostId: 'h1' })
    const t2 = setup({ jumpHostId: 'a' }, [], { hosts: [loopA] })
    void t2.s.start(80, 24)
    expect(await t2.done).toMatch(/loop/i)
  })

  it('turns the stats stream into stats events', async () => {
    script.sshAuthPassword = () => ok
    const t = setup({}, [trust, () => ({ ok: true, values: ['pw'] })])
    void t.s.start(80, 24)
    await t.done
    const execId = calls.find((c) => c.method === 'sshExec')!.args.execId as string
    t.s.onExecData(execId, '@@info\nLinux 6.8\nweb-1\nPRETTY_NAME="Debian"\n@@disk\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 500 500 50% /\n@@end\n')
    const stats = t.events.find((e) => e.type === 'stats') as Extract<SessionEvent, { type: 'stats' }>
    expect(stats.stats).toMatchObject({ hostname: 'web-1', os: 'Debian', disks: [{ mount: '/' }] })
  })
})
