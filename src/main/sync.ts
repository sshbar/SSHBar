import { gunzipSync, gzipSync } from 'node:zlib'
import type { Host, SyncResult } from '../shared/types'
import type { HostStore } from './store/hosts'
import { sanitizeHost } from './store/hosts'
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
}

export function encodePayload(p: SyncPayload): string {
  const json = JSON.stringify(p)
  // Keep the CLI argument small (Windows command lines are limited to ~32k chars).
  return json.length > 4000 ? 'gz1:' + gzipSync(Buffer.from(json)).toString('base64') : json
}

export function decodePayload(s: string | undefined): SyncPayload {
  if (!s) return { v: 1, at: 0, hosts: [], deleted: {} }
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
  return { v: 1, at: Number(raw.at) || 0, hosts, deleted: raw.deleted && typeof raw.deleted === 'object' ? raw.deleted : {} }
}

export function mergeHosts(
  a: { hosts: Host[]; deleted: Record<string, number> },
  b: { hosts: Host[]; deleted: Record<string, number> },
  now = Date.now()
): { hosts: Host[]; deleted: Record<string, number> } {
  const deleted: Record<string, number> = {}
  for (const src of [a.deleted, b.deleted]) {
    for (const [id, at] of Object.entries(src)) {
      if (typeof at === 'number' && now - at < TOMBSTONE_TTL_MS) deleted[id] = Math.max(deleted[id] ?? 0, at)
    }
  }
  const byId = new Map<string, Host>()
  for (const h of [...a.hosts, ...b.hosts]) {
    const cur = byId.get(h.id)
    if (!cur || h.updatedAt > cur.updatedAt) byId.set(h.id, h)
  }
  const hosts: Host[] = []
  for (const h of byId.values()) {
    const del = deleted[h.id]
    if (del !== undefined && del >= h.updatedAt) continue
    if (del !== undefined) delete deleted[h.id]
    hosts.push(h)
  }
  hosts.sort((x, y) => x.createdAt - y.createdAt)
  return { hosts, deleted }
}

function fingerprintOf(s: { hosts: Host[]; deleted: Record<string, number> }): string {
  const hosts = [...s.hosts].sort((x, y) => x.id.localeCompare(y.id)).map((h) => `${h.id}@${h.updatedAt}`)
  const del = Object.keys(s.deleted).sort()
  return JSON.stringify([hosts, del])
}

function countDiff(from: { hosts: Host[] }, to: { hosts: Host[] }): number {
  const fromMap = new Map(from.hosts.map((h) => [h.id, h.updatedAt]))
  const toIds = new Set(to.hosts.map((h) => h.id))
  let n = 0
  for (const h of to.hosts) if (fromMap.get(h.id) !== h.updatedAt) n++
  for (const id of fromMap.keys()) if (!toIds.has(id)) n++
  return n
}

export async function syncHosts(pp: ProtonPass, hosts: HostStore, settings: SettingsStore): Promise<SyncResult> {
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

    if (fingerprintOf(merged) !== fingerprintOf(remote) || !raw) {
      await pp.writeField(s.shareId, itemId, SYNC_FIELD, encodePayload({ v: 1, at, ...merged }))
    }
    if (fingerprintOf(merged) !== fingerprintOf(local)) {
      await hosts.replaceAll(merged.hosts, merged.deleted)
    }
    await settings.update({ sync: { ...s, itemId, lastSyncAt: at, lastError: '' } })
    return { ok: true, message: `Synced ${merged.hosts.length} hosts`, pulled, pushed, at }
  } catch (e) {
    const message = (e as Error).message
    await settings.update({ sync: { ...s, lastError: message } })
    return { ok: false, message, pulled: 0, pushed: 0, at }
  }
}
