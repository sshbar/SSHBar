// One SSH session on Android, orchestrated in TypeScript over the native sshj bridge.
// Mirrors src/main/ssh/session.ts: verify the host key before sending any credential,
// then password / key / keyboard-interactive auth with the same retry and fallback rules.
import type { Host, PromptRequest, PromptResponse, SecretKind, SessionEvent, SessionStatus } from '../shared/types'
import { StatsParser, statsCommand } from '../main/ssh/stats'
import { Native, nativeError, type AuthResult } from './native'
import type { MobileKnownHosts } from './stores'

export type PromptInput = PromptRequest extends infer T ? (T extends { id: string } ? Omit<T, 'id'> : never) : never

export interface MobileSessionDeps {
  getHost(id: string): Host | undefined
  knownHosts: MobileKnownHosts
  secret(hostId: string, kind: SecretKind): Promise<string | undefined>
  remember(host: Host, kind: SecretKind, value: string): Promise<void>
  saveUsername(host: Host, username: string): Promise<void>
  prompt(req: PromptInput): Promise<PromptResponse>
  emit(ev: SessionEvent): void
  statsIntervalSec(): number
}

class CancelledError extends Error {
  constructor() {
    super('Cancelled')
  }
}

const MAX_TRIES = 3
const MAX_HOPS = 8

/** Native connection ids: `${sessionId}` for the target, `${sessionId}/<n>` for jump hosts. */
export class MobileSession {
  status: SessionStatus = 'connecting'
  private closed = false
  private username: string
  /** jump-host sessions this connection is tunnelled through (closest first) */
  private jumps: MobileSession[] = []
  private pendingRemember: { kind: SecretKind; value: string }[] = []
  private saveUsernameAfterAuth = false
  private size = { cols: 80, rows: 24 }
  private shellOpen = false
  private statsExec?: string

  constructor(
    readonly id: string,
    readonly host: Host,
    private deps: MobileSessionDeps,
    private nativeId = id
  ) {
    this.username = host.username
  }

  get isClosed(): boolean {
    return this.closed
  }

  private setStatus(status: SessionStatus, message?: string): void {
    if (this.closed && status !== 'closed' && status !== 'error') return
    this.status = status
    this.deps.emit({ type: 'status', sessionId: this.id, status, message })
  }

  private async ask(req: PromptInput): Promise<PromptResponse> {
    const res = await this.deps.prompt({ ...req, sessionId: this.id } as PromptInput)
    if (this.closed) throw new CancelledError()
    return res
  }

  async start(cols: number, rows: number): Promise<void> {
    this.size = { cols, rows }
    try {
      await this.establish(new Set())
      await Native.sshShell({ id: this.nativeId, cols: this.size.cols, rows: this.size.rows })
      this.shellOpen = true
      this.setStatus('connected')
      this.startStats()
    } catch (e) {
      this.fail(e instanceof CancelledError ? 'Connection cancelled' : nativeError(e).message)
    }
  }

  /** Transport + auth for this host, through its jump host chain if configured. */
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

    let viaId: string | undefined
    if (this.host.jumpHostId) {
      const jumpHost = this.deps.getHost(this.host.jumpHostId)
      if (!jumpHost) throw new Error(`The jump host configured for ${this.host.label} no longer exists`)
      if (chain.has(jumpHost.id)) throw new Error(`Jump host loop: ${jumpHost.label} is already part of this connection chain`)
      if (chain.size >= MAX_HOPS) throw new Error('Too many jump hosts in the chain')
      const jumpNativeId = `${this.id}/${chain.size}`
      const jump = new MobileSession(this.id, jumpHost, { ...this.deps, emit: (ev) => this.onJumpEvent(jumpHost, ev) }, jumpNativeId)
      this.jumps.push(jump)
      try {
        await jump.establish(chain)
      } catch (e) {
        if (e instanceof CancelledError) throw e
        throw new Error(`Jump host ${jumpHost.label}: ${nativeError(e).message}`)
      }
      viaId = jumpNativeId
      this.setStatus('connecting', `Connecting to ${this.host.hostname}:${this.host.port} via ${jumpHost.label}…`)
    } else {
      this.setStatus('connecting', `Connecting to ${this.host.hostname}:${this.host.port}…`)
    }

