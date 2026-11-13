import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import type { PPAgentStatus, PPItem, PPStatus, PPVault } from '../shared/types'

/**
 * Thin wrapper around the Proton Pass CLI (`pass-cli`). Every call uses execFile with an
 * argument array (never a shell), and secrets returned by the CLI stay in the main process.
 */

export class ProtonPassError extends Error {}

interface RunOpts {
  input?: string
  timeoutMs?: number
}

type Json = Record<string, unknown>

const EXTRA_DIRS =
  process.platform === 'win32'
    ? [join(process.env.LOCALAPPDATA ?? '', 'Programs', 'ProtonPass'), join(process.env.LOCALAPPDATA ?? '', 'Programs', 'pass-cli')]
    : [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), 'bin'), '/usr/bin']

/**
 * GUI apps (especially on macOS) don't inherit the shell's PATH, so look in the usual
 * install locations when the configured command is a bare name.
 */
export function resolveCli(cmd: string): string {
  if (isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) return cmd
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  const dirs = [...(process.env.PATH ?? '').split(delimiter), ...EXTRA_DIRS].filter(Boolean)
  for (const d of dirs) {
    for (const e of exts) {
      const p = join(d, cmd + e)
      if (existsSync(p)) return p
    }
  }
  return cmd
}

export function defaultAgentSocket(): string {
  return process.platform === 'win32' ? '\\\\.\\pipe\\proton-pass-agent' : join(homedir(), '.ssh', 'proton-pass-agent.sock')
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

interface ExtraField {
  name?: string
  content?: { Text?: string; Hidden?: string; Totp?: string }
}

function fieldValue(f: ExtraField): string {
  return asString(f.content?.Hidden) || asString(f.content?.Text)
}

/** Find a custom field by name in an item's extra fields and SSH key sections. */
export function findField(content: Json, pattern: RegExp): string | undefined {
  const fields: ExtraField[] = [...((content.extra_fields as ExtraField[]) ?? [])]
  const inner = (content.content ?? {}) as Json
  for (const v of Object.values(inner)) {
    const sections = (v as Json)?.sections as { section_fields?: ExtraField[] }[] | undefined
    for (const s of sections ?? []) fields.push(...(s.section_fields ?? []))
  }
  const hit = fields.find((f) => pattern.test(f.name ?? ''))
  return hit ? fieldValue(hit) : undefined
}

/** Extract a password from a Proton Pass item (`item view --output json`). */
export function extractPassword(view: Json): string {
  const content = ((view.item as Json)?.content ?? {}) as Json
  const inner = (content.content ?? {}) as Json
  const login = inner.Login as Json | undefined
  if (login && asString(login.password)) return asString(login.password)
  const named = findField(content, /^(password|passphrase|secret)$/i)
  if (named) return named
  const anyHidden = ((content.extra_fields as ExtraField[]) ?? []).find((f) => f.content?.Hidden)
  if (anyHidden) return fieldValue(anyHidden)
  throw new ProtonPassError('This Proton Pass item has no password field')
}

/** Extract a private key (+ optional passphrase field) from a Proton Pass SSH key item. */
export function extractSshKey(view: Json): { privateKey: string; publicKey: string; passphrase?: string } {
  const content = ((view.item as Json)?.content ?? {}) as Json
  const inner = (content.content ?? {}) as Json
  const ssh = inner.SshKey as Json | undefined
  if (!ssh || !asString(ssh.private_key)) throw new ProtonPassError('This Proton Pass item is not an SSH key')
  return {
    privateKey: asString(ssh.private_key),
    publicKey: asString(ssh.public_key),
    passphrase: findField(content, /pass(word|phrase)/i)
  }
}

export class ProtonPass {
  private itemCache = new Map<string, { at: number; items: PPItem[] }>()

  constructor(private cliCommand: () => string) {}

  private run(args: string[], opts: RunOpts = {}): Promise<string> {
    const cmd = resolveCli(this.cliCommand())
    return new Promise((resolve, reject) => {
      const child = execFile(
        cmd,
        args,
        { timeout: opts.timeoutMs ?? 30_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: process.env },
        (err, stdout, stderr) => {
          if (err) {
            const e = err as NodeJS.ErrnoException
            if (e.code === 'ENOENT') return reject(new ProtonPassError(`Proton Pass CLI not found ("${this.cliCommand()}")`))
            const msg = (stderr || stdout || e.message).toString().trim().split('\n').slice(-3).join(' ')
            return reject(new ProtonPassError(msg || 'pass-cli failed'))
          }
          resolve(stdout.toString())
        }
      )
      if (opts.input !== undefined) {
        child.stdin?.end(opts.input)
      }
    })
  }

  private async json(args: string[]): Promise<Json> {
    const out = await this.run([...args, '--output', 'json'])
    try {
      return JSON.parse(out) as Json
    } catch {
      throw new ProtonPassError('Unexpected output from pass-cli')
    }
  }

  async status(): Promise<PPStatus> {
    let version: string
    try {
      version = (await this.run(['--version'], { timeoutMs: 10_000 })).trim()
    } catch (e) {
      return { installed: false, loggedIn: false, error: (e as Error).message }
    }
    try {
      const info = await this.json(['info'])
      return { installed: true, loggedIn: true, version, username: asString(info.username) || asString(info.email) }
    } catch (e) {
      return { installed: true, loggedIn: false, version, error: (e as Error).message }
    }
  }

  async vaults(): Promise<PPVault[]> {
    const data = await this.json(['vault', 'list'])
    const vaults = (data.vaults as Json[]) ?? []
    return vaults
      .map((v) => ({ shareId: asString(v.share_id), name: asString(v.name) }))
      .filter((v) => v.shareId)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async items(shareId: string, type?: 'login' | 'ssh-key' | 'note', fresh = false): Promise<PPItem[]> {
    const key = `${shareId}|${type ?? ''}`
    const cached = this.itemCache.get(key)
    if (!fresh && cached && Date.now() - cached.at < 60_000) return cached.items
    const args = ['item', 'list', '--share-id', shareId, '--filter-state', 'active']
    if (type) args.push('--filter-type', type)
    const data = await this.json(args)
    const items = ((data.items as Json[]) ?? [])
      .map((i) => ({ id: asString(i.id), shareId: asString(i.share_id) || shareId, title: asString(i.title), type: asString(i.item_type) }))
      .filter((i) => i.id)
      .sort((a, b) => a.title.localeCompare(b.title))
    this.itemCache.set(key, { at: Date.now(), items })
    return items
  }

  async view(shareId: string, itemId: string): Promise<Json> {
    return this.json(['item', 'view', '--share-id', shareId, '--item-id', itemId])
  }

  async password(shareId: string, itemId: string): Promise<string> {
    return extractPassword(await this.view(shareId, itemId))
  }

  async sshKey(shareId: string, itemId: string): Promise<{ privateKey: string; publicKey: string; passphrase?: string }> {
    return extractSshKey(await this.view(shareId, itemId))
  }

  // ----- SSH agent daemon -----

  async agentStatus(socketPath: string): Promise<PPAgentStatus> {
    try {
      const out = await this.run(['ssh-agent', 'daemon', 'status'], { timeoutMs: 10_000 })
      const running = /status:\s*running/i.test(out)
      return { running, socketPath, detail: out.trim() }
    } catch (e) {
      return { running: false, socketPath, detail: (e as Error).message }
    }
  }

  async agentStart(socketPath: string, shareId?: string): Promise<PPAgentStatus> {
    const args = ['ssh-agent', 'daemon', 'start', '--socket-path', socketPath]
    if (shareId) args.push('--share-id', shareId)
    await this.run(args, { timeoutMs: 20_000 })
    // the daemon needs a moment to create its socket
    for (let i = 0; i < 20; i++) {
      if (process.platform === 'win32' || existsSync(socketPath)) break
      await new Promise((r) => setTimeout(r, 150))
    }
    return this.agentStatus(socketPath)
  }

  async agentStop(socketPath: string): Promise<PPAgentStatus> {
    await this.run(['ssh-agent', 'daemon', 'stop'], { timeoutMs: 10_000 })
    return this.agentStatus(socketPath)
  }

  // ----- Note items used for host sync -----

  async findNote(shareId: string, title: string): Promise<string | undefined> {
    const items = await this.items(shareId, 'note', true)
    return items.find((i) => i.title === title)?.id
  }

  async createNote(shareId: string, title: string, note: string): Promise<string> {
    await this.run(['item', 'create', 'note', '--share-id', shareId, '--title', title, '--note', note])
    const id = await this.findNote(shareId, title)
    if (!id) throw new ProtonPassError('Created the sync note but could not find it again')
    return id
  }

  async readField(shareId: string, itemId: string, field: string): Promise<string | undefined> {
    const view = await this.view(shareId, itemId)
    const content = ((view.item as Json)?.content ?? {}) as Json
    const fields = (content.extra_fields as ExtraField[]) ?? []
    const f = fields.find((x) => x.name === field)
    return f ? fieldValue(f) : undefined
  }

  async writeField(shareId: string, itemId: string, field: string, value: string): Promise<void> {
    await this.run(['item', 'update', '--share-id', shareId, '--item-id', itemId, '--field', `${field}=${value}`])
  }
}
