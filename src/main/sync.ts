import { gunzipSync, gzipSync } from 'node:zlib'
import type { Host, Snippet, SyncResult } from '../shared/types'
import type { HostStore } from './store/hosts'
import { sanitizeHost } from './store/hosts'
import { sanitizeSnippet, type SnippetStore } from './store/snippets'
import type { SettingsStore } from './store/settings'
import type { ProtonPass } from './protonpass'

/**
 * Host sync through Proton Pass: the host list (no secrets — only references to Proton Pass
 * items, key file paths and "saved on this device" markers) is stored end-to-end encrypted in a
 * Proton Pass note item, in a custom field. Every device merges by last-writer-wins per host.
 */

export const SYNC_NOTE_TITLE = 'SSHBuddy Sync'
export const SYNC_FIELD = 'sshbuddy_hosts'
const TOMBSTONE_TTL_MS = 180 * 24 * 3600 * 1000

export interface SyncPayload {
  v: 1
  at: number
  hosts: Host[]
  deleted: Record<string, number>
  snippets: Snippet[]
  snippetsDeleted: Record<string, number>
}

export function encodePayload(p: SyncPayload): string {
  const json = JSON.stringify(p)
  // Keep the CLI argument small (Windows command lines are limited to ~32k chars).
  return json.length > 4000 ? 'gz1:' + gzipSync(Buffer.from(json)).toString('base64') : json
}

export function decodePayload(s: string | undefined): SyncPayload {
  if (!s) return { v: 1, at: 0, hosts: [], deleted: {}, snippets: [], snippetsDeleted: {} }
  const json = s.startsWith('gz1:') ? gunzipSync(Buffer.from(s.slice(4), 'base64')).toString('utf8') : s
  const raw = JSON.parse(json) as Partial<SyncPayload>
  const hosts: Host[] = []
  for (const h of raw.hosts ?? []) {
    try {
      hosts.push(sanitizeHost(h))
    } catch {
      /* skip invalid */
    }
  }
  return {
    v: 1,
    at: Number(raw.at) || 0,
    hosts,
    deleted: raw.deleted && typeof raw.deleted === 'object' ? raw.deleted : {},
    snippets: sanitizeSnippets(raw.snippets),
    snippetsDeleted: raw.snippetsDeleted && typeof raw.snippetsDeleted === 'object' ? raw.snippetsDeleted : {}
  }
}

export function sanitizeSnippets(list: unknown): Snippet[] {
  const out: Snippet[] = []
  for (const s of Array.isArray(list) ? list : []) {
    try {
      out.push(sanitizeSnippet(s as Snippet))
    } catch {
      /* skip invalid */
    }
  }
  return out
}

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

function fingerprintOf(s: { hosts: Host[]; deleted: Record<string, number> }): string {
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

export async function syncHosts(pp: ProtonPass, hosts: HostStore, settings: SettingsStore, snippets?: SnippetStore): Promise<SyncResult> {
  const s = settings.get().sync
  const at = Date.now()
  if (!s.shareId) return { ok: false, message: 'Choose a Proton Pass vault for sync first', pulled: 0, pushed: 0, at }
  try {
    let itemId = s.itemId
    let raw: string | undefined
    if (itemId) {
      try {
        raw = await pp.readField(s.shareId, itemId, SYNC_FIELD)
      } catch {
        itemId = '' // item was deleted or moved: look it up again
      }
    }
    if (!itemId) {
      itemId = (await pp.findNote(s.shareId, SYNC_NOTE_TITLE)) ?? ''
      if (itemId) raw = await pp.readField(s.shareId, itemId, SYNC_FIELD)
    }
    if (!itemId) {
      itemId = await pp.createNote(
        s.shareId,
        SYNC_NOTE_TITLE,
        'Managed by SSHBuddy. Contains your SSH host list (no passwords or keys). Do not edit by hand.'
      )
    }

    const remote = decodePayload(raw)
    const local = { hosts: hosts.list(), deleted: hosts.tombstones() }
    const merged = mergeHosts(local, remote, at)
    const pulled = countDiff(local, merged)
    const pushed = countDiff(remote, merged)
    const localSnips = { items: snippets?.list() ?? [], deleted: snippets?.tombstones() ?? {} }
    const snips = mergeRecords(localSnips, { items: remote.snippets, deleted: remote.snippetsDeleted }, at)
    const snipsChangedRemote = recordsFingerprint(snips.items, snips.deleted) !== recordsFingerprint(remote.snippets, remote.snippetsDeleted)

    if (fingerprintOf(merged) !== fingerprintOf(remote) || (snippets && snipsChangedRemote) || !raw) {
      const payload: SyncPayload = { v: 1, at, ...merged, snippets: snippets ? snips.items : remote.snippets, snippetsDeleted: snippets ? snips.deleted : remote.snippetsDeleted }
      await pp.writeField(s.shareId, itemId, SYNC_FIELD, encodePayload(payload))
    }
    if (fingerprintOf(merged) !== fingerprintOf(local)) {
      await hosts.replaceAll(merged.hosts, merged.deleted)
    }
    if (snippets && recordsFingerprint(snips.items, snips.deleted) !== recordsFingerprint(localSnips.items, localSnips.deleted)) {
      await snippets.replaceAll(snips.items, snips.deleted)
    }
    await settings.update({ sync: { ...s, itemId, lastSyncAt: at, lastError: '' } })
    return { ok: true, message: `Synced ${merged.hosts.length} hosts, ${snips.items.length} snippets`, pulled, pushed, at }
  } catch (e) {
    const message = (e as Error).message
    await settings.update({ sync: { ...s, lastError: message } })
    return { ok: false, message, pulled: 0, pushed: 0, at }
  }
}
