// The encrypted sync file, platform-independent: file format, payload and the merge algorithm.
// Desktop (Node crypto, files) and Android (WebCrypto + native scrypt, document provider) supply a
// codec and stores; the merge rules live here once so both sides behave identically.
import type { Host, SecretKind, Snippet } from './types'
import { sanitizeHost } from './hostModel'
import { sanitizeSnippet } from './snippetModel'
import { countDiff, mergeHosts, mergeRecords } from './merge'

export const VAULT_FORMAT = 'sshbar-vault'
/** Files written before the app was renamed from SSHBuddy still open (and are rewritten in the new format). */
export const LEGACY_FORMATS = ['sshbuddy-vault']

export interface KdfParams {
  name: 'scrypt'
  N: number
  r: number
  p: number
  salt: string
}

export interface VaultEnvelope {
  format: string
  version: 1
  kdf: KdfParams
  cipher: { name: 'aes-256-gcm'; iv: string }
  tag: string
  data: string
}

export type HostSecrets = Partial<Record<SecretKind, string>>

/** A Proton Pass item's secret, copied into the file for devices without the Proton Pass CLI (phones). */
export interface PassSecret {
  password?: string
  privateKey?: string
  passphrase?: string
}

export interface VaultPayload {
  v: 1
  at: number
  hosts: Host[]
  deleted: Record<string, number>
  /** hostId -> saved secrets (only when "include secrets" is on) */
  secrets: Record<string, HostSecrets>
  snippets: Snippet[]
  snippetsDeleted: Record<string, number>
  /** "shareId:itemId" -> secret, only when a desktop opted in to share Proton Pass secrets */
  passSecrets?: Record<string, PassSecret>
}

export class WrongPasswordError extends Error {
  constructor() {
    super('Wrong master password (or the sync file is damaged)')
  }
}

export const passRef = (shareId: string, itemId: string): string => `${shareId}:${itemId}`

export function toB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromB64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function newKdf(N = 2 ** 17): KdfParams {
  return { name: 'scrypt', N, r: 8, p: 1, salt: toB64(globalThis.crypto.getRandomValues(new Uint8Array(16))) }
}

export function checkKdf(kdf: KdfParams): void {
  if (kdf.name !== 'scrypt' || !Number.isInteger(kdf.N) || kdf.N < 2 ** 14 || kdf.N > 2 ** 22 || kdf.r < 1 || kdf.r > 32 || kdf.p < 1 || kdf.p > 16) {
    throw new Error('Unsupported key derivation parameters in the sync file')
  }
}

/** Additional authenticated data: binds the header (format, KDF, IV) to the ciphertext. */
export function aadString(e: Pick<VaultEnvelope, 'format' | 'version' | 'kdf' | 'cipher'>): string {
  return JSON.stringify([e.format, e.version, e.kdf, e.cipher])
}

export function parseEnvelope(text: string): VaultEnvelope {
  let e: VaultEnvelope
  try {
    e = JSON.parse(text) as VaultEnvelope
  } catch {
    throw new Error('This is not an SSHbar sync file (invalid JSON)')
  }
  if (e?.format !== VAULT_FORMAT && !LEGACY_FORMATS.includes(e?.format)) throw new Error('This is not an SSHbar sync file')
  if (e.version !== 1) throw new Error(`Unsupported sync file version ${String(e.version)} — update SSHbar`)
  if (e.cipher?.name !== 'aes-256-gcm' || !e.cipher.iv || !e.tag || typeof e.data !== 'string') throw new Error('The sync file is damaged')
  return e
}

export function normalizePayload(raw: Partial<VaultPayload>): VaultPayload {
  const hosts: Host[] = []
  for (const h of Array.isArray(raw.hosts) ? raw.hosts : []) {
    try {
      hosts.push(sanitizeHost(h))
    } catch {
      /* skip invalid entries */
    }
  }
  const snippets: Snippet[] = []
  for (const s of Array.isArray(raw.snippets) ? raw.snippets : []) {
    try {
      snippets.push(sanitizeSnippet(s))
    } catch {
      /* skip */
    }
  }
  const obj = <T>(v: unknown): T => (v && typeof v === 'object' ? (v as T) : ({} as T))
  return {
    v: 1,
    at: Number(raw.at) || 0,
    hosts,
    deleted: obj(raw.deleted),
    secrets: obj(raw.secrets),
    snippets,
    snippetsDeleted: obj(raw.snippetsDeleted),
    passSecrets: obj(raw.passSecrets)
  }
}

