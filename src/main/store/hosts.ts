import { join } from 'node:path'
import type { Host, HostInput } from '../../shared/types'
import { sanitizeHost } from '../../shared/hostModel'
import { readJsonSync, writeJson } from './jsonFile'

export { sanitizeHost, sanitizeForwards } from '../../shared/hostModel'

interface HostsFile {
  version: 1
  hosts: Host[]
  /** id -> deletedAt, so deletions propagate through sync */
  deleted: Record<string, number>
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
