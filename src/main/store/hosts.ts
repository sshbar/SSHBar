import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { CredentialRef, Host, HostInput, KeyRef, PortForward } from '../../shared/types'
import { normalizeAuth } from '../../shared/defaults'
import { readJsonSync, writeJson } from './jsonFile'

interface HostsFile {
  version: 1
  hosts: Host[]
  /** id -> deletedAt, so deletions propagate through sync */
  deleted: Record<string, number>
}

function str(v: unknown, max = 1024): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

function sanitizeCred(c: unknown): CredentialRef {
  const r = (c ?? {}) as Record<string, unknown>
  if (r.source === 'local') return { source: 'local' }
  if (r.source === 'protonpass' && typeof r.shareId === 'string' && typeof r.itemId === 'string') {
    return { source: 'protonpass', shareId: str(r.shareId, 256), itemId: str(r.itemId, 256), title: str(r.title, 256) }
  }
  return { source: 'prompt' }
}

function sanitizeKey(k: unknown): KeyRef {
  const r = (k ?? {}) as Record<string, unknown>
  if (r.source === 'local') return { source: 'local' }
  if (r.source === 'protonpass' && typeof r.shareId === 'string' && typeof r.itemId === 'string') {
    return { source: 'protonpass', shareId: str(r.shareId, 256), itemId: str(r.itemId, 256), title: str(r.title, 256) }
  }
  return { source: 'file', path: str(r.path, 4096) }
}

function port(v: unknown, allowZero: boolean): number {
  const n = Number(v)
  return Number.isInteger(n) && n >= (allowZero ? 0 : 1) && n < 65536 ? n : -1
}

export function sanitizeForwards(list: unknown): PortForward[] {
  if (!Array.isArray(list)) return []
  const out: PortForward[] = []
  for (const raw of list.slice(0, 50)) {
    const f = (raw ?? {}) as Record<string, unknown>
    const type = f.type === 'remote' || f.type === 'dynamic' ? f.type : f.type === 'local' ? 'local' : null
    if (!type) continue
    const bindPort = port(f.bindPort, true)
    const destPort = type === 'dynamic' ? 0 : port(f.destPort, false)
    const destHost = type === 'dynamic' ? '' : str(f.destHost, 255).trim()
    if (bindPort < 0 || destPort < 0 || (type !== 'dynamic' && !destHost)) continue
    out.push({
      id: typeof f.id === 'string' && f.id ? f.id.slice(0, 64) : randomUUID(),
      type,
      label: str(f.label, 100),
      bindAddress: str(f.bindAddress, 255).trim() || '127.0.0.1',
      bindPort,
      destHost,
      destPort,
      autoStart: f.autoStart !== false
    })
  }
  return out
}

/** Validate and normalise untrusted host data (from the renderer, an import file or a sync payload). */
export function sanitizeHost(input: Partial<HostInput> & Partial<Host>, now = Date.now()): Host {
  const port = Number(input.port)
  const auth = normalizeAuth(input.auth)
  const hostname = str(input.hostname, 255).trim()
  if (!hostname) throw new Error('Hostname is required')
  if (/[\s/\\]/.test(hostname)) throw new Error('Hostname must not contain spaces or slashes')
  const id = typeof input.id === 'string' && input.id ? input.id.slice(0, 64) : randomUUID()
  const jumpHostId = str(input.jumpHostId, 64)
  return {
    id,
    label: str(input.label, 200).trim() || hostname,
    group: str(input.group, 200).trim(),
    hostname,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 22,
    username: str(input.username, 255).trim(),
    auth: {
      method: auth.method,
      password: sanitizeCred(auth.password),
      key: sanitizeKey(auth.key),
      passphrase: sanitizeCred(auth.passphrase),
      agent: auth.agent,
      agentSocket: str(auth.agentSocket, 4096)
    },
    jumpHostId: jumpHostId === id ? '' : jumpHostId,
    forwards: sanitizeForwards(input.forwards),
    tags: Array.isArray(input.tags) ? input.tags.filter((t) => typeof t === 'string').map((t) => t.slice(0, 64)).slice(0, 32) : [],
    notes: str(input.notes, 10_000),
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : now
  }
}

export class HostStore {
  private file: string
  private data: HostsFile
  private listeners = new Set<(hosts: Host[]) => void>()

  constructor(dir: string) {
    this.file = join(dir, 'hosts.json')
    const raw = readJsonSync<Partial<HostsFile>>(this.file, {})
    const hosts: Host[] = []
    for (const h of raw.hosts ?? []) {
      try {
        hosts.push(sanitizeHost(h))
      } catch {
        /* drop corrupt entries */
      }
    }
    this.data = { version: 1, hosts, deleted: raw.deleted ?? {} }
  }

  list(): Host[] {
    return structuredClone(this.data.hosts)
  }

  get(id: string): Host | undefined {
    const h = this.data.hosts.find((x) => x.id === id)
    return h ? structuredClone(h) : undefined
  }

  tombstones(): Record<string, number> {
    return { ...this.data.deleted }
  }

  onChange(cb: (hosts: Host[]) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  async save(input: HostInput): Promise<Host> {
    const now = Date.now()
    const existing = input.id ? this.data.hosts.find((h) => h.id === input.id) : undefined
    const host = sanitizeHost({ ...input, createdAt: existing?.createdAt ?? now, updatedAt: now }, now)
    if (existing) {
      this.data.hosts = this.data.hosts.map((h) => (h.id === host.id ? host : h))
    } else {
      this.data.hosts.push(host)
    }
    delete this.data.deleted[host.id]
    await this.persist()
    return structuredClone(host)
  }

  async remove(id: string): Promise<void> {
    this.data.hosts = this.data.hosts.filter((h) => h.id !== id)
    this.data.deleted[id] = Date.now()
    await this.persist()
  }

  /** Replace all data (used by sync after merging). */
  async replaceAll(hosts: Host[], deleted: Record<string, number>): Promise<void> {
    this.data.hosts = hosts
    this.data.deleted = deleted
    await this.persist()
  }

  private async persist(): Promise<void> {
    await writeJson(this.file, this.data)
    const snapshot = this.list()
    for (const l of this.listeners) l(snapshot)
  }
}
