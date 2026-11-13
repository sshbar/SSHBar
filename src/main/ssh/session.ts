import { promises as fs } from 'node:fs'
import { connect as netConnect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { homedir } from 'node:os'
import { Client, utils, type ClientChannel, type SFTPWrapper, type AnyAuthMethod, type Prompt } from 'ssh2'
import type { Host, PromptRequest, PromptResponse, SecretKind, SessionEvent, SessionStatus, Settings } from '../../shared/types'
import type { KnownHostsStore } from '../store/knownHosts'
import { fingerprint, keyTypeOf } from '../store/knownHosts'
import type { ProtonPass } from '../protonpass'
import { StatsParser, statsCommand } from './stats'

export type PromptInput = PromptRequest extends infer T ? (T extends { id: string } ? Omit<T, 'id'> : never) : never

export interface SessionDeps {
  settings: () => Settings
  secrets: { get(hostId: string, kind: SecretKind): Promise<string | undefined>; backend(): Promise<{ available: boolean }> }
  protonPass: ProtonPass
  knownHosts: KnownHostsStore
  prompt(req: PromptInput): Promise<PromptResponse>
  /** Called after successful authentication for credentials the user asked to save. */
  remember(host: Host, kind: SecretKind, value: string): Promise<void>
  agentSocket(host: Host): Promise<string | undefined>
  /** Look up another saved host (jump hosts). */
  getHost(id: string): Host | undefined
  /** Persist a username the user typed at connect time and asked to keep. */
  saveUsername(host: Host, username: string): Promise<void>
  emit(ev: SessionEvent): void
}

class CancelledError extends Error {
  constructor() {
    super('Cancelled')
  }
}

const CONNECT_TIMEOUT_MS = 15_000
const HANDSHAKE_TIMEOUT_MS = 20_000
const MAX_TRIES = 3
const MAX_HOPS = 8
const TUNNEL_TIMEOUT_MS = 20_000

export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return homedir() + p.slice(1)
  return p
}

function isEncryptedKeyError(e: Error): boolean {
  return /passphrase/i.test(e.message)
}

/**
 * One SSH connection: an interactive shell, a lazily opened SFTP channel for browsing and a
 * stats channel. Contains no Electron code so it can be exercised in tests against a real server.
 */
export class SshSession {
  readonly client = new Client()
  status: SessionStatus = 'connecting'
  private sock?: Socket | Duplex
  /** Connection to the jump host this session is tunnelled through, if any. */
  private jump?: SshSession
  private saveUsernameAfterAuth = false
  private shell?: ClientChannel
  private browseSftp?: Promise<SFTPWrapper>
  private statsChannel?: ClientChannel
  private closed = false
  private pendingRemember: { kind: SecretKind; value: string }[] = []
  private username: string
  private handshakeTimer?: NodeJS.Timeout
  private lastError = ''
  /** Latest terminal size requested by the UI (may arrive before the shell exists). */
  private size = { cols: 80, rows: 24 }

  constructor(
    readonly id: string,
    readonly host: Host,
    private deps: SessionDeps
  ) {
    this.username = host.username
  }

  private setStatus(status: SessionStatus, message?: string): void {
    if (this.closed && status !== 'closed' && status !== 'error') return
    this.status = status
    this.deps.emit({ type: 'status', sessionId: this.id, status, message })
  }

  private async ask(req: PromptInput): Promise<PromptResponse> {
    // Don't let the handshake timeout fire while a human is reading a dialog.
    this.clearHandshakeTimer()
    const res = await this.deps.prompt({ ...req, sessionId: this.id } as PromptInput)
    if (this.closed) throw new CancelledError()
    return res
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.handshakeTimer = undefined
  }

  async start(cols: number, rows: number): Promise<void> {
    try {
      await this.establish(new Set())
      if (!this.sizeSet) this.size = { cols, rows }
      await this.openShell(this.size.cols, this.size.rows)
      this.setStatus('connected')
      this.startStats()
    } catch (e) {
      const msg = e instanceof CancelledError ? 'Connection cancelled' : this.lastError || (e as Error).message
      this.fail(msg)
    }
  }