    const hk = await Native.sshOpen({ id: this.nativeId, host: this.host.hostname, port: this.host.port, viaId })
    await this.verifyHostKey(hk.keyType, hk.key, hk.fingerprint)
    this.setStatus('authenticating', 'Authenticating…')
    await this.authenticate()
    for (const r of this.pendingRemember.splice(0)) await this.deps.remember(this.host, r.kind, r.value).catch(() => undefined)
    if (this.saveUsernameAfterAuth) await this.deps.saveUsername(this.host, this.username).catch(() => undefined)
  }

  private onJumpEvent(jumpHost: Host, ev: SessionEvent): void {
    if (ev.type === 'status' && (ev.status === 'connecting' || ev.status === 'authenticating')) {
      this.setStatus(ev.status, `${jumpHost.label}: ${ev.message ?? ''}`)
    }
  }

  private async verifyHostKey(keyType: string, key: string, fingerprint: string): Promise<void> {
    const { hostname, port } = this.host
    const check = this.deps.knownHosts.check(hostname, port, keyType, key)
    if (check.state === 'trusted') return
    const res = await this.ask({
      kind: 'hostkey',
      host: hostname,
      port,
      keyType,
      fingerprint,
      state: check.state,
      knownFingerprints: check.state === 'changed' ? check.known : []
    })
    if (!res.ok) throw new Error('Host key not accepted')
    if (res.remember) await this.deps.knownHosts.trust(hostname, port, keyType, key, fingerprint)
  }

  // ---------- authentication ----------

  private async authenticate(): Promise<void> {
    const a = this.host.auth
    let allowed: string[] = []
    let keyFailed = false

    if (a.method === 'agent') throw new Error('SSH agents are not available on Android. Edit the host to use a key or password.')

    if (a.method === 'key') {
      const { key, passphrase } = await this.loadKey()
      const r = await Native.sshAuthKey({ id: this.nativeId, username: this.username, privateKey: key, passphrase })
      if (r.ok) return
      allowed = r.allowed
      keyFailed = true
    }

    let passwordUsed: string | undefined
    if (a.method === 'password' || (keyFailed && allowed.includes('password'))) {
      for (let i = 0; i < MAX_TRIES; i++) {
        const note =
          keyFailed && i === 0 ? 'The server did not accept the SSH key. You can log in with a password instead.' : i > 0 ? 'Authentication failed. Try again.' : undefined
        const pw = await this.getPassword(i > 0 || keyFailed, note)
        passwordUsed = pw
        const r: AuthResult = await Native.sshAuthPassword({ id: this.nativeId, username: this.username, password: pw })
        if (r.ok) return
        allowed = r.allowed
        if (!allowed.includes('password')) break
      }
    }

    if (!allowed.length || allowed.includes('keyboard-interactive')) {
      this.kbdPassword = a.method === 'password' ? passwordUsed : undefined
      const r = await Native.sshAuthKeyboard({ id: this.nativeId, username: this.username })
      if (r.ok) return
    }

    if (a.method === 'key') throw new Error('The server rejected the SSH key')
    throw new Error('Authentication failed: wrong username or password')
  }

  /** Password typed earlier, used to answer a single "Password:" keyboard-interactive prompt once. */
  kbdPassword?: string

  async answerKeyboard(instruction: string, prompt: string, echo: boolean): Promise<string | null> {
    if (this.kbdPassword && !echo && /password/i.test(prompt)) {
      const pw = this.kbdPassword
      this.kbdPassword = undefined
      return pw
    }
    const res = await this.ask({
      kind: 'credentials',
      title: `${this.username}@${this.host.hostname}`,
      message: instruction || 'The server requires additional verification.',
      fields: [{ label: prompt.trim().replace(/:$/, ''), secret: !echo }],
      allowRemember: false
    }).catch(() => ({ ok: false }) as PromptResponse)
    return res.ok ? (res.values?.[0] ?? '') : null
  }

  private async getPassword(retry: boolean, reason?: string): Promise<string> {
    const ref = this.host.auth.password
    let note = reason ?? (retry ? 'Authentication failed. Try again.' : '')
    if (!retry) {
      // a password saved on this phone wins over the host's shared source
      const v = await this.deps.secret(this.host.id, 'password')
      if (v) return v
      if (ref.source === 'local') {
        note = 'No password is saved on this device.'
      } else if (ref.source === 'protonpass') {
        // copied from Proton Pass into the sync file by a desktop that shares them
        const shared = await this.deps.secret(`pp:${ref.shareId}:${ref.itemId}`, 'password')
        if (shared) return shared
        note = 'Proton Pass is not available on Android. Enter the password, or turn on “Share Proton Pass keys with my phones” on your computer.'
      }
    }
    const res = await this.ask({
      kind: 'credentials',
      title: `Password for ${this.username}@${this.host.hostname}`,
      message: note,
      fields: [{ label: 'Password', secret: true }],
      allowRemember: this.host.auth.method === 'password'
    })
    if (!res.ok) throw new CancelledError()
    const pw = res.values?.[0] ?? ''
    this.pendingRemember = this.pendingRemember.filter((r) => r.kind !== 'password')
    if (res.remember) this.pendingRemember.push({ kind: 'password', value: pw })
    return pw
  }

  private async loadKey(): Promise<{ key: string; passphrase?: string }> {
    const ref = this.host.auth.key
    // a key saved on this phone wins over the host's shared key source (computer key file / Proton Pass)
    let key = await this.deps.secret(this.host.id, 'key')
    if (!key && ref.source === 'protonpass') key = await this.deps.secret(`pp:${ref.shareId}:${ref.itemId}`, 'key')
    if (!key) {
      throw new Error(
        ref.source === 'file'
          ? `This host uses the key file ${ref.path || '(none)'} on your computer. Edit the host on this phone and paste the key.`
          : ref.source === 'protonpass'
            ? 'This host uses an SSH key from Proton Pass, which is not available on Android. On your computer turn on “Share Proton Pass keys with my phones” (Settings → Encrypted sync file), or paste the key in this host on the phone.'
            : 'No private key is saved on this device for this host'
      )
    }
    const info = await Native.sshKeyInfo({ privateKey: key })
    if (!info.valid && !info.needsPassphrase) throw new Error(`Unsupported or invalid private key: ${info.error ?? ''}`)
    if (!info.needsPassphrase) return { key }

    const pref = this.host.auth.passphrase
    const kref = this.host.auth.key
    const stored =
      (await this.deps.secret(this.host.id, 'passphrase')) ??
      (kref.source === 'protonpass' ? await this.deps.secret(`pp:${kref.shareId}:${kref.itemId}`, 'passphrase') : undefined) ??
      (pref.source === 'protonpass' ? await this.deps.secret(`pp:${pref.shareId}:${pref.itemId}`, 'password') : undefined)
    if (stored && (await Native.sshKeyInfo({ privateKey: key, passphrase: stored })).valid) return { key, passphrase: stored }
    let message = stored ? 'The saved passphrase did not unlock this key.' : `Enter the passphrase for the private key used by ${this.host.label}.`
    for (let i = 0; i < MAX_TRIES; i++) {
      const res = await this.ask({
        kind: 'credentials',
        title: 'Key passphrase',
        message,
        fields: [{ label: 'Passphrase', secret: true }],
        allowRemember: true
      })
      if (!res.ok) throw new CancelledError()
      const pass = res.values?.[0] ?? ''
      if ((await Native.sshKeyInfo({ privateKey: key, passphrase: pass })).valid) {
        if (res.remember) this.pendingRemember.push({ kind: 'passphrase', value: pass })
        return { key, passphrase: pass }
      }
      message = 'Wrong passphrase. Try again.'
    }
    throw new Error('Could not decrypt the private key')
  }

  // ---------- shell & stats ----------

  write(data: string): void {
    if (this.shellOpen) void Native.sshWrite({ id: this.nativeId, data })
  }

  resize(cols: number, rows: number): void {
    if (!(cols > 0 && rows > 0)) return
    this.size = { cols, rows }
    if (this.shellOpen) void Native.sshResize({ id: this.nativeId, cols, rows })
  }

  onData(b: Uint8Array): void {
    this.deps.emit({ type: 'data', sessionId: this.id, data: b })
  }

  private parser = new StatsParser()
  private statsSamples = 0

  private startStats(): void {
    this.statsExec = `stats-${Date.now()}`
    Native.sshExec({ id: this.nativeId, execId: this.statsExec, command: statsCommand(this.deps.statsIntervalSec()) }).catch(() =>
      this.deps.emit({ type: 'stats', sessionId: this.id, stats: { at: Date.now(), disks: [], supported: false } })
    )
  }

  onExecData(execId: string, text: string): void {
    if (execId !== this.statsExec) return
    this.parser.push(text, (stats) => {
      this.statsSamples++
      this.deps.emit({ type: 'stats', sessionId: this.id, stats })
    })
  }

  onExecClosed(execId: string): void {
    if (execId === this.statsExec && !this.statsSamples && !this.closed) {
      this.deps.emit({ type: 'stats', sessionId: this.id, stats: { at: Date.now(), disks: [], supported: false } })
    }
  }

  /** The native connection with this id went away. */
  onNativeClosed(nativeId: string, reason: string): void {
    if (this.closed || !this.ownsNativeId(nativeId)) return
    if (nativeId === this.nativeId) this.close(reason || 'Connection closed')
    else if (this.status === 'connected') this.close(`Jump host disconnected${reason ? `: ${reason}` : ''}`)
  }

  /** The (sub)session — target or one of its jump hosts — behind a native connection id. */
  sessionFor(nativeId: string): MobileSession | undefined {
    if (nativeId === this.nativeId) return this
    for (const j of this.jumps) {
      const s = j.sessionFor(nativeId)
      if (s) return s
    }
    return undefined
  }

  ownsNativeId(nativeId: string): boolean {
    return nativeId === this.nativeId || this.jumps.some((j) => j.ownsNativeId(nativeId))
  }

  /** Close this connection and every jump connection under it. */
  closeNative(): void {
    void Native.sshClose({ id: this.nativeId }).catch(() => undefined)
    for (const j of [...this.jumps].reverse()) j.closeNative()
  }

  // ---------- teardown ----------

  private fail(message: string): void {
    if (this.closed) return
    this.closed = true
    this.status = 'error'
    this.deps.emit({ type: 'status', sessionId: this.id, status: 'error', message })
    this.teardown()
    this.deps.emit({ type: 'closed', sessionId: this.id, reason: message })
  }

  close(reason = 'Disconnected'): void {
    if (this.closed) return
    this.closed = true
    this.status = 'closed'
    this.deps.emit({ type: 'status', sessionId: this.id, status: 'closed', message: reason })
    this.teardown()
    this.deps.emit({ type: 'closed', sessionId: this.id, reason })
  }

  private teardown(): void {
    // target first, then the jump hosts it was tunnelled through
    this.closeNative()
  }
}
