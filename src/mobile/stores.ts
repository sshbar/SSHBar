// Persistent stores for the Android app (JSON files in the app's private storage).
import type { Host, HostInput, KnownHostEntry, Settings, Snippet, SnippetInput } from '../shared/types'
import { sanitizeHost } from '../shared/hostModel'
import { sanitizeSnippet } from '../shared/snippetModel'
import { sanitizeSettings } from '../shared/settingsModel'
import { Native } from './native'

async function load<T>(name: string, fallback: T): Promise<T> {
  try {
    const { data } = await Native.readText({ name })
    return data ? (JSON.parse(data) as T) : fallback
  } catch {
    return fallback
  }
}

function save(name: string, data: unknown): Promise<void> {
  return Native.writeText({ name, data: JSON.stringify(data) })
}

type Listener<T> = (v: T) => void

class Emitter<T> {
  private ls = new Set<Listener<T>>()
  on(cb: Listener<T>): () => void {
    this.ls.add(cb)
    return () => this.ls.delete(cb)
  }
  emit(v: T): void {
    for (const l of this.ls) l(v)
  }
}

export class MobileHosts {
  private hosts: Host[] = []
  private deleted: Record<string, number> = {}
  readonly changed = new Emitter<Host[]>()

  async init(): Promise<void> {
    const raw = await load<{ hosts?: Host[]; deleted?: Record<string, number> }>('hosts.json', {})
    this.hosts = []
    for (const h of raw.hosts ?? []) {
      try {
        this.hosts.push(sanitizeHost(h))
      } catch {
        /* skip */
      }
    }
    this.deleted = raw.deleted ?? {}
  }

  list(): Host[] {
    return structuredClone(this.hosts)
  }
  get(id: string): Host | undefined {
    const h = this.hosts.find((x) => x.id === id)
    return h ? structuredClone(h) : undefined
  }
  tombstones(): Record<string, number> {
    return { ...this.deleted }
  }

  async save(input: HostInput): Promise<Host> {
    const now = Date.now()
    const existing = input.id ? this.hosts.find((h) => h.id === input.id) : undefined
    const host = sanitizeHost({ ...input, createdAt: existing?.createdAt ?? now, updatedAt: now }, now)
    this.hosts = existing ? this.hosts.map((h) => (h.id === host.id ? host : h)) : [...this.hosts, host]
    delete this.deleted[host.id]
    await this.persist()
    return structuredClone(host)
  }

  async remove(id: string): Promise<void> {
    this.hosts = this.hosts.filter((h) => h.id !== id)
    this.deleted[id] = Date.now()
    await this.persist()
  }

  async replaceAll(hosts: Host[], deleted: Record<string, number>): Promise<void> {
    this.hosts = hosts
    this.deleted = deleted
    await this.persist()
  }

  private async persist(): Promise<void> {
    await save('hosts.json', { version: 1, hosts: this.hosts, deleted: this.deleted })
    this.changed.emit(this.list())
  }
}

export class MobileSnippets {
  private items: Snippet[] = []
  private deleted: Record<string, number> = {}
  readonly changed = new Emitter<Snippet[]>()

  async init(): Promise<void> {
    const raw = await load<{ snippets?: Snippet[]; deleted?: Record<string, number> }>('snippets.json', {})
    this.items = []
    for (const s of raw.snippets ?? []) {
      try {
        this.items.push(sanitizeSnippet(s))
      } catch {
        /* skip */
      }
    }
    this.deleted = raw.deleted ?? {}
  }
  list(): Snippet[] {
    return structuredClone(this.items)
  }
  tombstones(): Record<string, number> {
    return { ...this.deleted }
  }
  async save(input: SnippetInput): Promise<Snippet> {
    const now = Date.now()
    const existing = input.id ? this.items.find((s) => s.id === input.id) : undefined
    const snip = sanitizeSnippet({ ...input, createdAt: existing?.createdAt ?? now, updatedAt: now }, now)
    this.items = existing ? this.items.map((s) => (s.id === snip.id ? snip : s)) : [...this.items, snip]
    delete this.deleted[snip.id]
    await this.persist()
    return structuredClone(snip)
  }
  async remove(id: string): Promise<void> {
    this.items = this.items.filter((s) => s.id !== id)
    this.deleted[id] = Date.now()
    await this.persist()
  }
  async replaceAll(items: Snippet[], deleted: Record<string, number>): Promise<void> {
    this.items = items
    this.deleted = deleted
    await this.persist()
  }
  private async persist(): Promise<void> {
    await save('snippets.json', { version: 1, snippets: this.items, deleted: this.deleted })
    this.changed.emit(this.list())
  }
}

export class MobileSettings {
  private data: Settings = sanitizeSettings({})
  readonly changed = new Emitter<Settings>()
  async init(): Promise<void> {
    this.data = sanitizeSettings(await load<Partial<Settings>>('settings.json', {}))
  }
  get(): Settings {
    return structuredClone(this.data)
  }
  async update(patch: Partial<Settings>): Promise<Settings> {
    this.data = sanitizeSettings({
      ...this.data,
      ...patch,
      sync: { ...this.data.sync, ...(patch.sync ?? {}) },
      fileSync: { ...this.data.fileSync, ...(patch.fileSync ?? {}) }
    })
    await save('settings.json', this.data)
    this.changed.emit(this.get())
    return this.get()
  }
}

export function hostKeyName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`
}

/** Trust-on-first-use host keys (same semantics as the desktop store, without ~/.ssh/known_hosts). */
type KnownMap = Record<string, { keyType: string; key: string; fingerprint: string; addedAt: number }[]>

export class MobileKnownHosts {
  private hosts: KnownMap = {}

  async init(): Promise<void> {
    this.hosts = (await load<{ hosts?: KnownMap }>('known_hosts.json', {})).hosts ?? {}
  }

  check(host: string, port: number, keyType: string, key: string): { state: 'trusted' } | { state: 'unknown' } | { state: 'changed'; known: string[] } {
    const same = (this.hosts[hostKeyName(host, port)] ?? []).filter((e) => e.keyType === keyType)
    if (same.some((e) => e.key === key)) return { state: 'trusted' }
    if (same.length) return { state: 'changed', known: same.map((e) => e.fingerprint) }
    return { state: 'unknown' }
  }

  async trust(host: string, port: number, keyType: string, key: string, fingerprint: string): Promise<void> {
    const name = hostKeyName(host, port)
    this.hosts[name] = [...(this.hosts[name] ?? []).filter((e) => e.keyType !== keyType), { keyType, key, fingerprint, addedAt: Date.now() }]
    await save('known_hosts.json', { version: 1, hosts: this.hosts })
  }

  list(): KnownHostEntry[] {
    return Object.entries(this.hosts)
      .flatMap(([hostKey, es]) => es.map((e) => ({ hostKey, keyType: e.keyType, fingerprint: e.fingerprint, addedAt: e.addedAt })))
      .sort((a, b) => a.hostKey.localeCompare(b.hostKey))
  }

  async remove(hostKey: string): Promise<void> {
    delete this.hosts[hostKey]
    await save('known_hosts.json', { version: 1, hosts: this.hosts })
  }
}
