import type { Host } from './types'

const TOMBSTONE_TTL_MS = 180 * 24 * 3600 * 1000

interface Versioned {
  id: string
  createdAt: number
  updatedAt: number
}

/** Last-writer-wins merge of two record sets with deletion tombstones (expired after 180 days). */
export function mergeRecords<T extends Versioned>(
  a: { items: T[]; deleted: Record<string, number> },
  b: { items: T[]; deleted: Record<string, number> },
  now = Date.now()
): { items: T[]; deleted: Record<string, number> } {
  const deleted: Record<string, number> = {}
  for (const src of [a.deleted, b.deleted]) {
    for (const [id, at] of Object.entries(src)) {
      if (typeof at === 'number' && now - at < TOMBSTONE_TTL_MS) deleted[id] = Math.max(deleted[id] ?? 0, at)
    }
  }
  const byId = new Map<string, T>()
  for (const r of [...a.items, ...b.items]) {
    const cur = byId.get(r.id)
    if (!cur || r.updatedAt > cur.updatedAt) byId.set(r.id, r)
  }
  const items: T[] = []
  for (const r of byId.values()) {
    const del = deleted[r.id]
    if (del !== undefined && del >= r.updatedAt) continue
    if (del !== undefined) delete deleted[r.id]
    items.push(r)
  }
  items.sort((x, y) => x.createdAt - y.createdAt)
  return { items, deleted }
}

export function mergeHosts(
  a: { hosts: Host[]; deleted: Record<string, number> },
  b: { hosts: Host[]; deleted: Record<string, number> },
  now = Date.now()
): { hosts: Host[]; deleted: Record<string, number> } {
  const r = mergeRecords({ items: a.hosts, deleted: a.deleted }, { items: b.hosts, deleted: b.deleted }, now)
  return { hosts: r.items, deleted: r.deleted }
}

export function recordsFingerprint(items: Versioned[], deleted: Record<string, number>): string {
  return JSON.stringify([[...items].sort((x, y) => x.id.localeCompare(y.id)).map((r) => `${r.id}@${r.updatedAt}`), Object.keys(deleted).sort()])
}

export function fingerprintOf(s: { hosts: Host[]; deleted: Record<string, number> }): string {
  const hosts = [...s.hosts].sort((x, y) => x.id.localeCompare(y.id)).map((h) => `${h.id}@${h.updatedAt}`)
  const del = Object.keys(s.deleted).sort()
  return JSON.stringify([hosts, del])
}

export function countDiff(from: { hosts: Host[] }, to: { hosts: Host[] }): number {
  const fromMap = new Map(from.hosts.map((h) => [h.id, h.updatedAt]))
  const toIds = new Set(to.hosts.map((h) => h.id))
  let n = 0
  for (const h of to.hosts) if (fromMap.get(h.id) !== h.updatedAt) n++
  for (const id of fromMap.keys()) if (!toIds.has(id)) n++
  return n
}
