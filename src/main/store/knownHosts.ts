import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KnownHostEntry } from '../../shared/types'
import { readJsonSync, writeJson } from './jsonFile'

/** OpenSSH-style host key name: `host` for port 22, `[host]:port` otherwise. */
export function hostKeyName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`
}

export function fingerprint(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

/** Read the algorithm name (e.g. "ssh-ed25519") from an SSH wire-format public key blob. */
export function keyTypeOf(key: Buffer): string {
  try {
    const len = key.readUInt32BE(0)
    if (len > 0 && len < 64 && key.length >= 4 + len) return key.subarray(4, 4 + len).toString('ascii')
  } catch {
    /* ignore */
  }
  return 'unknown'
}

export type HostKeyCheck = { state: 'trusted' } | { state: 'unknown' } | { state: 'changed'; known: string[] }

interface Line {
  marker: string
  patterns: string
  keyType: string
  key: string
}

function parseKnownHostsText(text: string): Line[] {
  const out: Line[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    let marker = ''
    if (parts[0]?.startsWith('@')) marker = parts.shift() ?? ''
    if (parts.length < 3) continue
    out.push({ marker, patterns: parts[0], keyType: parts[1], key: parts[2] })
  }
  return out
}

function globToRegex(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${esc}$`, 'i')
}

/** Does an OpenSSH known_hosts host-pattern field match `name` (already in `[host]:port` form)? */
export function patternsMatch(patterns: string, name: string): boolean {
  if (patterns.startsWith('|1|')) {
    const [, , salt, hash] = patterns.split('|')
    if (!salt || !hash) return false
    const h = createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64')
    return h === hash
  }
  let matched = false
  for (const p of patterns.split(',')) {
    if (p.startsWith('!')) {
      if (globToRegex(p.slice(1)).test(name)) return false
    } else if (globToRegex(p).test(name)) {
      matched = true
    }
  }
  return matched
}

/** Check a host key against OpenSSH known_hosts text. Read-only; we never modify the user's file. */
export function checkAgainstKnownHostsText(text: string, name: string, keyType: string, keyB64: string): HostKeyCheck {
  const known: string[] = []
  let trusted = false
  for (const l of parseKnownHostsText(text)) {
    if (l.marker === '@cert-authority') continue
    if (!patternsMatch(l.patterns, name)) continue
    if (l.marker === '@revoked') {
      if (l.key === keyB64) return { state: 'changed', known: [] }
      continue
    }
    if (l.keyType !== keyType) continue
    if (l.key === keyB64) trusted = true
    else known.push(fingerprint(Buffer.from(l.key, 'base64')))
  }
  if (trusted) return { state: 'trusted' }
  if (known.length) return { state: 'changed', known }
  return { state: 'unknown' }
}

interface StoreFile {
  version: 1
  /** hostKeyName -> entries */
  hosts: Record<string, { keyType: string; key: string; addedAt: number }[]>
}

/**
 * Trust-on-first-use host key store. Keys accepted in SSHbar live in its own file;
 * the user's ~/.ssh/known_hosts is consulted read-only so already-trusted hosts
 * don't prompt again.
 */
export class KnownHostsStore {
  private file: string
  private data: StoreFile

  constructor(
    dir: string,
    private systemKnownHostsFiles: string[]
  ) {
    this.file = join(dir, 'known_hosts.json')
    this.data = { version: 1, hosts: readJsonSync<StoreFile>(this.file, { version: 1, hosts: {} }).hosts ?? {} }
  }

  check(host: string, port: number, key: Buffer): HostKeyCheck {
    const name = hostKeyName(host, port)
    const keyType = keyTypeOf(key)
    const keyB64 = key.toString('base64')

    const own = this.data.hosts[name] ?? []
    const ownSameType = own.filter((e) => e.keyType === keyType)
    if (ownSameType.some((e) => e.key === keyB64)) return { state: 'trusted' }

    for (const f of this.systemKnownHostsFiles) {
      let text: string
      try {
        text = readFileSync(f, 'utf8')
      } catch {
        continue
      }
      const res = checkAgainstKnownHostsText(text, name, keyType, keyB64)
      if (res.state === 'trusted' && ownSameType.length === 0) return res
      if (res.state === 'changed') return res
    }

    if (ownSameType.length) {
      return { state: 'changed', known: ownSameType.map((e) => fingerprint(Buffer.from(e.key, 'base64'))) }
    }
    return { state: 'unknown' }
  }

  async trust(host: string, port: number, key: Buffer): Promise<void> {
    const name = hostKeyName(host, port)
    const keyType = keyTypeOf(key)
    const others = (this.data.hosts[name] ?? []).filter((e) => e.keyType !== keyType)
    this.data.hosts[name] = [...others, { keyType, key: key.toString('base64'), addedAt: Date.now() }]
    await writeJson(this.file, this.data)
  }

  list(): KnownHostEntry[] {
    const out: KnownHostEntry[] = []
    for (const [hostKey, entries] of Object.entries(this.data.hosts)) {
      for (const e of entries) {
        out.push({ hostKey, keyType: e.keyType, fingerprint: fingerprint(Buffer.from(e.key, 'base64')), addedAt: e.addedAt })
      }
    }
    return out.sort((a, b) => a.hostKey.localeCompare(b.hostKey))
  }

  async remove(hostKey: string): Promise<void> {
    delete this.data.hosts[hostKey]
    await writeJson(this.file, this.data)
  }
}