  /**
   * Open an authenticated SSH transport to this host. When the host has a jump host, that host is
   * connected first (recursively, so chains work) and this connection runs inside a tunnel through it.
   * Jump hosts only ever get this transport — never a shell or stats channel.
   */
  async establish(chain: Set<string>): Promise<void> {
    chain.add(this.host.id)
    if (!this.username) {
      const res = await this.ask({
        kind: 'credentials',
        title: `Username for ${this.host.label}`,
        message: this.host.label !== this.host.hostname ? this.host.hostname : '',
        fields: [{ label: 'Username', secret: false }],
        allowRemember: true,
        rememberLabel: 'Save this username for the host'
      })
      if (!res.ok || !res.values?.[0]) throw new CancelledError()
      this.username = res.values[0].trim()
      this.saveUsernameAfterAuth = Boolean(res.remember)
    }

    const jumpId = this.host.jumpHostId
    if (jumpId) {
      const jumpHost = this.deps.getHost(jumpId)
      if (!jumpHost) throw new Error(`The jump host configured for ${this.host.label} no longer exists`)
      if (chain.has(jumpId)) throw new Error(`Jump host loop: ${jumpHost.label} is already part of this connection chain`)
      if (chain.size >= MAX_HOPS) throw new Error('Too many jump hosts in the chain')
      this.jump = new SshSession(this.id, jumpHost, { ...this.deps, emit: (ev) => this.onJumpEvent(jumpHost, ev) })
      try {
        await this.jump.establish(chain)
      } catch (e) {
        if (e instanceof CancelledError) throw e
        throw new Error(`Jump host ${jumpHost.label}: ${(e as Error).message}`)
      }
      if (this.closed) throw new CancelledError()
      this.setStatus('connecting', `Connecting to ${this.host.hostname}:${this.host.port} via ${jumpHost.label}…`)
      this.sock = await this.jump.forwardOut(this.host.hostname, this.host.port)
    } else {
      this.setStatus('connecting', `Connecting to ${this.host.hostname}:${this.host.port}…`)
      this.sock = await this.openSocket()
    }

    await this.handshake()
    for (const r of this.pendingRemember.splice(0)) {
      await this.deps.remember(this.host, r.kind, r.value).catch(() => undefined)
    }
    if (this.saveUsernameAfterAuth) await this.deps.saveUsername(this.host, this.username).catch(() => undefined)
  }

  /** Progress and failures of the jump connection surface on this session. */
  private onJumpEvent(jumpHost: Host, ev: SessionEvent): void {
    if (ev.type === 'status' && (ev.status === 'connecting' || ev.status === 'authenticating')) {
      this.setStatus(ev.status, `${jumpHost.label}: ${ev.message ?? ''}`)
    } else if (ev.type === 'closed' && !this.closed && this.status === 'connected') {
      // everything tunnelled through the jump host is gone with it
      this.close(`Jump host ${jumpHost.label} disconnected${ev.reason ? `: ${ev.reason}` : ''}`)
    }
  }