/** JSON.stringify with sorted keys, so equal data always compares equal. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

function contentKey(p: Partial<VaultPayload> & Pick<VaultPayload, 'hosts' | 'deleted' | 'secrets'>): string {
  const nonEmpty = <T extends object>(m: Record<string, T> | undefined) => Object.fromEntries(Object.entries(m ?? {}).filter(([, v]) => Object.keys(v).length))
  return canon({
    hosts: [...p.hosts].sort((a, b) => a.id.localeCompare(b.id)),
    deleted: p.deleted,
    secrets: nonEmpty(p.secrets),
    snippets: [...(p.snippets ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
    snippetsDeleted: p.snippetsDeleted ?? {},
    passSecrets: nonEmpty(p.passSecrets)
  })
}

// ---------------------------------------------------------------------------

export interface VaultCodec<K> {
  newKdf(): KdfParams
  /** derive (and cache) the key for these KDF parameters from the current master password */
  keyFor(kdf: KdfParams): Promise<K>
  encrypt(payload: VaultPayload, key: K, kdf: KdfParams): Promise<VaultEnvelope>
  /** throws WrongPasswordError when the key does not open the file */
  decrypt(env: VaultEnvelope, key: K): Promise<VaultPayload>
}

export interface VaultStores {
  hosts: { list(): Host[]; tombstones(): Record<string, number>; replaceAll(hosts: Host[], deleted: Record<string, number>): Promise<void> }
  snippets?: { list(): Snippet[]; tombstones(): Record<string, number>; replaceAll(items: Snippet[], deleted: Record<string, number>): Promise<void> }
  secrets: {
    getAll(hostId: string): Promise<HostSecrets>
    set(hostId: string, kind: SecretKind, value: string): Promise<void>
    remove(hostId: string, kind: SecretKind): Promise<void>
    removeHost(hostId: string): Promise<void>
    available(): Promise<boolean>
  }
  /**
   * Proton Pass copies. `collect` (desktop, opted in): fresh secrets for the hosts' Proton Pass
   * references, or null to remove all copies from the file. `apply` (phones): store what the file has.
   */
  passSecrets?: {
    collect?(hosts: Host[]): Promise<Record<string, PassSecret> | null>
    apply?(secrets: Record<string, PassSecret>): Promise<void>
  }
}

export interface VaultSyncResult {
  /** new file content to write, when anything changed (or the file is new / re-keyed) */
  write?: string
  /** the file content after this sync (written or unchanged), for change detection */
  text: string
  hostCount: number
  pulled: number
  pushed: number
}

const KINDS: SecretKind[] = ['password', 'key', 'passphrase']

/**
 * One sync round: decrypt the file, merge it with the local stores (per-record last-writer-wins,
 * deletions propagate, secrets follow the winning version of each host), apply the result locally
 * and produce the new file content.
 */
