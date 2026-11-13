import { gunzipSync, gzipSync } from 'node:zlib'
import type { Host, Snippet, SyncResult } from '../shared/types'
import type { HostStore } from './store/hosts'
import { sanitizeHost } from './store/hosts'
import { sanitizeSnippet, type SnippetStore } from './store/snippets'
import type { SettingsStore } from './store/settings'
import type { ProtonPass } from './protonpass'
import { countDiff, fingerprintOf, mergeHosts, mergeRecords, recordsFingerprint } from '../shared/merge'

export { countDiff, mergeHosts, mergeRecords, recordsFingerprint }

/**
 * Host sync through Proton Pass: the host list (no secrets — only references to Proton Pass
 * items, key file paths and "saved on this device" markers) is stored end-to-end encrypted in a
 * Proton Pass note item, in a custom field. Every device merges by last-writer-wins per host.
 */

export const SYNC_NOTE_TITLE = 'SSHbar Sync'
export const SYNC_FIELD = 'sshbar_hosts'

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
        'Managed by SSHbar. Contains your SSH host list (no passwords or keys). Do not edit by hand.'
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