  /** Open a direct-tcpip channel from this (already authenticated) host to another address. */
  forwardOut(host: string, port: number): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.host.label} timed out reaching ${host}:${port}`)), TUNNEL_TIMEOUT_MS)
      this.client.forwardOut('127.0.0.1', 0, host, port, (err, ch) => {
        clearTimeout(timer)
        if (!err) return resolve(ch)
        const hint = /prohibited/i.test(err.message) ? ' (TCP forwarding is disabled on that server: AllowTcpForwarding)' : ''
        reject(new Error(`${this.host.label} could not reach ${host}:${port}: ${err.message}${hint}`))
      })
    })
  }

  private openSocket(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const sock = netConnect({ host: this.host.hostname, port: this.host.port })
      const timer = setTimeout(() => {
        sock.destroy()
        reject(new Error(`Connection to ${this.host.hostname}:${this.host.port} timed out`))
      }, CONNECT_TIMEOUT_MS)
      sock.once('connect', () => {
        clearTimeout(timer)
        sock.setNoDelay(true)
        resolve(sock)
      })
      sock.once('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        const friendly: Record<string, string> = {
          ECONNREFUSED: 'Connection refused',
          ENOTFOUND: 'Host not found',
          EAI_AGAIN: 'Could not resolve the host name',
          EAI_NONAME: 'Host not found',
          EHOSTUNREACH: 'Host unreachable',
          ENETUNREACH: 'Network unreachable',
          ETIMEDOUT: 'Connection timed out'
        }
        reject(new Error(err.code && friendly[err.code] ? `${friendly[err.code]} (${this.host.hostname}:${this.host.port})` : err.message))
      })
    })
  }

  private handshake(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const done = (err?: Error): void => {
        if (settled) return
        settled = true
        this.clearHandshakeTimer()
        if (err) reject(err)
        else resolve()
      }
      this.handshakeTimer = setTimeout(() => {
        done(new Error('The server did not complete the SSH handshake in time'))
        this.client.end()
      }, HANDSHAKE_TIMEOUT_MS)

      this.client.once('ready', () => done())
      this.client.on('error', (err: Error & { level?: string }) => {
        if (!settled) {
          if (err.level === 'client-authentication') done(new Error(this.lastError || 'Authentication failed'))
          else done(new Error(this.lastError || err.message))
        } else if (!this.closed) {
          this.fail(err.message)
        }
      })
      this.client.on('close', () => {
        if (!settled) done(new Error(this.lastError || 'Connection closed by server'))
        else this.handleClose()
      })
      this.client.on('banner', (msg: string) => {
        this.deps.emit({ type: 'data', sessionId: this.id, data: new TextEncoder().encode(msg.replace(/\r?\n/g, '\r\n')) })
      })

      this.client.connect({
        sock: this.sock,
        username: this.username,
        readyTimeout: 10 * 60_000, // our own timers handle network stalls; this only bounds human prompts
        keepaliveInterval: 15_000,
        keepaliveCountMax: 4,
        hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
          this.verifyHostKey(key).then(verify, (e) => {
            this.lastError = e instanceof CancelledError ? 'Host key not accepted' : (e as Error).message
            verify(false)
          })
        },
        authHandler: (methodsLeft, partialSuccess, next) => {
          this.setStatus('authenticating', 'Authenticating…')
          this.nextAuth(methodsLeft, partialSuccess).then(
            (m) => next(m as AnyAuthMethod),
            (e) => {
              this.lastError = e instanceof CancelledError ? 'Authentication cancelled' : (e as Error).message
              next(false as unknown as AnyAuthMethod)
            }
          )
        }
      })
    })
  }

  // ---------- host key verification ----------

  private async verifyHostKey(key: Buffer): Promise<boolean> {
    const { hostname, port } = this.host
    const check = this.deps.knownHosts.check(hostname, port, key)
    if (check.state === 'trusted') return true
    const res = await this.ask({
      kind: 'hostkey',
      host: hostname,
      port,
      keyType: keyTypeOf(key),
      fingerprint: fingerprint(key),
      state: check.state,
      knownFingerprints: check.state === 'changed' ? check.known : []
    })
    if (!res.ok) throw new CancelledError()
    if (res.remember) await this.deps.knownHosts.trust(hostname, port, key)
    // restart the stall timer now that the user has answered
    this.handshakeTimer = setTimeout(() => {
      this.lastError = 'The server did not complete the SSH handshake in time'
      this.client.end()
    }, HANDSHAKE_TIMEOUT_MS)
    return true
  }

  // ---------- authentication ----------

  private triedKey = false
  private triedAgent = false
  private passwordTries = 0
  private kbdTries = 0
  private passwordUsed?: string

  private async nextAuth(methodsLeft: string[] | null, _partialSuccess: boolean | null): Promise<AnyAuthMethod | false> {
    const can = (m: string): boolean => !methodsLeft || methodsLeft.includes(m)
    const username = this.username
    const auth = this.host.auth

    if (auth.method === 'key' && !this.triedKey && can('publickey')) {
      this.triedKey = true
      const k = await this.loadKey()
      return { type: 'publickey', username, key: k.key, passphrase: k.passphrase }
    }

    if (auth.method === 'agent' && !this.triedAgent && can('publickey')) {
      this.triedAgent = true
      const sock = await this.deps.agentSocket(this.host)
      if (!sock) throw new Error('No SSH agent found. Start one or choose another authentication method.')
      return { type: 'agent', username, agent: sock }
    }

    // Like OpenSSH: if the key/agent was rejected, fall back to asking for a password.
    const keyFailed = (auth.method === 'key' && this.triedKey) || (auth.method === 'agent' && this.triedAgent)
    if ((auth.method === 'password' || keyFailed) && can('password') && this.passwordTries < MAX_TRIES) {
      const note = keyFailed && this.passwordTries === 0 ? 'The server did not accept the SSH key. You can log in with a password instead.' : undefined
      const pw = await this.getPassword(this.passwordTries > 0 || keyFailed, note)
      this.passwordTries++
      this.passwordUsed = pw
      return { type: 'password', username, password: pw }
    }

    if (can('keyboard-interactive') && this.kbdTries < MAX_TRIES) {
      this.kbdTries++
      return {
        type: 'keyboard-interactive',
        username,
        prompt: (_name: string, instructions: string, _lang: string, prompts: Prompt[], finish: (answers: string[]) => void) => {
          this.answerKeyboardInteractive(instructions, prompts).then(finish, () => finish([]))
        }
      }
    }

    if (auth.method === 'key' && this.triedKey) throw new Error('The server rejected the SSH key')
    if (auth.method === 'agent' && this.triedAgent) throw new Error('The server rejected all keys offered by the SSH agent')
    if (auth.method === 'password' && this.passwordTries > 0) throw new Error('Authentication failed: wrong username or password')
    throw new Error(`The server does not accept this authentication method (offers: ${(methodsLeft ?? []).join(', ') || 'none'})`)
  }

  private async answerKeyboardInteractive(instructions: string, prompts: Prompt[]): Promise<string[]> {
    if (prompts.length === 0) return []
    // A single hidden "Password:" prompt can be answered with the stored password, once.
    if (
      this.host.auth.method === 'password' &&
      this.kbdTries === 1 &&
      prompts.length === 1 &&
      !prompts[0].echo &&
      /password/i.test(prompts[0].prompt)
    ) {
      const pw = this.passwordUsed ?? (await this.getPassword(false))
      return [pw]
    }
    const res = await this.ask({
      kind: 'credentials',
      title: `${this.username}@${this.host.hostname}`,
      message: instructions || 'The server requires additional verification.',
      fields: prompts.map((p) => ({ label: p.prompt.trim().replace(/:$/, ''), secret: !p.echo })),
      allowRemember: false
    })
    if (!res.ok) throw new CancelledError()
    return res.values ?? []
  }

  private async getPassword(retry: boolean, reason?: string): Promise<string> {
    const ref = this.host.auth.password
    let note = reason ?? (retry ? 'Authentication failed. Try again.' : '')
    if (!retry) {
      if (ref.source === 'local') {
        const v = await this.deps.secrets.get(this.host.id, 'password')
        if (v) return v
        note = 'No password is saved on this device.'
      } else if (ref.source === 'protonpass') {
        this.setStatus('authenticating', 'Fetching password from Proton Pass…')
        try {
          return await this.deps.protonPass.password(ref.shareId, ref.itemId)
        } catch (e) {
          note = `Proton Pass: ${(e as Error).message}`
        }
      }
    }
    const res = await this.ask({
      kind: 'credentials',
      title: `Password for ${this.username}@${this.host.hostname}`,
      message: note,
      fields: [{ label: 'Password', secret: true }],
      allowRemember: (await this.deps.secrets.backend()).available && ref.source !== 'protonpass' && this.host.auth.method === 'password'
    })
    if (!res.ok) throw new CancelledError()
    const pw = res.values?.[0] ?? ''
    this.pendingRemember = this.pendingRemember.filter((r) => r.kind !== 'password')
    if (res.remember) this.pendingRemember.push({ kind: 'password', value: pw })
    return pw
  }

  private async loadKey(): Promise<{ key: Buffer | string; passphrase?: string }> {
    const ref = this.host.auth.key
    let key: Buffer | string
    let embeddedPassphrase: string | undefined
    if (ref.source === 'file') {
      if (!ref.path) throw new Error('No private key file selected for this host')
      try {
        key = await fs.readFile(expandHome(ref.path))
      } catch (e) {
        throw new Error(`Cannot read key file ${ref.path}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`)
      }
    } else if (ref.source === 'local') {
      const v = await this.deps.secrets.get(this.host.id, 'key')
      if (!v) throw new Error('No private key is saved on this device for this host')
      key = v
    } else {
      this.setStatus('authenticating', 'Fetching SSH key from Proton Pass…')
      const k = await this.deps.protonPass.sshKey(ref.shareId, ref.itemId)
      key = k.privateKey
      embeddedPassphrase = k.passphrase
    }

    const parsed = utils.parseKey(key)
    if (!(parsed instanceof Error)) return { key }
    if (!isEncryptedKeyError(parsed)) throw new Error(`Unsupported or invalid private key: ${parsed.message}`)

    // Encrypted key: try known passphrases first, then ask.
    const candidates: string[] = []
    if (embeddedPassphrase) candidates.push(embeddedPassphrase)
    const pref = this.host.auth.passphrase
    if (pref.source === 'local') {
      const v = await this.deps.secrets.get(this.host.id, 'passphrase')
      if (v) candidates.push(v)
    } else if (pref.source === 'protonpass') {
      try {
        candidates.push(await this.deps.protonPass.password(pref.shareId, pref.itemId))
      } catch {
        /* fall through to prompt */
      }
    }
    for (const c of candidates) {
      if (!(utils.parseKey(key, c) instanceof Error)) return { key, passphrase: c }
    }
    let message = candidates.length ? 'The saved passphrase did not unlock this key.' : ''
    for (let i = 0; i < MAX_TRIES; i++) {
      const res = await this.ask({
        kind: 'credentials',
        title: 'Key passphrase',
        message: message || `Enter the passphrase for the private key used by ${this.host.label}.`,
        fields: [{ label: 'Passphrase', secret: true }],
        allowRemember: (await this.deps.secrets.backend()).available
      })
      if (!res.ok) throw new CancelledError()
      const pass = res.values?.[0] ?? ''
      if (!(utils.parseKey(key, pass) instanceof Error)) {
        if (res.remember) this.pendingRemember.push({ kind: 'passphrase', value: pass })
        return { key, passphrase: pass }
      }
      message = 'Wrong passphrase. Try again.'
    }
    throw new Error('Could not decrypt the private key')
  }

  // ---------- shell ----------

  private openShell(cols: number, rows: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.shell({ term: 'xterm-256color', cols, rows }, { env: { COLORTERM: 'truecolor' } }, (err, stream) => {
        if (err) return reject(new Error(`Could not open a shell: ${err.message}`))
        this.shell = stream
        stream.on('data', (d: Buffer) => this.deps.emit({ type: 'data', sessionId: this.id, data: new Uint8Array(d) }))
        stream.stderr.on('data', (d: Buffer) => this.deps.emit({ type: 'data', sessionId: this.id, data: new Uint8Array(d) }))
        stream.on('close', () => {
          this.shell = undefined
          this.close('Shell exited')
        })
        resolve()
      })
    })
  }

  write(data: string): void {
    this.shell?.write(data)
  }

  private sizeSet = false

  resize(cols: number, rows: number): void {
    if (!(cols > 0 && rows > 0)) return
    this.size = { cols, rows }
    this.sizeSet = true
    this.shell?.setWindow(rows, cols, 0, 0)
  }

  // ---------- stats ----------

  private startStats(): void {
    const parser = new StatsParser()
    const interval = this.deps.settings().statsIntervalSec
    this.client.exec(statsCommand(interval), (err, stream) => {
      if (err || this.closed) {
        this.deps.emit({ type: 'stats', sessionId: this.id, stats: { at: Date.now(), disks: [], supported: false } })
        return
      }
      this.statsChannel = stream
      let samples = 0
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        parser.push(chunk, (stats) => {
          samples++
          this.deps.emit({ type: 'stats', sessionId: this.id, stats })
        })
      })
      stream.stderr.resume()
      stream.on('close', () => {
        this.statsChannel = undefined
        if (!samples && !this.closed) {
          this.deps.emit({ type: 'stats', sessionId: this.id, stats: { at: Date.now(), disks: [], supported: false } })
        }
      })
    })
  }

  // ---------- SFTP ----------

  /** Shared SFTP channel used for browsing and small operations. */
  sftp(): Promise<SFTPWrapper> {
    if (this.closed) return Promise.reject(new Error('Not connected'))
    if (!this.browseSftp) {
      this.browseSftp = this.openSftp().then((s) => {
        s.on('close', () => {
          this.browseSftp = undefined
        })
        return s
      })
      this.browseSftp.catch(() => {
        this.browseSftp = undefined
      })
    }
    return this.browseSftp
  }

  /** A new SFTP channel (each transfer gets its own so it can be cancelled by closing it). */
  openSftp(): Promise<SFTPWrapper> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('Not connected'))
      this.client.sftp((err, sftp) => {
        if (err) reject(new Error(`SFTP is not available on this server: ${err.message}`))
        else resolve(sftp)
      })
    })
  }

  // ---------- teardown ----------

  private fail(message: string): void {
    if (this.closed) return
    this.closed = true
    this.clearHandshakeTimer()
    this.setStatusForce('error', message)
    this.teardown()
    this.deps.emit({ type: 'closed', sessionId: this.id, reason: message })
  }

  private setStatusForce(status: SessionStatus, message?: string): void {
    this.status = status
    this.deps.emit({ type: 'status', sessionId: this.id, status, message })
  }

  private handleClose(): void {
    this.close(this.lastError || 'Connection closed')
  }

  close(reason = 'Disconnected'): void {
    if (this.closed) return
    this.closed = true
    this.clearHandshakeTimer()
    this.setStatusForce('closed', reason)
    this.teardown()
    this.deps.emit({ type: 'closed', sessionId: this.id, reason })
  }

  private teardown(): void {
    this.jump?.close('Tunnel closed')
    try {
      this.statsChannel?.close()
    } catch {
      /* ignore */
    }
    try {
      this.shell?.close()
    } catch {
      /* ignore */
    }
    this.client.end()
    this.sock?.destroy()
  }

  get isClosed(): boolean {
    return this.closed
  }
}