export async function syncVault<K>(opts: {
  text: string | undefined
  codec: VaultCodec<K>
  stores: VaultStores
  includeSecrets: boolean
  rekey?: { kdf: KdfParams; key: K }
  now?: number
}): Promise<VaultSyncResult> {
  const { codec, stores } = opts
  const at = opts.now ?? Date.now()
  let remote: VaultPayload = normalizePayload({})
  let kdf: KdfParams
  let key: K
  if (opts.text !== undefined) {
    const env = parseEnvelope(opts.text)
    checkKdf(env.kdf)
    key = await codec.keyFor(env.kdf)
    remote = normalizePayload(await codec.decrypt(env, key))
    kdf = env.kdf
  } else {
    kdf = codec.newKdf()
    key = await codec.keyFor(kdf)
  }

  const include = opts.includeSecrets
  const localHosts = stores.hosts.list()
  const local = { hosts: localHosts, deleted: stores.hosts.tombstones() }
  const mine: Record<string, HostSecrets> = {}
  if (include) {
    for (const h of localHosts) {
      const s = await stores.secrets.getAll(h.id)
      if (Object.keys(s).length) mine[h.id] = s
    }
  }
  const merged = mergeHosts(local, remote, at)
  const snipStore = stores.snippets
  const localSnips = { items: snipStore?.list() ?? [], deleted: snipStore?.tombstones() ?? {} }
  const snips = snipStore ? mergeRecords(localSnips, { items: remote.snippets, deleted: remote.snippetsDeleted }, at) : { items: remote.snippets, deleted: remote.snippetsDeleted }

  // secrets follow the winning version of each host; on a tie (same version) keep the union
  const localById = new Map(localHosts.map((h) => [h.id, h]))
  const remoteById = new Map(remote.hosts.map((h) => [h.id, h]))
  const secrets: Record<string, HostSecrets> = {}
  for (const h of merged.hosts) {
    const l = localById.get(h.id)?.updatedAt
    const r = remoteById.get(h.id)?.updatedAt
    let chosen: HostSecrets
    if (!include) chosen = remote.secrets[h.id] ?? {}
    else if (l !== undefined && r !== undefined && l === r) chosen = { ...(remote.secrets[h.id] ?? {}), ...(mine[h.id] ?? {}) }
    else if (l === h.updatedAt) chosen = mine[h.id] ?? {}
    else chosen = remote.secrets[h.id] ?? {}
    if (Object.keys(chosen).length) secrets[h.id] = chosen
  }

  // Proton Pass copies: a desktop that shares them refreshes the map, everyone else passes it on
  const remotePass = remote.passSecrets ?? {}
  let passSecrets = remotePass
  if (stores.passSecrets?.collect) {
    const fresh = await stores.passSecrets.collect(merged.hosts)
    passSecrets = fresh === null ? {} : { ...remotePass, ...fresh }
    if (fresh !== null) {
      // drop copies no host refers to any more
      const used = new Set(fresh ? Object.keys(fresh) : [])
      for (const h of merged.hosts) for (const ref of passRefsOf(h)) used.add(ref)
      passSecrets = Object.fromEntries(Object.entries(passSecrets).filter(([ref]) => used.has(ref)))
    }
  }

  // apply locally
  const sameHosts = contentKey({ hosts: merged.hosts, deleted: merged.deleted, secrets: {} }) === contentKey({ hosts: local.hosts, deleted: local.deleted, secrets: {} })
  if (!sameHosts) await stores.hosts.replaceAll(merged.hosts, merged.deleted)
  if (snipStore && canon([snips.items.map((s) => `${s.id}@${s.updatedAt}`).sort(), Object.keys(snips.deleted).sort()]) !== canon([localSnips.items.map((s) => `${s.id}@${s.updatedAt}`).sort(), Object.keys(localSnips.deleted).sort()])) {
    await snipStore.replaceAll(snips.items, snips.deleted)
  }
  const mergedIds = new Set(merged.hosts.map((h) => h.id))
  for (const id of localById.keys()) if (!mergedIds.has(id)) await stores.secrets.removeHost(id)
  if (include && (await stores.secrets.available())) {
    for (const h of merged.hosts) {
      const want = secrets[h.id] ?? {}
      const have = mine[h.id] ?? {}
      for (const k of KINDS) {
        if (want[k] === have[k]) continue
        if (want[k]) await stores.secrets.set(h.id, k, want[k]!)
        else await stores.secrets.remove(h.id, k)
      }
    }
  }
  if (stores.passSecrets?.apply) await stores.passSecrets.apply(passSecrets)

  const payload: VaultPayload = { v: 1, at, hosts: merged.hosts, deleted: merged.deleted, secrets, snippets: snips.items, snippetsDeleted: snips.deleted, passSecrets }
  const result: VaultSyncResult = {
    text: opts.text ?? '',
    hostCount: merged.hosts.length,
    pulled: countDiff(local, merged),
    pushed: countDiff(remote, merged)
  }
  if (opts.text === undefined || opts.rekey || contentKey(payload) !== contentKey(remote)) {
    const env = await codec.encrypt(payload, opts.rekey?.key ?? key, opts.rekey?.kdf ?? kdf)
    result.write = JSON.stringify(env, null, 2)
    result.text = result.write
  }
  return result
}

/** The Proton Pass items a host refers to. */
export function passRefsOf(h: Host): string[] {
  const refs: string[] = []
  const a = h.auth
  if (a.method === 'password' && a.password.source === 'protonpass') refs.push(passRef(a.password.shareId, a.password.itemId))
  if (a.method === 'key' && a.key.source === 'protonpass') refs.push(passRef(a.key.shareId, a.key.itemId))
  if (a.method === 'key' && a.passphrase.source === 'protonpass') refs.push(passRef(a.passphrase.shareId, a.passphrase.itemId))
  return refs
}
